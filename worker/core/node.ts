import { Hono } from 'hono'
import { Cron } from 'croner'
import { nodeErr, nodeOk, type Bindings, type Job, type Env } from './envelope'
import { runBuiltinTasks, reminderScan } from './tick'
import { getConfig } from './config'
import { ingest } from './ingest'
import { resolveNodeId } from './nodekey'

// /node/* 协议（v4.9：领 1 + 捎带下发；tick 锁只护内置任务；时间权威在 Worker）
// v4.12：节点身份由密钥反查（node_registry），agent 不再上报 nodeId

const LEASE_MS = 10 * 60_000
const TICK_WINDOW_MS = 10 * 60_000
const TZ = 'Asia/Shanghai' // Worker 运行在 UTC，cron 解析显式指定

export const node = new Hono<Env>()

/** 节点鉴权（所有 /node/* 端点）：x-node-key → node_registry.node_id，后续一律信任这里的身份 */
node.use('*', async (c, next) => {
  const nodeId = await resolveNodeId(c.env, c.req.header('x-node-key'))
  if (!nodeId) return nodeErr(401, 'unauthorized')
  c.set('node', nodeId)
  await next()
})

/** 领取管线（v4.9）：回收 + 领 1；幂等不加锁，可挂到任何交互末尾 */
async function claimPipeline(env: Bindings, nodeId: string, now: number): Promise<Job[]> {
  const db = env.DB
  await db
    .prepare(
      `UPDATE job SET status = 'pending', lease_until = NULL, node_id = NULL
       WHERE status = 'leased' AND lease_until < ?`,
    )
    .bind(now)
    .run()

  const claim = await db
    .prepare(
      `UPDATE job SET status = 'leased', lease_until = ?, node_id = ?, started_at = ?
       WHERE id = (SELECT id FROM job WHERE status = 'pending' AND next_run_at <= ? AND enabled = 1
                   ORDER BY next_run_at LIMIT 1)
       RETURNING id, type, payload`,
    )
    .bind(now + LEASE_MS, nodeId, now, now)
    .all<{ id: number; type: string; payload: string | null }>()

  const row = claim.results[0]
  if (!row) return []

  const payload = row.payload ? (JSON.parse(row.payload) as Record<string, unknown>) : {}
  // 密钥不进 agent 环境变量：第三方 token 存 D1（app_config），下发这一刻注入 payload
  if (row.type === 'zsxq_sync') {
    const token = await getConfig(env, 'zsxq_token')
    if (token) payload.token = token
  }
  return [{ id: row.id, type: row.type, payload }]
}

/** ① upsert node_state 心跳（每次 poll 必做，含被限频的重复 poll） */
async function registerNode(db: D1Database, nodeId: string, agentVersion: string, now: number) {
  await db
    .prepare(
      `INSERT INTO node_state (node_id, agent_version, last_seen_at) VALUES (?, ?, ?)
       ON CONFLICT (node_id) DO UPDATE SET agent_version = excluded.agent_version, last_seen_at = excluded.last_seen_at`,
    )
    .bind(nodeId, agentVersion, now)
    .run()
}

node.post('/poll', async (c) => {
  const now = Date.now()
  const db = c.env.DB
  const body = await c.req
    .json<{ agentVersion?: string }>()
    .catch(() => ({}) as { agentVersion?: string })
  const nodeId = c.get('node')

  await registerNode(db, nodeId, body.agentVersion ?? '?', now)

  // ② tick 限频锁（条件更新，窗口 10min）：赢锁才执行内置任务（reminder_scan / 过期清理）
  const tick = await db
    .prepare('UPDATE tick_state SET last_tick_at = ? WHERE id = 1 AND last_tick_at < ?')
    .bind(now, now - TICK_WINDOW_MS)
    .run()
  if (tick.meta.changes === 1) {
    await runBuiltinTasks(db, now)
    await reminderScan(db, c.env, now)
  }

  const jobs = await claimPipeline(c.env, nodeId, now)
  return nodeOk({ jobs })
})

node.post('/jobs/:id/heartbeat', async (c) => {
  const now = Date.now()
  const db = c.env.DB
  const id = Number(c.req.param('id'))
  const nodeId = c.get('node')

  const res = await db
    .prepare(`UPDATE job SET lease_until = ? WHERE id = ? AND status = 'leased' AND node_id = ?`)
    .bind(now + LEASE_MS, id, nodeId)
    .run()
  if (res.meta.changes === 0) return nodeErr(409, 'lease lost')

  const jobs = await claimPipeline(c.env, nodeId, now)
  return nodeOk({ jobs })
})

node.post('/jobs/:id/results', async (c) => {
  const now = Date.now()
  const db = c.env.DB
  const id = Number(c.req.param('id'))
  const body = await c.req
    .json<{ items?: unknown[] }>()
    .catch(() => ({}) as { items?: unknown[] })
  const nodeId = c.get('node')

  // 按任务类型 ingest（幂等靠业务表唯一约束）；unknown type → 400（agent 会 fail 上报）
  const job = await db.prepare('SELECT type, payload FROM job WHERE id = ?').bind(id).first<{
    type: string
    payload: string | null
  }>()
  if (!job) return nodeErr(409, 'lease lost')
  const payload = job.payload ? (JSON.parse(job.payload) as Record<string, unknown>) : {}
  const inserted = await ingest(db, job.type, payload, body.items ?? [], now)
  if (inserted === null) return nodeErr(400, `no ingest for type: ${job.type}`)

  const jobs = await claimPipeline(c.env, nodeId, now)
  return nodeOk({ jobs, accepted: body.items?.length ?? 0, inserted })
})

node.post('/jobs/:id/complete', async (c) => {
  const now = Date.now()
  const db = c.env.DB
  const id = Number(c.req.param('id'))
  const { summary, agentVersion } = await c.req.json<{ summary?: string; agentVersion?: string }>()
  const nodeId = c.get('node')

  const job = await db
    .prepare('SELECT cron, started_at FROM job WHERE id = ?')
    .bind(id)
    .first<{ cron: string | null; started_at: number | null }>()
  if (!job) return nodeErr(409, 'lease lost')
  let nextRunAt: number | null = null
  if (job.cron) {
    const n = new Cron(job.cron, { timezone: TZ }).nextRun()
    nextRunAt = n ? n.getTime() : null
  }
  // 无 cron = 一次性任务：完成后置 done（next_run_at 不推进，回 pending 会被立刻重复领取）
  const nextStatus = job.cron ? 'pending' : 'done'

  const res = await db
    .prepare(
      `UPDATE job SET status = ?, result = ?, last_run_at = ?, attempts = 0,
       next_run_at = COALESCE(?, next_run_at), lease_until = NULL
       WHERE id = ? AND status = 'leased' AND node_id = ?`,
    )
    .bind(nextStatus, summary ?? null, now, nextRunAt, id, nodeId)
    .run()
  if (res.meta.changes === 0) return nodeErr(409, 'lease lost') // 所有权校验：被回收/易主

  await db
    .prepare(
      `INSERT INTO job_run (job_id, ok, message, ms, run_at, node_id, agent_version)
       VALUES (?, 1, ?, ?, ?, ?, ?)`,
    )
    .bind(id, summary ?? null, job.started_at ? now - job.started_at : null, now, nodeId, agentVersion ?? '?')
    .run()

  const jobs = await claimPipeline(c.env, nodeId, now)
  return nodeOk({ jobs })
})

node.post('/jobs/:id/fail', async (c) => {
  const now = Date.now()
  const db = c.env.DB
  const id = Number(c.req.param('id'))
  const { error, agentVersion } = await c.req.json<{ error?: string; agentVersion?: string }>()
  const nodeId = c.get('node')

  const row = await db.prepare('SELECT attempts, started_at FROM job WHERE id = ?').bind(id).first<{
    attempts: number
    started_at: number | null
  }>()
  const attempts = (row?.attempts ?? 0) + 1

  if (attempts < 3) {
    const res = await db
      .prepare(`UPDATE job SET status = 'pending', attempts = ?, next_run_at = ?, lease_until = NULL, result = ?
                WHERE id = ? AND status = 'leased' AND node_id = ?`)
      .bind(attempts, now + 5 * 60_000 * attempts, error ?? null, id, nodeId)
      .run()
    if (res.meta.changes === 0) return nodeErr(409, 'lease lost') // 所有权校验
  } else {
    const res = await db
      .prepare(`UPDATE job SET status = 'failed', attempts = ?, result = ?, lease_until = NULL
                WHERE id = ? AND status = 'leased' AND node_id = ?`)
      .bind(attempts, error ?? null, id, nodeId)
      .run()
    if (res.meta.changes === 0) return nodeErr(409, 'lease lost') // 所有权校验
  }

  await db
    .prepare(
      `INSERT INTO job_run (job_id, ok, message, ms, run_at, node_id, agent_version)
       VALUES (?, 0, ?, ?, ?, ?, ?)`,
    )
    .bind(id, error ?? null, row?.started_at ? now - row.started_at : null, now, nodeId, agentVersion ?? '?')
    .run()

  const jobs = await claimPipeline(c.env, nodeId, now)
  return nodeOk({ jobs })
})
