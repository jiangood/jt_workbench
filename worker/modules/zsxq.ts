/**
 * 知识星球模块：话题 / 评论 / 附件下载代理 / 星主附件备份 + 图片懒代理
 * （图片首次查看经 Worker 拉取入 R2，此后走 R2；附件只有星主备份才落 R2，普通下载直连透传）
 */

import { Hono } from 'hono'
import type { Context } from 'hono'
import { ok, ApiError, type Bindings, type Env } from '../core/envelope'
import { findField, getConfig, setConfig, validateConfig } from '../core/config'
import { serveFile } from '../core/files'

export const zsxq = new Hono<Env>()

interface SyncJobRow {
  id: number
  payload: string | null
  enabled: number
  status: string
  last_run_at: number | null
  result: string | null
}

/** zsxq_topic 行（0025 新增列；老数据为 NULL / 0） */
interface TopicRow {
  id: string
  groupId: string
  title: string | null
  talkText: string | null
  images: string | null
  files: string | null
  authorId: string | null
  authorName: string | null
  isOwner: number
  commentsCount: number
  likesCount: number
  createTime: number | null
  deleted: number
  deletedAt: number | null
}

interface TopicImage {
  u?: string
  w?: number | null
  h?: number | null
}

/** zsxq_topic.files 里的 JSON 项：老数据只有 {name,size}，新采集带 fileId */
interface TopicFile {
  fileId?: string | number | null
  name?: string
  size?: number
  /** 以下两项由 attachFileMeta 补上，不落 zsxq_topic */
  r2Key?: string | null
  backupStatus?: string | null
}

interface TopicOut {
  id: string
  groupId: string
  title: string | null
  talkText: string | null
  authorId: string | null
  authorName: string | null
  isOwner: boolean
  commentsCount: number
  likesCount: number
  createTime: number | null
  /** 星球里已删除（软删）：正文 / 评论 / 附件照常保留，页面打标并可单独筛选 */
  deleted: boolean
  deletedAt: number | null
  images: TopicImage[]
  files: TopicFile[]
}

interface CommentRow {
  id: string
  authorId: string | null
  authorName: string | null
  isOwner: number
  text: string | null
  images: string | null
  createTime: number | null
}

interface SyncStateRow {
  group_id: string
  cursor: string | null
  done: number
  note: string | null
  updated_at: number
}

/** zsxq_file 里备份相关的最小列 */
interface BackupFileRow {
  id: string
  name: string | null
  r2_key: string | null
}

/** job.payload 里的同步目标（新格式 groupIds，兼容旧的单 groupId；坏 JSON 当未配置） */
function payloadGroupIds(payload: string | null): string[] {
  try {
    const v = JSON.parse(payload ?? '') as { groupIds?: unknown; groupId?: unknown }
    if (Array.isArray(v.groupIds)) {
      return v.groupIds.filter((id): id is string => typeof id === 'string' && id !== '')
    }
    return typeof v.groupId === 'string' && v.groupId ? [v.groupId] : []
  } catch {
    return []
  }
}

zsxq.get('/topics', async (c) => {
  const groupId = c.req.query('groupId') || null
  const page = clampInt(c.req.query('page'), 1, 1, 100_000)
  const pageSize = clampInt(c.req.query('pageSize'), 20, 1, 100)
  const ownerOnly = isOn(c.req.query('ownerOnly'))
  // 删除状态筛选：all（默认，含已删除）/ active / deleted；非法值按 all
  const state = c.req.query('state')
  const deletedFilter = state === 'deleted' ? 1 : state === 'active' ? 0 : null

  // 条件全部用占位符拼（groupId / ownerOnly 都吃参数绑定），不拼用户输入
  const conds: string[] = []
  const bind: string[] = []
  if (groupId) {
    conds.push('group_id = ?')
    bind.push(groupId)
  }
  if (ownerOnly) conds.push('is_owner = 1')
  if (deletedFilter !== null) {
    conds.push('deleted = ?')
    bind.push(String(deletedFilter))
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''

  const [rows, count, groups, splitJobs, progress] = await Promise.all([
    c.env.DB
      .prepare(
        `SELECT id, group_id AS groupId, title, talk_text AS talkText, images, files,
                author_id AS authorId, author_name AS authorName, is_owner AS isOwner,
                comments_count AS commentsCount, likes_count AS likesCount,
                create_time AS createTime, deleted, deleted_at AS deletedAt
           FROM zsxq_topic ${where}
         ORDER BY create_time DESC LIMIT ? OFFSET ?`,
      )
      .bind(...bind, pageSize, (page - 1) * pageSize)
      .all<TopicRow>(),
    c.env.DB.prepare(`SELECT count(*) AS total FROM zsxq_topic ${where}`)
      .bind(...bind)
      .first<{ total: number }>(),
    c.env.DB.prepare('SELECT id, name, enabled FROM zsxq_group ORDER BY enabled DESC, id').all(),
    c.env.DB
      .prepare(
        `SELECT id, type, payload, enabled, status, last_run_at, result
         FROM job WHERE type IN ('zsxq_sync','zsxq_backfill','zsxq_comments','zsxq_probe')`,
      )
      .all<SyncJobRow & { type: string }>(),
    loadSyncProgress(c.env.DB),
  ])

  const topics: TopicOut[] = (rows.results ?? []).map((t) => ({
    id: t.id,
    groupId: t.groupId,
    title: t.title,
    talkText: t.talkText,
    authorId: t.authorId,
    authorName: t.authorName,
    isOwner: t.isOwner === 1,
    commentsCount: t.commentsCount ?? 0,
    likesCount: t.likesCount ?? 0,
    createTime: t.createTime,
    deleted: t.deleted === 1,
    deletedAt: t.deletedAt,
    images: parseJsonArray(t.images) as TopicImage[],
    files: parseJsonArray(t.files).filter(isRecord) as TopicFile[],
  }))
  // 附件备份状态（r2_key）来自 zsxq_file，页面据此显示「已备份」
  await attachFileMeta(c.env.DB, topics)

  const total = count?.total ?? 0
  const splitList = (splitJobs.results ?? []) as Array<SyncJobRow & { type: string }>
  const groupRows = (groups.results ?? []) as Array<{ id: string | number; enabled?: number }>
  const enabledGroups = groupRows.filter((g) => g.enabled === 1).map((g) => String(g.id))
  const anyEnabled = splitList.some((j) => j.enabled === 1) || enabledGroups.length > 0
  const backfills = splitList.filter((j) => j.type === 'zsxq_sync' || j.type === 'zsxq_backfill')
  const lastRunAt = backfills.reduce<number | null>((m, j) => (j.last_run_at && (!m || j.last_run_at > m) ? j.last_run_at : m), null)
  const lastResultJob = [...backfills].sort((a, b) => (b.last_run_at ?? 0) - (a.last_run_at ?? 0))[0]
  const status =
    splitList.some((j) => j.status === 'leased') ? 'leased'
    : splitList.some((j) => j.status === 'failed') ? 'failed'
    : splitList.some((j) => j.status === 'pending') ? 'pending'
    : splitList.length ? 'done'
    : null

  return ok({
    topics,
    total,
    page,
    pageSize,
    pages: Math.max(1, Math.ceil(total / pageSize)),
    groups: groups.results,
    job: {
      groupIds: enabledGroups,
      enabled: anyEnabled,
      status,
      lastRunAt,
      result: lastResultJob?.result ?? null,
      progress,
    },
  })
})

/** 帖子评论：按 create_time 正序分页；ownerOnly=1 只看星主回复 */
zsxq.get('/topics/:id/comments', async (c) => {
  const topicId = c.req.param('id')
  if (!DIGITS_RE.test(topicId)) throw new ApiError(400, 400, '帖子 ID 无效')

  const page = clampInt(c.req.query('page'), 1, 1, 100_000)
  const pageSize = clampInt(c.req.query('pageSize'), 20, 1, 100)
  const ownerOnly = isOn(c.req.query('ownerOnly'))
  const where = `topic_id = ?${ownerOnly ? ' AND is_owner = 1' : ''}`

  const [rows, count] = await Promise.all([
    c.env.DB
      .prepare(
        `SELECT id, author_id AS authorId, author_name AS authorName, is_owner AS isOwner,
                text, images, create_time AS createTime
         FROM zsxq_comment WHERE ${where}
         ORDER BY create_time ASC, id ASC LIMIT ? OFFSET ?`,
      )
      .bind(topicId, pageSize, (page - 1) * pageSize)
      .all<CommentRow>(),
    c.env.DB
      .prepare(`SELECT count(*) AS total FROM zsxq_comment WHERE ${where}`)
      .bind(topicId)
      .first<{ total: number }>(),
  ])

  const total = count?.total ?? 0
  return ok({
    comments: (rows.results ?? []).map((r) => ({
      id: r.id,
      authorId: r.authorId,
      authorName: r.authorName,
      isOwner: r.isOwner === 1,
      text: r.text,
      images: parseJsonArray(r.images),
      createTime: r.createTime,
    })),
    total,
    page,
    pages: Math.max(1, Math.ceil(total / pageSize)),
  })
})

/** 星球候选列表（token 拉取过一次后落库）：页面勾选同步目标 + 刷新任务状态 */
zsxq.get('/groups', async (c) => {
  const [groups, refresh, token] = await Promise.all([
    c.env.DB.prepare('SELECT id, name, enabled FROM zsxq_group ORDER BY enabled DESC, name, id').all(),
    c.env.DB
      .prepare(`SELECT status, last_run_at, result FROM job WHERE type = 'zsxq_groups' LIMIT 1`)
      .first<{ status: string; last_run_at: number | null; result: string | null }>(),
    getConfig(c.env, 'zsxq_token'),
  ])
  return ok({
    groups: groups.results,
    hasToken: !!token,
    refresh: refresh
      ? { status: refresh.status, lastRunAt: refresh.last_run_at, result: refresh.result }
      : null,
  })
})

/** 保存 / 清除知识星球 token（仍存 D1 app_config，但不在「参数与密钥」展示，统一由本页维护） */
zsxq.post('/token', async (c) => {
  const b = await c.req.json<{ token?: string }>()
  const field = findField('zsxq_token')
  if (!field) throw new ApiError(500, 500, 'config field missing')

  const value = (b.token ?? '').trim()
  const err = validateConfig(field, value)
  if (err) throw new ApiError(400, 400, err)

  await setConfig(c.env, field.key, value)
  return ok({ hasToken: !!value })
})

/** 刷新星球列表：给节点排一个一次性 zsxq_groups 任务（token 由 Worker 下发时注入） */
zsxq.post('/groups/refresh', async (c) => {
  const token = await getConfig(c.env, 'zsxq_token')
  if (!token) throw new ApiError(400, 400, '请先填写知识星球 token（本页「同步星球」卡片）')

  const db = c.env.DB
  const now = Date.now()
  const existing = await db
    .prepare(`SELECT id, status, lease_until FROM job WHERE type = 'zsxq_groups' LIMIT 1`)
    .first<{ id: number; status: string; lease_until: number | null }>()

  if (!existing) {
    await db
      .prepare(`INSERT INTO job (type, payload, cron, enabled, status, next_run_at)
                VALUES ('zsxq_groups', '{}', NULL, 1, 'pending', ?)`)
      .bind(now)
      .run()
  } else if (existing.status !== 'leased' || (existing.lease_until ?? 0) <= now) {
    // 复用同一行：避免每次刷新都堆一条一次性任务
    await db
      .prepare(
        `UPDATE job SET status = 'pending', enabled = 1, next_run_at = ?, lease_until = NULL,
           node_id = NULL, attempts = 0, result = NULL WHERE id = ?`,
      )
      .bind(now, existing.id)
      .run()
  }
  return ok(null)
})

/** 图片懒代理：R2 命中直接回；未命中拉源图入 R2（key = zsxq-img/<sha1(u)>.ext） */
zsxq.get('/img', async (c) => {
  const u = c.req.query('u')
  if (!u || !IMG_URL_RE.test(u)) throw new ApiError(400, 400, 'invalid image url')

  const hit = await findImage(c.env, u)
  if (hit) return serveFile(c.env, hit, c.req.raw)

  const res = await fetch(u, {
    headers: { referer: 'https://wx.zsxq.com/' },
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok || !res.body) throw new ApiError(502, 502, `image HTTP ${res.status}`)
  const ct = res.headers.get('content-type') ?? 'image/jpeg'
  const key = await imageKey(u, ct)
  await c.env.R2.put(key, res.body, { httpMetadata: { contentType: ct } })
  return serveFile(c.env, key, c.req.raw)
})

/**
 * 附件下载代理：R2 里有星主备份就直接流式下发（支持 Range）；
 * 否则用 D1 里的 token 现取 download_url 直连透传（不缓存，避免把每次浏览都变成存储）。
 */
zsxq.get('/files/:id', async (c) => {
  const id = c.req.param('id')
  if (!DIGITS_RE.test(id)) throw new ApiError(400, 400, '附件 ID 无效')

  const row = await c.env.DB
    .prepare('SELECT id, name, r2_key, backup_status FROM zsxq_file WHERE id = ?')
    .bind(id)
    .first<BackupFileRow>()
  const name = row?.name || `zsxq-${id}`

  if (row?.r2_key) {
    const obj = await c.env.R2.head(row.r2_key)
    if (obj) return asAttachment(await serveFile(c.env, row.r2_key, c.req.raw, name), name)
  }

  const token = await getConfig(c.env, 'zsxq_token')
  if (!token) throw new ApiError(400, 400, '未配置知识星球 token：先在「同步配置」里填写才能下载附件')

  let upstream: Response
  try {
    const url = await downloadUrl(token, id)
    upstream = await fetchAttachment(url)
  } catch (err) {
    // 下载失败回写状态：页面「备份星主附件」下次会重试，用户也能看到原因
    await markFileFailed(c.env.DB, id, err)
    throw err instanceof ApiError ? err : new ApiError(502, 502, `附件下载失败：${errText(err)}`)
  }

  const headers = new Headers()
  headers.set('content-type', upstream.headers.get('content-type') ?? 'application/octet-stream')
  headers.set('content-disposition', attachmentDisposition(name))
  const len = upstream.headers.get('content-length')
  if (len) headers.set('content-length', len)
  headers.set('cache-control', 'private, max-age=0, must-revalidate')
  headers.set('x-content-type-options', 'nosniff')
  return new Response(upstream.body, { status: 200, headers })
})

/**
 * 星主附件备份：把星主帖子 / 评论里的附件与图片搬进 R2（幂等，可反复点）。
 * - 文件：只挑 is_owner=1 且还没备份成功的 zsxq_file，下载后写 zsxq-file/<fileId>
 * - 图片：扫星主帖子 / 评论的 images JSON，按 zsxq-img/<sha1(u)>.<ext> 去重（与 /img 同一套 key）
 * - 单次只做 body 指定的数量（默认各 5，页面按 5 文件 + 10 图轮询），避免一次请求超时
 */
zsxq.post('/backup', async (c) => {
  let body: { files?: unknown; images?: unknown } = {}
  try {
    body = (await c.req.json<typeof body>()) ?? {}
  } catch {
    body = {}
  }
  const fileLimit = clampInt(body.files, 5, 1, 20)
  const imageLimit = clampInt(body.images, 5, 1, 30)
  const token = await getConfig(c.env, 'zsxq_token')

  const files = await backupFiles(c, token, fileLimit)
  const images = await backupImages(c, imageLimit)

  return ok({
    files: files.result,
    images: images.result,
    remaining: { files: files.remaining, images: images.remaining },
  })
})

/** zsxq 同步任务：所有启用星球共用一条总任务，每 3 小时执行一次 */
zsxq.post('/job', async (c) => {
  const b = await c.req.json<{ groupId?: string; groupIds?: string[]; enabled?: boolean; runNow?: boolean }>()
  const groupIds = [
    ...new Set(
      (Array.isArray(b.groupIds) ? b.groupIds : b.groupId ? [b.groupId] : [])
        .map((id) => String(id).trim())
        .filter(Boolean),
    ),
  ]
  if (groupIds.some((id) => !/^\\d{1,20}$/.test(id))) {
    throw new ApiError(400, 400, 'groupId 应为星球数字 ID（网页版地址 /group/ 后面那串数字）')
  }
  const enabling = b.enabled !== false
  if (!groupIds.length && enabling) throw new ApiError(400, 400, '至少选择一个星球')

  const db = c.env.DB
  const now = Date.now()

  // 勾选状态落在 zsxq_group.enabled
  if (groupIds.length) {
    const placeholders = groupIds.map(() => '?').join(',')
    await db.batch([
      ...groupIds.map((id) => db.prepare('INSERT OR IGNORE INTO zsxq_group (id) VALUES (?)').bind(id)),
      db
        .prepare(`UPDATE zsxq_group SET enabled = CASE WHEN id IN (${placeholders}) THEN ? ELSE 0 END`)
        .bind(...groupIds, enabling ? 1 : 0),
    ])
  } else if (!enabling) {
    await db.prepare('UPDATE zsxq_group SET enabled = 0').run()
  }

  const existing = await db
    .prepare(`SELECT id, payload, enabled, status FROM job WHERE type = 'zsxq_sync' LIMIT 1`)
    .first<{ id: number; payload: string | null; enabled: number; status: string }>()
  const previous = new Set(payloadGroupIds(existing?.payload ?? null))
  const selected = new Set(groupIds)
  const selectionChanged =
    previous.size !== selected.size || [...selected].some((id) => !previous.has(id))
  const runNow = enabling && (!!b.runNow || selectionChanged || existing?.enabled !== 1)
  const payload = JSON.stringify({ groupIds, count: 20 })
  const cron = '0 */3 * * *'

  if (!existing) {
    await db
      .prepare(`INSERT INTO job (type, payload, cron, enabled, status, next_run_at)
                VALUES ('zsxq_sync', ?, ?, ?, ?, ?)`)
      .bind(payload, cron, enabling ? 1 : 0, enabling ? 'pending' : 'done', enabling ? now : null)
      .run()
  } else {
    await db
      .prepare(
        `UPDATE job SET payload = ?, cron = ?, enabled = ?,
           next_run_at = CASE WHEN ? THEN ? WHEN ? THEN NULL ELSE next_run_at END,
           status = CASE
             WHEN ? AND status != 'leased' THEN 'pending'
             WHEN NOT ? AND status != 'leased' THEN 'done'
             ELSE status END,
           lease_until = CASE WHEN ? AND status != 'leased' THEN NULL ELSE lease_until END
         WHERE id = ?`,
      )
      .bind(
        payload,
        cron,
        enabling ? 1 : 0,
        runNow ? 1 : 0,
        now,
        enabling ? 0 : 1,
        runNow ? 1 : 0,
        enabling ? 1 : 0,
        runNow ? 1 : 0,
        existing.id,
      )
      .run()
  }

  return ok(null)
})

/** 立即同步：只提前总任务，不改变已保存的星球配置 */
zsxq.post('/sync', async (c) => {
  const res = await c.env.DB
    .prepare(
      `UPDATE job SET next_run_at = ?, status = CASE WHEN status IN ('done','failed') THEN 'pending' ELSE status END
       WHERE type = 'zsxq_sync' AND enabled = 1`,
    )
    .bind(Date.now())
    .run()
  if (res.meta.changes === 0) throw new ApiError(409, 409, '同步任务未启用：先勾选星球并保存')
  return ok(null)
})

/* ---------------- 共用工具（附件代理 / 备份 / 列表共用） ---------------- */

const DIGITS_RE = /^\d{1,32}$/
/** 图片只代理知识星球官方图床（防 SSRF，与 /img 的既有约束一致） */
const IMG_URL_RE = /^https:\/\/images\.zsxq\.com\//
const IMG_PREFIX = 'zsxq-img/'
const FILE_PREFIX = 'zsxq-file/'
/** 备份单轮扫描上限：全是已备份图片时别把 R2 操作预算耗光 */
const MAX_IMAGE_SCAN = 200
const MAX_IMAGE_URLS = 500

function clampInt(value: unknown, def: number, min: number, max: number): number {
  const n = Math.trunc(Number(value))
  if (!Number.isFinite(n)) return def
  return Math.min(max, Math.max(min, n))
}

function isOn(value: string | undefined): boolean {
  return value === '1' || value === 'true'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** JSON 列解析：坏 JSON / 旧数据一律当空数组，不让一只坏行打断整页 */
function parseJsonArray(raw: string | null): unknown[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** 错误列只留 300 字：D1 行宽别被一次 HTML 错误页撑爆 */
function clipNote(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > 300 ? `${oneLine.slice(0, 299)}…` : oneLine
}

/** zsxq_topic.files 里的 fileId（新数据 fileId / 兼容 file_id / id）；只认数字串 */
function fileIdOf(file: TopicFile): string | null {
  const raw =
    file.fileId ??
    (file as { file_id?: unknown }).file_id ??
    (file as { id?: unknown }).id
  const id = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw : ''
  return DIGITS_RE.test(id) ? id : null
}

/** 附件备份状态：一次 IN 查询补齐整页帖子的 r2_key / backup_status */
async function attachFileMeta(db: D1Database, topics: TopicOut[]): Promise<void> {
  const ids = new Set<string>()
  for (const topic of topics) {
    for (const file of topic.files) {
      const id = fileIdOf(file)
      if (id) ids.add(id)
    }
  }
  if (!ids.size) return

  const all = [...ids]
  const map = new Map<string, { r2_key: string | null; backup_status: string | null }>()
  try {
    // D1 单语句绑定参数上限 100：按 90 一批查（一页帖子可能带几百个附件）
    for (let i = 0; i < all.length; i += 90) {
      const chunk = all.slice(i, i + 90)
      const rows = await db
        .prepare(
          `SELECT id, r2_key, backup_status FROM zsxq_file
           WHERE id IN (${chunk.map(() => '?').join(',')})`,
        )
        .bind(...chunk)
        .all<{ id: string; r2_key: string | null; backup_status: string | null }>()
      for (const row of rows.results ?? []) map.set(row.id, row)
    }
    for (const topic of topics) {
      topic.files = topic.files.map((file) => {
        const id = fileIdOf(file)
        const status = id ? map.get(id) : undefined
        return { ...file, fileId: id, r2Key: status?.r2_key ?? null, backupStatus: status?.backup_status ?? null }
      })
    }
  } catch {
    /* 0025 未迁移：附件照常展示，只是没有「已备份」标记 */
  }
}

/** 全量回溯进度：zsxq_sync_state 表不存在时（0025 前）返回空数组 */
async function loadSyncProgress(
  db: D1Database,
): Promise<Array<{ groupId: string; cursor: string | null; done: boolean; note: string | null; updatedAt: number }>> {
  try {
    const rows = await db
      .prepare('SELECT group_id, cursor, done, note, updated_at FROM zsxq_sync_state ORDER BY group_id')
      .all<SyncStateRow>()
    return (rows.results ?? []).map((r) => ({
      groupId: r.group_id,
      cursor: r.cursor,
      done: r.done === 1,
      note: r.note,
      updatedAt: r.updated_at,
    }))
  } catch {
    return []
  }
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function sha1Hex(input: string): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(input))))
}

/**
 * 图片 R2 key：zsxq-img/<sha1(u)>.<jpg|png>
 * /img 懒代理与星主备份共用同一条规则，命中即跳过（幂等去重）。
 */
async function imageKey(u: string, contentType?: string | null): Promise<string> {
  const hash = await sha1Hex(u)
  return `${IMG_PREFIX}${hash}.${contentType?.includes('png') ? 'png' : 'jpg'}`
}

/** 图片是否已入 R2：上传时才知道真实类型，png / jpg 都探一次 */
async function findImage(env: Bindings, u: string): Promise<string | null> {
  const hash = await sha1Hex(u)
  for (const ext of ['jpg', 'png']) {
    const key = `${IMG_PREFIX}${hash}.${ext}`
    if (await env.R2.head(key)) return key
  }
  return null
}

/** 与 agent 完全一致的接口头（Worker 现取 download_url 时用） */
function zsxqHeaders(token: string): Record<string, string> {
  return {
    authorization: token,
    'user-agent': 'xiaomiquan/2.57.0 workbench-agent',
    'x-version': '2.57.0',
    'x-request-id': crypto.randomUUID(),
  }
}

/** 内网 / 环回 / 保留地址（数字 IP 与 localhost）：SSRF 守卫兜底 */
const PRIVATE_HOST_RE =
  /^(localhost|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$)/i

/**
 * 取附件一次性下载地址：GET /v2/files/{id}/download_url。
 * 返回的 URL 只做「https + 非内网」校验（知识星球可能走 CDN，不绑定固定域名）。
 */
async function downloadUrl(token: string, fileId: string): Promise<string> {
  const res = await fetch(`https://api.zsxq.com/v2/files/${fileId}/download_url`, {
    headers: zsxqHeaders(token),
    signal: AbortSignal.timeout(30_000),
  })
  const body = (await res.json().catch(() => null)) as {
    succeeded?: boolean
    error?: string
    info?: string
    resp_data?: { download_url?: string }
  } | null
  if (!res.ok || !body?.succeeded) {
    throw new ApiError(502, 502, `获取下载地址失败：${body?.error ?? body?.info ?? `HTTP ${res.status}`}`)
  }
  const raw = body.resp_data?.download_url
  if (!raw) throw new ApiError(502, 502, '获取下载地址失败：接口未返回 download_url')

  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new ApiError(502, 502, '获取下载地址失败：返回了无效 URL')
  }
  if (url.protocol !== 'https:') throw new ApiError(502, 502, '获取下载地址失败：不是 https 地址')
  if (PRIVATE_HOST_RE.test(url.hostname) || url.hostname.endsWith('.local')) {
    throw new ApiError(502, 502, '获取下载地址失败：地址指向内网')
  }
  return url.toString()
}

/** 拉附件本体（流式；给浏览器直连透传或备份写 R2 共用） */
async function fetchAttachment(url: string): Promise<Response> {
  const res = await fetch(url, {
    headers: { referer: 'https://wx.zsxq.com/' },
    signal: AbortSignal.timeout(90_000),
  })
  if (!res.ok || !res.body) throw new ApiError(502, 502, `下载附件失败：HTTP ${res.status}`)
  return res
}

/** 附件一律以「下载」语义下发（serveFile 默认是 inline，这里覆盖） */
function asAttachment(res: Response, filename: string): Response {
  const headers = new Headers(res.headers)
  headers.set('content-disposition', attachmentDisposition(filename))
  return new Response(res.body, { status: res.status, headers })
}

/** RFC 6266 + 5987：ASCII 兜底 + UTF-8 原名（中文文件名不乱码） */
function attachmentDisposition(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  )
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`
}

async function markFileFailed(db: D1Database, id: string, err: unknown): Promise<void> {
  try {
    await db
      .prepare(`UPDATE zsxq_file SET backup_status = 'failed', error = ? WHERE id = ?`)
      .bind(clipNote(errText(err)), id)
      .run()
  } catch {
    /* 0025 未迁移 / 行不存在：回写失败不影响本次报错 */
  }
}

async function markFileDone(db: D1Database, id: string, key: string): Promise<void> {
  await db
    .prepare(`UPDATE zsxq_file SET r2_key = ?, backup_status = 'done', error = NULL WHERE id = ?`)
    .bind(key, id)
    .run()
}

/** 文件备份：挑星主未备份附件逐个搬进 R2；单个失败只记状态，不打断整批 */
async function backupFiles(
  c: Context<Env>,
  token: string,
  limit: number,
): Promise<{ result: { ok: number; failed: number; skipped: number }; remaining: number }> {
  const result = { ok: 0, failed: 0, skipped: 0 }
  const rows = await c.env.DB
    .prepare(
      `SELECT id, name, r2_key FROM zsxq_file
       WHERE is_owner = 1 AND r2_key IS NULL
         AND (backup_status IS NULL OR backup_status != 'done')
       ORDER BY create_time DESC LIMIT ?`,
    )
    .bind(limit)
    .all<BackupFileRow>()

  const picked = rows.results ?? []
  if (picked.length && !token) {
    throw new ApiError(400, 400, '未配置知识星球 token：无法备份星主附件')
  }

  for (const row of picked) {
    const key = `${FILE_PREFIX}${row.id}`
    const name = row.name || `zsxq-${row.id}`
    try {
      // 上一轮已写入 R2 但状态没落库：直接补状态，别重复下载
      if (await c.env.R2.head(key)) {
        await markFileDone(c.env.DB, row.id, key)
        result.skipped += 1
        continue
      }
      const url = await downloadUrl(token, row.id)
      const res = await fetchAttachment(url)
      await c.env.R2.put(key, res.body, {
        httpMetadata: {
          contentType: res.headers.get('content-type') ?? 'application/octet-stream',
          contentDisposition: attachmentDisposition(name),
        },
      })
      await markFileDone(c.env.DB, row.id, key)
      result.ok += 1
    } catch (err) {
      await markFileFailed(c.env.DB, row.id, err)
      result.failed += 1
    }
  }

  // 剩余量按同口径现算（失败行仍是 failed，会继续留在待办里）
  const left = await c.env.DB
    .prepare(
      `SELECT count(*) AS n FROM zsxq_file
       WHERE is_owner = 1 AND r2_key IS NULL
         AND (backup_status IS NULL OR backup_status != 'done')`,
    )
    .first<{ n: number }>()
  return { result, remaining: left?.n ?? 0 }
}

/**
 * 图片备份：从星主帖子 / 评论的 images JSON 里收集 URL（去重），未入 R2 的逐张拉取。
 * 已备份的只算 skipped（继续往后扫，不占下载配额），单轮扫描上限 MAX_IMAGE_SCAN。
 * remaining 是「本轮没来得及检查的 URL 数」——保守估计（可能包含已备份的旧图）。
 */
async function backupImages(
  c: Context<Env>,
  limit: number,
): Promise<{ result: { ok: number; failed: number; skipped: number }; remaining: number }> {
  const result = { ok: 0, failed: 0, skipped: 0 }
  const urls = await collectOwnerImages(c.env.DB)
  const scanCap = Math.min(Math.max(limit * 8, limit), MAX_IMAGE_SCAN)
  let examined = 0

  for (const u of urls) {
    if (examined >= scanCap) break
    if (result.ok + result.failed >= limit) break
    examined += 1
    try {
      if (await findImage(c.env, u)) {
        result.skipped += 1
        continue
      }
      const res = await fetch(u, {
        headers: { referer: 'https://wx.zsxq.com/' },
        signal: AbortSignal.timeout(30_000),
      })
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
      const ct = res.headers.get('content-type') ?? 'image/jpeg'
      await c.env.R2.put(await imageKey(u, ct), res.body, { httpMetadata: { contentType: ct } })
      result.ok += 1
    } catch {
      result.failed += 1
    }
  }

  return { result, remaining: Math.max(0, urls.length - examined) }
}

/** 星主帖子 + 评论里的图片 URL（只收官方图床，去重；新帖优先） */
async function collectOwnerImages(db: D1Database): Promise<string[]> {
  const rows = await db
    .prepare(
      `SELECT images, create_time FROM zsxq_topic
       WHERE is_owner = 1 AND images IS NOT NULL AND images != '[]'
       UNION ALL
       SELECT images, create_time FROM zsxq_comment
       WHERE is_owner = 1 AND images IS NOT NULL AND images != '[]'
       ORDER BY create_time DESC LIMIT ?`,
    )
    .bind(MAX_IMAGE_URLS)
    .all<{ images: string | null }>()

  const urls: string[] = []
  const seen = new Set<string>()
  for (const row of rows.results ?? []) {
    for (const item of parseJsonArray(row.images)) {
      const u = typeof item === 'string' ? item : isRecord(item) ? item.u : null
      if (typeof u !== 'string' || !IMG_URL_RE.test(u) || seen.has(u)) continue
      seen.add(u)
      urls.push(u)
    }
  }
  return urls
}
