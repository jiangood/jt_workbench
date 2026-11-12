import { Hono } from 'hono'
import { Cron } from 'croner'
import { ApiError, nodeErr, nodeOk, type Bindings, type Job, type Env } from './envelope'
import { runBuiltinTasks, reminderScan } from './tick'
import { getConfig } from './config'
import { ingest } from './ingest'
import { resolveNodeId } from './nodekey'

// /node/* 协议（v4.9：领 1 + 捎带下发；tick 锁只护内置任务；时间权威在 Worker）
// v4.12：节点身份由密钥反查（node_registry），agent 不再上报 nodeId

const LEASE_MS = 10 * 60_000
const TICK_WINDOW_MS = 10 * 60_000
const MAX_ATTEMPTS = 3 // 单次触发最多重试 3 次（周期任务失败后按 cron 续排，不死）
const MAX_FAIL_STREAK = 3 // 连续 N 个周期都失败 → 熔断暂停（enabled=0），等人工重新启用
const TZ = 'Asia/Shanghai' // Worker 运行在 UTC，cron 解析显式指定

export const node = new Hono<Env>()

// cron 归一化：Quartz 风格 → 标准 5 段（分 时 日 月 周）。
//
// 为什么必须归一化（issue #16）：croner 8 对 `?` 的处理是「替换成解析这一刻的日期分量」——
// `0 0 */2 * * ?` 里的 `?` 在周位会被换成当天星期几（源码：parts[5].replace('?', initDate.getDay())），
// 于是「每 2 小时」变成「每周某天 0/2/4…22 点」，线上 next_run_at 被排到 5 天后。
// 统一成 5 段并把 `?` 视为 `*`，语义与 Quartz 的「不指定」一致。
// 非法表达式直接 400（创建任务时就用它校验，避免脏值入库）。
export function normalizeCron(expr: string): string {
  const raw = String(expr ?? '').trim().replace(/\s+/g, ' ')
  if (!raw) throw new ApiError(400, 400, 'cron 不能为空')

  let parts = raw.split(' ')
  if (parts.length === 6) {
    // Quartz 6 段 = 秒 分 时 日 月 周；标准 cron 没有秒位，秒位只能是 0/*（否则无法等价表达）
    const [sec, ...rest] = parts
    if (sec !== '0' && sec !== '*' && sec !== '*/1') {
      throw new ApiError(400, 400, `不支持秒级 cron（秒位只能是 0）：${raw}`)
    }
    parts = rest
  }
  if (parts.length !== 5) throw new ApiError(400, 400, `cron 必须是 5 段（分 时 日 月 周）：${raw}`)

  const normalized = parts.map((p) => p.replace(/\?/g, '*')).join(' ')
  try {
    // paused: true —— 只借 croner 做语法校验与计算，不挂调度器
    if (!new Cron(normalized, { timezone: TZ, paused: true }).nextRun(new Date())) {
      throw new Error('no next run')
    }
  } catch {
    throw new ApiError(400, 400, `cron 表达式无效：${raw}`)
  }
  return normalized
}

/** cron 下一次触发时刻（解析失败兜底 30 分钟后，避免任务永远停在原地） */
function nextCronRun(cron: string, from: number): number {
  try {
    const next = new Cron(normalizeCron(cron), { timezone: TZ, paused: true }).nextRun(new Date(from))
    return next?.getTime() ?? from + 30 * 60_000
  } catch {
    return from + 30 * 60_000
  }
}

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
  if (row.type === 'zsxq_sync' || row.type === 'zsxq_groups') {
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
  // v5.1：带回最新 agent 版本（发布流水线写入 app_config）；agent 空闲且落后 → 触发 Watchtower 即时升级
  const agentLatestVersion = await getConfig(c.env, 'agent_latest_version')
  return nodeOk({ jobs, agentLatestVersion })
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
  const nextRunAt = job.cron ? nextCronRun(job.cron, now) : null
  // 无 cron = 一次性任务：完成后置 done（next_run_at 不推进，回 pending 会被立刻重复领取）
  const nextStatus = job.cron ? 'pending' : 'done'

  const res = await db
    .prepare(
      `UPDATE job SET status = ?, result = ?, last_run_at = ?, attempts = 0, fail_streak = 0,
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

  const row = await db
    .prepare('SELECT attempts, started_at, cron, fail_streak AS failStreak FROM job WHERE id = ?')
    .bind(id)
    .first<{
      attempts: number
      started_at: number | null
      cron: string | null
      failStreak: number
    }>()
  const attempts = (row?.attempts ?? 0) + 1
  const lastError = (error ?? '').slice(0, 1000) || null

  if (attempts < MAX_ATTEMPTS) {
    const res = await db
      .prepare(`UPDATE job SET status = 'pending', attempts = ?, next_run_at = ?, lease_until = NULL, result = ?
                WHERE id = ? AND status = 'leased' AND node_id = ?`)
      .bind(attempts, now + 5 * 60_000 * attempts, lastError, id, nodeId)
      .run()
    if (res.meta.changes === 0) return nodeErr(409, 'lease lost') // 所有权校验
  } else if (row?.cron) {
    // 周期任务不允许死：3 次失败只代表本轮抓取失败，排到下次 cron 继续跑；
    // attempts 归零，让下一轮重新拿到完整的 3 次重试（否则只剩 1 次）。
    // fail_streak 按「轮」计（一轮 = 一次触发 + 最多 3 次重试），连续 3 轮失败才熔断，
    // 避免一次十几分钟的网络抖动就把源永久停掉。
    const failStreak = (row.failStreak ?? 0) + 1
    const paused = failStreak >= MAX_FAIL_STREAK
    const result = paused
      ? `连续 ${failStreak} 次失败已暂停：${lastError ?? '未知错误'}`.slice(0, 1000)
      : lastError
    const res = await db
      .prepare(
        paused
          ? `UPDATE job SET status = 'failed', enabled = 0, attempts = 0, fail_streak = ?,
             next_run_at = ?, lease_until = NULL, result = ?
             WHERE id = ? AND status = 'leased' AND node_id = ?`
          : `UPDATE job SET status = 'pending', attempts = 0, fail_streak = ?,
             next_run_at = ?, lease_until = NULL, result = ?
             WHERE id = ? AND status = 'leased' AND node_id = ?`,
      )
      .bind(failStreak, nextCronRun(row.cron, now), result, id, nodeId)
      .run()
    if (res.meta.changes === 0) return nodeErr(409, 'lease lost') // 所有权校验
  } else {
    const res = await db
      .prepare(`UPDATE job SET status = 'failed', attempts = ?, result = ?, lease_until = NULL
                WHERE id = ? AND status = 'leased' AND node_id = ?`)
      .bind(attempts, lastError, id, nodeId)
      .run()
    if (res.meta.changes === 0) return nodeErr(409, 'lease lost') // 所有权校验
  }

  await db
    .prepare(
      `INSERT INTO job_run (job_id, ok, message, ms, run_at, node_id, agent_version)
       VALUES (?, 0, ?, ?, ?, ?, ?)`,
    )
    .bind(id, lastError, row?.started_at ? now - row.started_at : null, now, nodeId, agentVersion ?? '?')
    .run()

  const jobs = await claimPipeline(c.env, nodeId, now)
  return nodeOk({ jobs })
})
