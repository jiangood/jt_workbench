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

// ---------- 跨节点调度（issue #4）----------
const ONLINE_MS = 30 * 60_000 // 与后台「在线」判定一致：3× poll 间隔
const CLAIM_CANDIDATES = 8 // 一次最多看 8 个到期任务：给「礼让最优节点」留余量
const SCORE_BASE = 50 // 没有评分记录的「目标 × 节点」按 50 分处理
const SCORE_SUCCESS = 5
const SCORE_NETWORK_FAIL = -30
const SCORE_MAX = 100
const SCORE_MIN = -1
const SCORE_COOLDOWN_MS = 5 * 60_000 // 网络类失败后该节点对该目标避让 5 分钟
const STARVE_MS = 15 * 60_000 // 到期超过 15 分钟还没人领 → 不再礼让，任何节点都能拿
/** 网络类错误兜底判定：老 agent 不传 errorKind 时靠错误原文兜底，只认明确的连接/超时类 */
const NETWORK_ERROR_RE =
  /(ETIMEDOUT|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|ECONNABORTED|EPIPE|EPROTO|UND_ERR_[A-Z_]+|socket hang up|fetch failed|getaddrinfo|timed out|timeout)/i

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

/**
 * 目标标识（issue #4）：RSS 任务按 URL 的域名归一化，同一站点的多个源共享一份评分。
 * 只对 rss_fetch 生效，其它任务返回 null（保持原有派单行为）。
 */
export function normalizeTargetKey(url: string): string | null {
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    const host = u.hostname.toLowerCase().replace(/^www\./, '')
    return host || null
  } catch {
    return null
  }
}

export function targetKeyOf(type: string, payload: Record<string, unknown>): string | null {
  if (type === 'rss_fetch') {
    return typeof payload.url === 'string' ? normalizeTargetKey(payload.url) : null
  }
  if (
    type === 'zsxq_sync' ||
    type === 'zsxq_backfill' ||
    type === 'zsxq_comments' ||
    type === 'zsxq_probe' ||
    type === 'zsxq_groups'
  ) {
    return 'api.zsxq.com'
  }
  return null
}

function parsePayload(raw: string | null): Record<string, unknown> {
  try {
    const v = JSON.parse(raw ?? '')
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** 单条「目标 × 节点」评分 */
interface ScoreCell {
  score: number
  cooldownUntil: number | null
}

/** 一次领取用到的调度上下文：在线节点 + 候选目标的评分 */
interface DispatchCtx {
  online: Set<string>
  scores: Map<string, ScoreCell> // key = `${target}\u0000${node}`
  now: number
}

const scoreKey = (target: string, nodeId: string) => `${target}\u0000${nodeId}`

// 新任务类型需要对应能力的 agent，避免旧节点领取后 unknown type 失败/卡住
const MIN_AGENT_VERSION_BY_TYPE: Record<string, string> = {
  zsxq_sync: '0.13.30',
  zsxq_backfill: '0.13.19',
  zsxq_comments: '0.13.19',
  zsxq_probe: '0.13.19',
}

function parseSemver(v: string): [number, number, number] | null {
  const m = String(v ?? '').trim().match(/^(\d+)\.(\d+)\.(\d+)/)
  if (!m) return null
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

function gteVersion(a: string, b: string): boolean {
  const pa = parseSemver(a)
  const pb = parseSemver(b)
  if (!pa || !pb) return false
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return true
    if (pa[i] < pb[i]) return false
  }
  return true
}

function supportsJobType(agentVersion: string | null | undefined, type: string): boolean {
  const min = MIN_AGENT_VERSION_BY_TYPE[type]
  if (!min) return true
  if (!agentVersion) return false
  return gteVersion(agentVersion, min)
}

/**
 * 在线节点 = 30 分钟内 poll 过的 + 正持有租约的。
 * 后者很关键：节点跑一个长任务时会停止 poll，只看 last_seen 会把它误判成离线，
 * 导致它的任务被「礼让」给别的节点（然后两边都没跑）。
 */
async function loadDispatchCtx(db: D1Database, targets: string[], now: number): Promise<DispatchCtx> {
  const online = new Set<string>()
  const scores = new Map<string, ScoreCell>()
  try {
    const [onlineRes, scoreRes] = await Promise.all([
      db
        .prepare(
          `SELECT node_id FROM node_state WHERE last_seen_at >= ?
           UNION
           SELECT node_id FROM job WHERE status = 'leased' AND lease_until > ? AND node_id IS NOT NULL`,
        )
        .bind(now - ONLINE_MS, now)
        .all<{ node_id: string }>(),
      db
        .prepare(
          `SELECT target_key AS targetKey, node_id AS nodeId, score, cooldown_until AS cooldownUntil
           FROM node_target_score WHERE target_key IN (${targets.map(() => '?').join(',')})`,
        )
        .bind(...targets)
        .all<{ targetKey: string; nodeId: string; score: number; cooldownUntil: number | null }>(),
    ])
    for (const r of onlineRes.results ?? []) online.add(r.node_id)
    for (const r of scoreRes.results ?? []) {
      scores.set(scoreKey(r.targetKey, r.nodeId), { score: r.score, cooldownUntil: r.cooldownUntil ?? null })
    }
  } catch {
    // 迁移未 apply / 查询失败：退化成「谁都能领」，不影响任务执行
    return { online: new Set(), scores: new Map(), now }
  }
  return { online, scores, now }
}

function scoreOf(ctx: DispatchCtx, target: string, nodeId: string): number {
  return ctx.scores.get(scoreKey(target, nodeId))?.score ?? SCORE_BASE
}

/**
 * 这个节点能不能领这条目标任务：
 * - 到期超过 STARVE_MS → 放行（最优节点忙碌/离线也不能把任务卡死）
 * - 没有任何可用在线节点（含「全在冷却」）→ 放行（单节点场景不阻塞）
 * - 本节点分 ≥ 在线节点最高分 → 放行；同分沿用先到先得的竞争机制
 * - 冷却中的节点不参与「最高分」计算：有其他节点就先避让
 */
function canTake(ctx: DispatchCtx, target: string, nodeId: string, nextRunAt: number | null): boolean {
  if (ctx.now - (nextRunAt ?? ctx.now) >= STARVE_MS) return true
  let best: number | null = null
  for (const node of ctx.online) {
    const cell = ctx.scores.get(scoreKey(target, node))
    if (cell?.cooldownUntil && cell.cooldownUntil > ctx.now) continue
    const score = cell?.score ?? SCORE_BASE
    if (best === null || score > best) best = score
  }
  if (best === null) return true
  return scoreOf(ctx, target, nodeId) >= best
}

/**
 * 评分写入（issue #4）：
 * - success：+5，上限 100，并清掉冷却
 * - network：-30，下限 -1，并把该节点对该目标冷却 5 分钟
 * 迁移未 apply / 写失败一律吞掉：调度优化不能影响任务本身。
 */
async function bumpScore(
  db: D1Database,
  targetKey: string | null,
  nodeId: string,
  kind: 'success' | 'network',
  now: number,
): Promise<void> {
  if (!targetKey) return
  try {
    if (kind === 'success') {
      await db
        .prepare(
          `INSERT INTO node_target_score (target_key, node_id, score, updated_at)
           VALUES (?, ?, min(?, ? + ?), ?)
           ON CONFLICT (target_key, node_id) DO UPDATE SET
             score = min(?, score + ?), cooldown_until = NULL, updated_at = excluded.updated_at`,
        )
        .bind(targetKey, nodeId, SCORE_MAX, SCORE_BASE, SCORE_SUCCESS, now, SCORE_MAX, SCORE_SUCCESS)
        .run()
    } else {
      await db
        .prepare(
          `INSERT INTO node_target_score (target_key, node_id, score, cooldown_until, updated_at)
           VALUES (?, ?, max(?, ? + ?), ?, ?)
           ON CONFLICT (target_key, node_id) DO UPDATE SET
             score = max(?, score + ?), cooldown_until = excluded.cooldown_until, updated_at = excluded.updated_at`,
        )
        .bind(
          targetKey,
          nodeId,
          SCORE_MIN,
          SCORE_BASE,
          SCORE_NETWORK_FAIL,
          now + SCORE_COOLDOWN_MS,
          now,
          SCORE_MIN,
          SCORE_NETWORK_FAIL,
        )
        .run()
    }
  } catch {
    /* 旧库没有评分表：忽略 */
  }
}

/**
 * 领取管线（v4.9）：回收 + 领 1；幂等不加锁，可挂到任何交互末尾。
 * v5.2（#4）：带 target_key 的任务先看「目标 × 节点」评分，低分节点礼让给高分节点。
 */
async function claimPipeline(env: Bindings, nodeId: string, now: number): Promise<Job[]> {
  const db = env.DB
  const staleBefore = now - 15 * 60_000
  await db
    .prepare(
      `UPDATE job SET status = 'pending', lease_until = NULL, node_id = NULL, started_at = NULL
       WHERE status = 'leased' AND (
         lease_until IS NULL
         OR lease_until < ?
         OR (next_run_at < ? AND COALESCE(started_at, next_run_at, 0) < ?)
         OR (next_run_at < ? AND COALESCE(last_run_at, 0) < ?)
         OR (enabled = 1 AND cron IS NOT NULL AND next_run_at < ?)
       )`,
    )
    .bind(now, staleBefore, staleBefore, staleBefore, staleBefore, staleBefore)
    .run()

  const nodeState = await db
    .prepare('SELECT agent_version AS agentVersion FROM node_state WHERE node_id = ?')
    .bind(nodeId)
    .first<{ agentVersion: string | null }>()
    .catch(() => null)
  const nodeVersion = nodeState?.agentVersion ?? null

  // 取一批到期候选而不是只取一条：最早那条可能要礼让给更高分的节点
  const candidates = await db
    .prepare(
      `SELECT id, type, payload, target_key AS targetKey, next_run_at AS nextRunAt
       FROM job WHERE status = 'pending' AND next_run_at <= ? AND enabled = 1
       ORDER BY next_run_at LIMIT ?`,
    )
    .bind(now, CLAIM_CANDIDATES)
    .all<{
      id: number
      type: string
      payload: string | null
      targetKey: string | null
      nextRunAt: number | null
    }>()

  const rows = candidates.results ?? []
  if (!rows.length) return []

  const planned = rows.map((row) => {
    const payload = parsePayload(row.payload)
    // 老任务（迁移前入库）没有 target_key：按 payload.url 现场推导，领取时顺手回填
    return { row, payload, target: row.targetKey ?? targetKeyOf(row.type, payload) }
  })
  const targets = [...new Set(planned.map((p) => p.target).filter((t): t is string => !!t))]
  // 没有目标任务时保持原来的查询量：不查节点与评分
  const ctx = targets.length ? await loadDispatchCtx(db, targets, now) : null

  for (const item of planned) {
    if (!supportsJobType(nodeVersion, item.row.type)) continue
    if (item.target && ctx && !canTake(ctx, item.target, nodeId, item.row.nextRunAt)) continue

    const claim = await db
      .prepare(
        `UPDATE job SET status = 'leased', lease_until = ?, node_id = ?, started_at = ?,
           target_key = COALESCE(target_key, ?)
         WHERE id = ? AND status = 'pending' AND enabled = 1
         RETURNING id, type, payload`,
      )
      .bind(now + LEASE_MS, nodeId, now, item.target, item.row.id)
      .all<{ id: number; type: string; payload: string | null }>()

    const row = claim.results?.[0]
    if (!row) continue // 被别的节点抢先 / 刚被禁用：看下一个候选

    const payload = item.payload
    // 密钥不进 agent 环境变量：第三方 token 存 D1（app_config），下发这一刻注入 payload
    if (
      row.type === 'zsxq_sync' ||
      row.type === 'zsxq_groups' ||
      row.type === 'zsxq_backfill' ||
      row.type === 'zsxq_comments' ||
      row.type === 'zsxq_probe'
    ) {
      const token = await getConfig(env, 'zsxq_token')
      if (token) payload.token = token
    }
    // 全量采集断点：把每个星球的回溯游标一并下发（agent 无状态，游标只存 D1）
    if (row.type === 'zsxq_sync') {
      const groupIds = payloadGroupIds(payload)
      payload.cursors = await zsxqCursors(db, groupIds)
      // 老帖评论对账 / 删除探测：按「最久没核对」轮转，保证列表页之外的历史帖子也能覆盖
      payload.refresh = await zsxqReconcileTargets(db, groupIds, 'comments_checked_at')
      payload.check = await zsxqReconcileTargets(db, groupIds, 'checked_at')
    }
    // 拆分后的阶段任务（方案 2+3）：按星球分片 + 各自队列/游标，互不挤占预算
    if (row.type === 'zsxq_backfill') {
      const groupIds = payloadGroupIds(payload)
      payload.groupIds = groupIds
      payload.cursors = await zsxqCursors(db, groupIds)
    }
    if (row.type === 'zsxq_comments') {
      const groupIds = payloadGroupIds(payload)
      payload.groupIds = groupIds
      payload.refresh = await zsxqReconcileTargets(db, groupIds, 'comments_checked_at')
    }
    if (row.type === 'zsxq_probe') {
      const groupIds = payloadGroupIds(payload)
      payload.groupIds = groupIds
      payload.check = await zsxqReconcileTargets(db, groupIds, 'checked_at')
    }
    return [{ id: row.id, type: row.type, payload }]
  }

  return []
}

/**
 * 读取 zsxq_sync_state，按 payload 里启用的星球拼成 { [groupId]: { cursor, done } }。
 * 表还没建（迁移未 apply）/ 查询失败一律当没有游标：agent 从头回溯，幂等入库，不影响领任务。
 */
async function zsxqCursors(
  db: D1Database,
  ids: string[],
): Promise<Record<string, { cursor: string | null; done: boolean }>> {
  if (!ids.length) return {}
  try {
    const placeholders = ids.map(() => '?').join(',')
    const res = await db
      .prepare(`SELECT group_id AS groupId, cursor, done FROM zsxq_sync_state WHERE group_id IN (${placeholders})`)
      .bind(...ids)
      .all<{ groupId: string; cursor: string | null; done: number }>()
    const out: Record<string, { cursor: string | null; done: boolean }> = {}
    for (const r of res.results ?? []) {
      out[r.groupId] = { cursor: r.cursor ?? null, done: r.done === 1 }
    }
    return out
  } catch {
    return {}
  }
}

/** payload 里启用的星球（新格式 groupIds，兼容旧的单 groupId） */
function payloadGroupIds(payload: Record<string, unknown>): string[] {
  const raw = Array.isArray(payload.groupIds) ? payload.groupIds : [payload.groupId]
  return raw.filter((id): id is string => typeof id === 'string' && id !== '')
}

/** 每个星球每轮下发多少条对账目标：按最久没核对轮转，量控制在 agent 单轮请求预算内 */
const ZSXQ_RECONCILE_LIMIT = 30

/** 回溯是否未完成：任一目标星球未 done 即视为仍需继续切片追赶 */
async function zsxqBackfillHasPending(db: D1Database, ids: string[]): Promise<boolean> {
  if (!ids.length) return false
  try {
    const placeholders = ids.map(() => '?').join(',')
    const res = await db
      .prepare(`SELECT group_id AS groupId, done FROM zsxq_sync_state WHERE group_id IN (${placeholders})`)
      .bind(...ids)
      .all<{ groupId: string; done: number }>()
    const done = new Set((res.results ?? []).filter((r) => r.done === 1).map((r) => r.groupId))
    return ids.some((id) => !done.has(id))
  } catch {
    // 表不存在/查询失败：保守按未完成处理，让 backfill 继续尝试
    return true
  }
}

/**
 * 对账队列：挑「最久没核对」的主题下发。
 * - comments_checked_at：评论会持续新增，列表页之外的老帖靠它定期补拉；
 * - checked_at：详情探测，接口查不到即判定主题被删除（连续两轮才落 deleted=1）。
 * 表 / 列还没建（迁移未 apply）或查询失败 → 空队列，不影响同步主流程。
 */
async function zsxqReconcileTargets(
  db: D1Database,
  ids: string[],
  column: 'comments_checked_at' | 'checked_at',
): Promise<Array<{ topicId: string; groupId: string }>> {
  if (!ids.length) return []
  try {
    const placeholders = ids.map(() => '?').join(',')
    const res = await db
      .prepare(
        `SELECT id AS topicId, group_id AS groupId FROM zsxq_topic
         WHERE group_id IN (${placeholders}) AND deleted = 0
           ${column === 'comments_checked_at' ? 'AND (comments_retry_at IS NULL OR comments_retry_at <= ?)' : ''}
         ORDER BY COALESCE(${column}, 0) ASC, create_time DESC
         LIMIT ?`,
      )
      .bind(...ids, ...(column === 'comments_checked_at' ? [Date.now()] : []), ZSXQ_RECONCILE_LIMIT)
      .all<{ topicId: string; groupId: string }>()
    return (res.results ?? []).filter((r) => r.topicId && r.groupId)
  } catch {
    return []
  }
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

interface PublishedAgentScript {
  id: string
  name: string
  version: string
  description: string
  schedule: string
  enabled: boolean
  timeout: number
  reliability: 'best_effort' | 'reliable'
  sha256: string
  contentPath: string
}

interface LocalAgentScript {
  id: string
  version: string
  sha256: string
}

async function readAgentScriptManifest(env: Bindings, requestUrl: string): Promise<PublishedAgentScript[]> {
  const url = new URL('/agent-scripts/manifest.json', requestUrl)
  const response = await env.ASSETS.fetch(new Request(url))
  if (!response.ok) throw new ApiError(503, 503, 'Agent script manifest unavailable')
  const raw = await response.json() as { schemaVersion?: unknown; scripts?: unknown }
  if (raw.schemaVersion !== 1 || !Array.isArray(raw.scripts) || raw.scripts.length > 100) {
    throw new ApiError(503, 503, 'Agent script manifest is invalid')
  }

  const ids = new Set<string>()
  const scripts: PublishedAgentScript[] = []
  for (const value of raw.scripts) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new ApiError(503, 503, 'Agent script manifest entry is invalid')
    }
    const script = value as Record<string, unknown>
    const id = script.id
    const version = script.version
    const sha256 = script.sha256
    const contentPath = script.contentPath
    if (
      typeof id !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(id) ||
      typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) ||
      typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256) ||
      contentPath !== '/agent-scripts/' + id + '/' + version + '.mjs' ||
      typeof script.name !== 'string' || typeof script.description !== 'string' ||
      typeof script.schedule !== 'string' || typeof script.enabled !== 'boolean' ||
      typeof script.timeout !== 'number' ||
      (script.reliability !== 'best_effort' && script.reliability !== 'reliable')
    ) {
      throw new ApiError(503, 503, 'Agent script manifest entry is invalid')
    }
    if (ids.has(id)) throw new ApiError(503, 503, 'Agent script manifest contains duplicate ids')
    ids.add(id)
    scripts.push({
      id, name: script.name, version, description: script.description,
      schedule: script.schedule, enabled: script.enabled, timeout: script.timeout,
      reliability: script.reliability, sha256, contentPath,
    })
  }
  return scripts
}

async function readPublishedScript(
  env: Bindings,
  requestUrl: string,
  script: PublishedAgentScript,
): Promise<string> {
  const response = await env.ASSETS.fetch(new Request(new URL(script.contentPath, requestUrl)))
  if (!response.ok) throw new ApiError(503, 503, 'Agent script asset unavailable: ' + script.id)
  const source = await response.text()
  if (new TextEncoder().encode(source).byteLength > 512 * 1024) {
    throw new ApiError(503, 503, 'Agent script asset exceeds size limit: ' + script.id)
  }
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source))
  const actual = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  if (actual !== script.sha256) throw new ApiError(503, 503, 'Agent script asset hash mismatch: ' + script.id)
  return source
}

node.post('/agent/next', async (c) => {
  const body = await c.req.json<{
    agentVersion?: string
    scripts?: unknown[]
  }>().catch(() => ({} as { agentVersion?: string; scripts?: unknown[] }))
  if (typeof body.agentVersion !== 'string' || !Array.isArray(body.scripts) || body.scripts.length > 200) {
    return nodeErr(400, 'invalid Agent runtime request')
  }
  const local: LocalAgentScript[] = []
  for (const value of body.scripts) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return nodeErr(400, 'invalid local script inventory')
    }
    const script = value as Record<string, unknown>
    if (
      typeof script.id !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(script.id) ||
      typeof script.version !== 'string' ||
      typeof script.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(script.sha256)
    ) {
      return nodeErr(400, 'invalid local script inventory entry')
    }
    local.push({ id: script.id, version: script.version, sha256: script.sha256 })
  }

  const now = Date.now()
  await registerNode(c.env.DB, c.get('node'), body.agentVersion, now)
  const published = await readAgentScriptManifest(c.env, c.req.url)
  const enabled = published.filter((script) => script.enabled)
  const enabledIds = new Set(enabled.map((script) => script.id))
  const localByVersion = new Map(local.map((script) => [
    script.id + '\u0000' + script.version,
    script,
  ]))

  const updates: Array<PublishedAgentScript & { source: string }> = []
  for (const script of enabled) {
    const installed = localByVersion.get(script.id + '\u0000' + script.version)
    if (installed?.sha256 === script.sha256) continue
    if (updates.length >= 5) break
    updates.push({ ...script, source: await readPublishedScript(c.env, c.req.url, script) })
  }

  // Disabled or revoked script ids are removed from the local active cache.
  // Old versions of still-published ids are retained for execution-version pinning.
  const deletes = [...new Map(
    local
      .filter((script) => !enabledIds.has(script.id))
      .map((script) => [script.id + '\u0000' + script.version, { id: script.id, version: script.version }]),
  ).values()].slice(0, 20)

  const needsSync = updates.length > 0 || deletes.length > 0
  return nodeOk({
    action: needsSync ? 'sync' : 'idle',
    schemaVersion: 1,
    scripts: updates,
    deletes,
  })
})

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
    .prepare('SELECT cron, started_at, type, payload, target_key AS targetKey FROM job WHERE id = ?')
    .bind(id)
    .first<{
      cron: string | null
      started_at: number | null
      type: string
      payload: string | null
      targetKey: string | null
    }>()
  if (!job) return nodeErr(409, 'lease lost')
  let nextRunAt = job.cron ? nextCronRun(job.cron, now) : null
  // 无 cron = 一次性任务：完成后置 done（next_run_at 不推进，回 pending 会被立刻重复领取）
  let nextStatus = job.cron ? 'pending' : 'done'

  // zsxq_backfill：未完成时仍按 cron 节奏续跑，避免成功回调立即链式领取下一片。
  // 无 cron 的兼容任务使用 20 分钟兜底间隔；有 cron 时保留原定时节奏。
  if (job.type === 'zsxq_backfill') {
    const groupIds = payloadGroupIds(parsePayload(job.payload))
    if (await zsxqBackfillHasPending(db, groupIds)) {
      nextRunAt = job.cron ? nextCronRun(job.cron, now) : now + 20 * 60_000
      nextStatus = 'pending'
    }
  }

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

  // 跨节点调度：这个节点对这个目标抓成功 → +5（同一站点的所有源共享评分）
  await bumpScore(db, job.targetKey ?? targetKeyOf(job.type, parsePayload(job.payload)), nodeId, 'success', now)

  const jobs = await claimPipeline(c.env, nodeId, now)
  return nodeOk({ jobs })
})

node.post('/jobs/:id/fail', async (c) => {
  const now = Date.now()
  const db = c.env.DB
  const id = Number(c.req.param('id'))
  const { error, errorKind, agentVersion } = await c.req.json<{
    error?: string
    errorKind?: string
    agentVersion?: string
  }>()
  const nodeId = c.get('node')

  const row = await db
    .prepare(
      'SELECT attempts, started_at, cron, fail_streak AS failStreak, type, payload, target_key AS targetKey FROM job WHERE id = ?',
    )
    .bind(id)
    .first<{
      attempts: number
      started_at: number | null
      cron: string | null
      failStreak: number
      type: string
      payload: string | null
      targetKey: string | null
    }>()
  const attempts = (row?.attempts ?? 0) + 1
  const lastError = (error ?? '').slice(0, 1000) || null

  if (attempts < MAX_ATTEMPTS) {
    const res = await db
      .prepare(`UPDATE job SET status = 'pending', attempts = ?, next_run_at = ?, last_run_at = ?, lease_until = NULL, result = ?
                WHERE id = ? AND status = 'leased' AND node_id = ?`)
      .bind(attempts, now + 5 * 60_000 * attempts, now, lastError, id, nodeId)
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
             next_run_at = ?, last_run_at = ?, lease_until = NULL, result = ?
             WHERE id = ? AND status = 'leased' AND node_id = ?`
          : `UPDATE job SET status = 'pending', attempts = 0, fail_streak = ?,
             next_run_at = ?, last_run_at = ?, lease_until = NULL, result = ?
             WHERE id = ? AND status = 'leased' AND node_id = ?`,
      )
      .bind(failStreak, nextCronRun(row.cron, now), now, result, id, nodeId)
      .run()
    if (res.meta.changes === 0) return nodeErr(409, 'lease lost') // 所有权校验
  } else {
    const res = await db
      .prepare(`UPDATE job SET status = 'failed', attempts = ?, last_run_at = ?, result = ?, lease_until = NULL
                WHERE id = ? AND status = 'leased' AND node_id = ?`)
      .bind(attempts, now, lastError, id, nodeId)
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

  // 跨节点调度：只有「网络类」失败才扣该节点对该目标的评分（403/404、解析错误不算节点的锅）。
  // agent 新版会直接给 errorKind；老 agent 靠错误原文兜底。
  const isNetwork = errorKind ? errorKind === 'network' : NETWORK_ERROR_RE.test(lastError ?? '')
  if (isNetwork) {
    const target = row?.targetKey ?? targetKeyOf(row?.type ?? '', parsePayload(row?.payload ?? null))
    await bumpScore(db, target, nodeId, 'network', now)
  }

  const jobs = await claimPipeline(c.env, nodeId, now)
  return nodeOk({ jobs })
})

// agent 上传 TTS 合成音频（Piper）：写入 R2 并登记缓存，供阅读器播放
node.post('/tts/upload', async (c) => {
  const bookId = Number(c.req.query('bookId'))
  const key = String(c.req.query('key') || '').trim().toLowerCase()
  const voice = String(c.req.query('voice') || 'zh_CN-huayan-medium').trim()
  if (!Number.isFinite(bookId) || bookId <= 0) return nodeErr(400, 'bad bookId')
  if (!/^[a-f0-9]{1,64}$/.test(key)) return nodeErr(400, 'bad key')
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(voice)) return nodeErr(400, 'bad voice')
  const ct = c.req.header('content-type') || 'audio/wav'
  const body = c.req.raw.body
  if (!body) return nodeErr(400, 'empty body')
  const r2Key = `tts/${bookId}/${voice}/${key}.wav`
  const obj = await c.env.R2.put(r2Key, body, { httpMetadata: { contentType: ct } })
  const now = Date.now()
  await c.env.DB
    .prepare(
      `INSERT INTO tts_segment (book_id, segment_key, voice, r2_key, size, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(book_id, segment_key, voice) DO UPDATE SET r2_key = excluded.r2_key, size = excluded.size, created_at = excluded.created_at`,
    )
    .bind(bookId, key, voice, r2Key, obj.size, now)
    .run()
  return nodeOk({ ok: true, r2Key })
})
