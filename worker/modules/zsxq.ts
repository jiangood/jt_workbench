/** 知识星球模块：话题列表 + 图片懒代理（首次查看经 Worker 拉取入 R2，此后走 R2） */

import { Hono } from 'hono'
import { ok, ApiError, type Env } from '../core/envelope'
import { serveFile } from '../core/files'

export const zsxq = new Hono<Env>()

zsxq.get('/topics', async (c) => {
  const groupId = c.req.query('groupId') || null
  const page = Math.max(1, Number(c.req.query('page') ?? '1') || 1)
  const pageSize = 20
  const where = groupId ? 'WHERE group_id = ?' : ''
  const bind = groupId ? [groupId] : []

  const rows = await c.env.DB
    .prepare(
      `SELECT id, group_id AS groupId, title, talk_text AS talkText, images, files,
              create_time AS createTime FROM zsxq_topic ${where}
       ORDER BY create_time DESC LIMIT ? OFFSET ?`,
    )
    .bind(...bind, pageSize, (page - 1) * pageSize)
    .all()
  const count = await c.env.DB.prepare(`SELECT count(*) AS total FROM zsxq_topic ${where}`)
    .bind(...bind)
    .first<{ total: number }>()

  const groups = await c.env.DB.prepare('SELECT id, name, enabled FROM zsxq_group ORDER BY id').all()

  return ok({
    topics: (rows.results ?? []).map((t: Record<string, unknown>) => ({
      ...t,
      images: t.images ? JSON.parse(t.images as string) : [],
      files: t.files ? JSON.parse(t.files as string) : [],
    })),
    total: count?.total ?? 0,
    page,
    groups: groups.results,
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

/** zsxq_sync 任务：单行维护（默认停用；配置 groupId 后启用） */
zsxq.post('/job', async (c) => {
  const b = await c.req.json<{ groupId?: string; enabled?: boolean }>()
  if (b.groupId) {
    await c.env.DB
      .prepare(`INSERT INTO zsxq_group (id, enabled) VALUES (?, 1)
                ON CONFLICT (id) DO UPDATE SET enabled = COALESCE(?, enabled)`)
      .bind(b.groupId, b.enabled === undefined ? null : b.enabled ? 1 : 0)
      .run()
    const payload = JSON.stringify({ groupId: b.groupId, count: 20 })
    const existing = await c.env.DB
      .prepare(`SELECT id FROM job WHERE type = 'zsxq_sync' LIMIT 1`)
      .first<{ id: number }>()
    if (!existing) {
      await c.env.DB
        .prepare(`INSERT INTO job (type, payload, cron, enabled, status, next_run_at)
                  VALUES ('zsxq_sync', ?, '0 20 * * * ?', 1, 'pending', 1)`)
        .bind(payload)
        .run()
    } else {
      await c.env.DB
        .prepare(`UPDATE job SET payload = ?, enabled = COALESCE(?, enabled) WHERE id = ?`)
        .bind(payload, b.enabled === undefined ? null : b.enabled ? 1 : 0, existing.id)
        .run()
    }
  }
  return ok(null)
})
