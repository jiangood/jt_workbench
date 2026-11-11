/** 知识星球模块：话题列表 + 图片懒代理（首次查看经 Worker 拉取入 R2，此后走 R2） */

import { Hono } from 'hono'
import { ok, ApiError, type Env } from '../core/envelope'
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

/** job.payload 里的 groupId（坏 JSON 当未配置，别让页面整个挂掉） */
function payloadGroupId(payload: string | null): string | null {
  try {
    const v = JSON.parse(payload ?? '') as { groupId?: unknown }
    return typeof v.groupId === 'string' && v.groupId ? v.groupId : null
  } catch {
    return null
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
    // 页面用它在输入框里回填 groupId、展示启停状态与最近一次同步结果
    job: {
      groupId: payloadGroupId(job?.payload ?? null),
      enabled: job?.enabled === 1,
      status: job?.status ?? null,
      lastRunAt: job?.last_run_at ?? null,
      result: job?.result ?? null,
    },
  })
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

/** zsxq_sync 任务：单行维护；groupId 由页面手工填写，保存即启用（换星球 / 重新启用会立刻排一轮） */
zsxq.post('/job', async (c) => {
  const b = await c.req.json<{ groupId?: string; enabled?: boolean; runNow?: boolean }>()
  const groupId = (b.groupId ?? '').trim()
  if (groupId && !/^\d{1,20}$/.test(groupId)) {
    throw new ApiError(400, 400, 'groupId 应为星球数字 ID（网页版地址 /group/ 后面那串数字）')
  }
  const enabling = b.enabled !== false
  if (!groupId && enabling) throw new ApiError(400, 400, 'groupId required')

  const db = c.env.DB
  const now = Date.now()
  const existing = await db
    .prepare(`SELECT id, payload, enabled FROM job WHERE type = 'zsxq_sync' LIMIT 1`)
    .first<{ id: number; payload: string | null; enabled: number }>()

  if (groupId) {
    // 任务只同步一个星球：登记并启用当前 groupId，其余历史星球一并置停用
    await db.batch([
      db
        .prepare(
          `INSERT INTO zsxq_group (id, enabled) VALUES (?, ?)
           ON CONFLICT (id) DO UPDATE SET enabled = excluded.enabled`,
        )
        .bind(groupId, enabling ? 1 : 0),
      db.prepare('UPDATE zsxq_group SET enabled = 0 WHERE id <> ?').bind(groupId),
    ])
  }

  if (!existing) {
    if (!groupId) return ok(null)
    await db
      .prepare(`INSERT INTO job (type, payload, cron, enabled, status, next_run_at)
                VALUES ('zsxq_sync', ?, '0 20 * * * ?', ?, 'pending', ?)`)
      .bind(JSON.stringify({ groupId, count: 20 }), enabling ? 1 : 0, now)
      .run()
    return ok(null)
  }

  const prevGroupId = payloadGroupId(existing.payload)
  // 换星球 / 从停用转启用 / 页面点「立即同步」：排到当前时刻，节点下次 poll 就能领走
  const runNow = enabling && (!!b.runNow || groupId !== prevGroupId || existing.enabled !== 1)
  const payload = groupId ? JSON.stringify({ groupId, count: 20 }) : existing.payload

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
