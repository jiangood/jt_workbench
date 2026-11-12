/** 知识星球模块：话题列表 + 图片懒代理（首次查看经 Worker 拉取入 R2，此后走 R2） */

import { Hono } from 'hono'
import { ok, ApiError, type Env } from '../core/envelope'
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
  const page = Math.max(1, Number(c.req.query('page') ?? '1') || 1)
  const pageSize = 20
  const where = groupId ? 'WHERE group_id = ?' : ''
  const bind = groupId ? [groupId] : []

  const [rows, count, groups, job] = await Promise.all([
    c.env.DB
      .prepare(
        `SELECT id, group_id AS groupId, title, talk_text AS talkText, images, files,
                create_time AS createTime FROM zsxq_topic ${where}
         ORDER BY create_time DESC LIMIT ? OFFSET ?`,
      )
      .bind(...bind, pageSize, (page - 1) * pageSize)
      .all(),
    c.env.DB.prepare(`SELECT count(*) AS total FROM zsxq_topic ${where}`)
      .bind(...bind)
      .first<{ total: number }>(),
    c.env.DB.prepare('SELECT id, name, enabled FROM zsxq_group ORDER BY enabled DESC, id').all(),
    c.env.DB
      .prepare(
        `SELECT id, payload, enabled, status, last_run_at, result
         FROM job WHERE type = 'zsxq_sync' LIMIT 1`,
      )
      .first<SyncJobRow>(),
  ])

  return ok({
    topics: (rows.results ?? []).map((t: Record<string, unknown>) => ({
      ...t,
      images: t.images ? JSON.parse(t.images as string) : [],
      files: t.files ? JSON.parse(t.files as string) : [],
    })),
    total: count?.total ?? 0,
    page,
    groups: groups.results,
    // 页面用它在勾选列表里回填同步目标、展示启停状态与最近一次同步结果
    job: {
      groupIds: payloadGroupIds(job?.payload ?? null),
      enabled: job?.enabled === 1,
      status: job?.status ?? null,
      lastRunAt: job?.last_run_at ?? null,
      result: job?.result ?? null,
    },
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
  if (!u || !/^https:\/\/images\.zsxq\.com\//.test(u)) throw new ApiError(400, 400, 'invalid image url')
  const hash = toHex(new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(u))))

  for (const ext of ['jpg', 'png']) {
    const hit = await c.env.R2.get(`zsxq-img/${hash}.${ext}`)
    if (hit) return serveFile(c.env, hit.key, c.req.raw)
  }

  const res = await fetch(u, { headers: { referer: 'https://wx.zsxq.com/' } })
  if (!res.ok || !res.body) throw new ApiError(502, 502, `image HTTP ${res.status}`)
  const ct = res.headers.get('content-type') ?? 'image/jpeg'
  const key = `zsxq-img/${hash}.${ct.includes('png') ? 'png' : 'jpg'}`
  await c.env.R2.put(key, res.body, { httpMetadata: { contentType: ct } })
  const fresh = await c.env.R2.get(key)
  if (!fresh) throw new ApiError(500, 500, 'image missing')
  return serveFile(c.env, fresh.key, c.req.raw)
})

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** zsxq_sync 任务：单行维护；勾选多个星球，保存即启用（选择变化 / 重新启用会立刻排一轮） */
zsxq.post('/job', async (c) => {
  const b = await c.req.json<{ groupId?: string; groupIds?: string[]; enabled?: boolean; runNow?: boolean }>()
  const groupIds = [
    ...new Set(
      (Array.isArray(b.groupIds) ? b.groupIds : b.groupId ? [b.groupId] : [])
        .map((id) => String(id).trim())
        .filter(Boolean),
    ),
  ]
  if (groupIds.some((id) => !/^\d{1,20}$/.test(id))) {
    throw new ApiError(400, 400, 'groupId 应为星球数字 ID（网页版地址 /group/ 后面那串数字）')
  }
  const enabling = b.enabled !== false
  if (!groupIds.length && enabling) throw new ApiError(400, 400, '至少选择一个星球')

  const db = c.env.DB
  const now = Date.now()
  const existing = await db
    .prepare(`SELECT id, payload, enabled FROM job WHERE type = 'zsxq_sync' LIMIT 1`)
    .first<{ id: number; payload: string | null; enabled: number }>()

  if (groupIds.length) {
    // 勾选状态落在 zsxq_group.enabled：选中的置 1，其余置 0（首页「已启用」计数也用它）
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

  if (!existing) {
    if (!groupIds.length) return ok(null)
    await db
      .prepare(`INSERT INTO job (type, payload, cron, enabled, status, next_run_at)
                VALUES ('zsxq_sync', ?, '0 20 * * * ?', ?, 'pending', ?)`)
      .bind(JSON.stringify({ groupIds, groupId: groupIds[0], count: 20 }), enabling ? 1 : 0, now)
      .run()
    return ok(null)
  }

  const prevIds = payloadGroupIds(existing.payload)
  const selectionChanged =
    prevIds.length !== groupIds.length || groupIds.some((id) => !prevIds.includes(id))
  // 选择变化 / 从停用转启用 / 页面点「立即同步」：排到当前时刻，节点下次 poll 就能领走
  const runNow = enabling && (!!b.runNow || selectionChanged || existing.enabled !== 1)
  const payload = groupIds.length
    ? JSON.stringify({ groupIds, groupId: groupIds[0], count: 20 })
    : existing.payload

  await db
    .prepare(
      `UPDATE job SET payload = COALESCE(?, payload), enabled = ?,
         next_run_at = CASE WHEN ? THEN ? ELSE next_run_at END,
         status = CASE WHEN ? AND status = 'done' THEN 'pending' ELSE status END
       WHERE id = ?`,
    )
    .bind(payload, enabling ? 1 : 0, runNow ? 1 : 0, now, runNow ? 1 : 0, existing.id)
    .run()
  return ok(null)
})

/** 立即同步：不改变配置，只把下一次执行时间提前到现在（任务未启用时 409） */
zsxq.post('/sync', async (c) => {
  const res = await c.env.DB
    .prepare(
      `UPDATE job SET next_run_at = ?, status = CASE WHEN status = 'done' THEN 'pending' ELSE status END
       WHERE type = 'zsxq_sync' AND enabled = 1`,
    )
    .bind(Date.now())
    .run()
  if (res.meta.changes === 0) throw new ApiError(409, 409, '同步任务未启用：先勾选星球并保存')
  return ok(null)
})
