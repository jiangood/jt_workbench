/** 资讯模块（原 wb_news_*）：列表 / 源管理 / 屏蔽词。正文消毒在浏览器端 DOMPurify（v3 决策 #9） */

import { Hono } from 'hono'
import { ok, ApiError, type Env } from '../core/envelope'

const PAGE_SIZE = 30

export const news = new Hono<Env>()

// ---------- 列表 ----------

news.get('/items', async (c) => {
  const page = Math.max(1, Number(c.req.query('page') ?? '1') || 1)
  const sourceId = c.req.query('sourceId') || null

  const where = sourceId ? 'WHERE source_id = ?' : ''
  const bind = sourceId ? [sourceId] : []

  const items = await c.env.DB
    .prepare(
      `SELECT id, source_id AS sourceId, title, link, author, published_at AS publishedAt,
              substr(content_html, 1, 300) AS preview
       FROM news_item ${where} ORDER BY published_at DESC, id DESC LIMIT ? OFFSET ?`,
    )
    .bind(...bind, PAGE_SIZE, (page - 1) * PAGE_SIZE)
    .all()

  const count = await c.env.DB.prepare(
    `SELECT count(*) AS total FROM news_item ${where}`,
  ).bind(...bind).first<{ total: number }>()

  return ok({ items: items.results, total: count?.total ?? 0, page, pageSize: PAGE_SIZE })
})

// ---------- 订阅源 ----------

news.get('/sources', async (c) => {
  const sources = await c.env.DB
    .prepare(
      `SELECT s.id, s.name, s.type, s.url, s.category, s.sort, s.enabled,
              (SELECT count(*) FROM news_item i WHERE i.source_id = s.id) AS itemCount
       FROM news_source s ORDER BY s.sort`,
    )
    .all()
  return ok({ sources: sources.results })
})

news.post('/sources', async (c) => {
  const b = await c.req.json<{
    id?: string; name?: string; url?: string; category?: string; sort?: number
  }>()
  if (!b.id || !b.name || !b.url) throw new ApiError(400, 400, 'id/name/url required')
  await c.env.DB
    .prepare(
      `INSERT INTO news_source (id, name, type, url, category, sort, enabled)
       VALUES (?, ?, 'RSS', ?, ?, ?, 1)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, url = excluded.url,
         category = excluded.category, sort = excluded.sort`,
    )
    .bind(b.id, b.name, b.url, b.category ?? null, b.sort ?? 0)
    .run()
  // 任务：按源一行（已存在则不动）
  await c.env.DB
    .prepare(
      `INSERT INTO job (type, payload, cron, enabled, status, next_run_at)
       SELECT 'rss_fetch', json_object('sourceId', ?, 'url', ?), '0 0 */2 * * ?', 1, 'pending', 1
       WHERE NOT EXISTS (SELECT 1 FROM job WHERE type = 'rss_fetch' AND payload LIKE '%' || ? || '%')`,
    )
    .bind(b.id, b.url, b.id)
    .run()
  return ok({ id: b.id })
})

news.put('/sources/:id', async (c) => {
  const b = await c.req.json<{ enabled?: boolean; name?: string; url?: string; sort?: number }>()
  await c.env.DB
    .prepare(
      `UPDATE news_source SET
         enabled = COALESCE(?, enabled), name = COALESCE(?, name),
         url = COALESCE(?, url), sort = COALESCE(?, sort)
       WHERE id = ?`,
    )
    .bind(
      b.enabled === undefined ? null : (b.enabled ? 1 : 0),
      b.name ?? null, b.url ?? null, b.sort ?? null, c.req.param('id'),
    )
    .run()
  return ok(null)
})

news.delete('/sources/:id', async (c) => {
  const id = c.req.param('id')
  await c.env.DB.batch([
    c.env.DB.prepare(
      `DELETE FROM job WHERE type = 'rss_fetch' AND payload LIKE '%' || ? || '%'`,
    ).bind(id),
    c.env.DB.prepare('DELETE FROM news_source WHERE id = ?').bind(id),
  ])
  return ok(null)
})

// ---------- 屏蔽词 ----------

news.get('/blocks', async (c) => {
  const rows = await c.env.DB
    .prepare('SELECT id, keyword, source_id AS sourceId, enabled FROM news_block_word ORDER BY id')
    .all()
  return ok({ blocks: rows.results })
})

news.post('/blocks', async (c) => {
  const b = await c.req.json<{ keyword?: string; sourceId?: string }>()
  if (!b.keyword) throw new ApiError(400, 400, 'keyword required')
  const r = await c.env.DB
    .prepare('INSERT INTO news_block_word (keyword, source_id) VALUES (?, ?)')
    .bind(b.keyword, b.sourceId ?? '')
    .run()
  return ok({ id: r.meta.last_row_id })
})

news.delete('/blocks/:id', async (c) => {
  await c.env.DB.prepare('DELETE FROM news_block_word WHERE id = ?').bind(c.req.param('id')).run()
  return ok(null)
})
