/** 资讯模块（原 wb_news_*）：列表 / 源管理 / 屏蔽词。正文消毒在浏览器端 DOMPurify（v3 决策 #9） */

import { Hono } from 'hono'
import type { Context } from 'hono'
import { ok, ApiError, type Env } from '../core/envelope'
import { normalizeCron } from '../core/node'

const PAGE_SIZE = 30

/**
 * rss_fetch 默认频率：每 2 小时整点。
 * 入库前必须归一化为标准 5 段——Quartz 的 `?` 在 croner 里会被替换成「解析时刻的日期分量」，
 * 曾把 next_run_at 排到 5 天后（issue #16）。这里保留 Quartz 写法但走 normalizeCron 落库。
 */
const RSS_CRON = normalizeCron('0 0 */2 * * ?')

export const news = new Hono<Env>()

// ---------- 列表 ----------

news.get('/items', async (c) => {
  const page = Math.max(1, Number(c.req.query('page') ?? '1') || 1)
  const sourceId = c.req.query('sourceId') || null
  const onlyUnread = c.req.query('unread') === '1'

  // 条件按需拼，绑定值同序；只有未读筛选时走 idx_news_item_unread
  const where: string[] = []
  const bind: (string | number)[] = []
  if (sourceId) {
    where.push('source_id = ?')
    bind.push(sourceId)
  }
  if (onlyUnread) where.push('read_flag = 0')
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''

  const [items, count, unread] = await Promise.all([
    c.env.DB
      .prepare(
        `SELECT id, source_id AS sourceId, title, link, author, published_at AS publishedAt,
                read_flag AS readFlag, substr(content_html, 1, 300) AS preview
         FROM news_item ${whereSql} ORDER BY published_at DESC, id DESC LIMIT ? OFFSET ?`,
      )
      .bind(...bind, PAGE_SIZE, (page - 1) * PAGE_SIZE)
      .all(),
    c.env.DB
      .prepare(`SELECT count(*) AS total FROM news_item ${whereSql}`)
      .bind(...bind)
      .first<{ total: number }>(),
    c.env.DB
      .prepare('SELECT count(*) AS n FROM news_item WHERE read_flag = 0')
      .first<{ n: number }>(),
  ])

  return ok({
    items: items.results,
    total: count?.total ?? 0,
    unread: unread?.n ?? 0,
    page,
    pageSize: PAGE_SIZE,
  })
})

/** 详情（首页弹窗 / 资讯页共用）：正文原文返回，消毒仍在浏览器端 */
news.get('/items/:id', async (c) => {
  const item = await c.env.DB
    .prepare(
      `SELECT i.id, i.title, i.link, i.author, i.published_at AS publishedAt,
              i.read_flag AS readFlag, i.content_html AS contentHtml, s.name AS sourceName
       FROM news_item i LEFT JOIN news_source s ON s.id = i.source_id
       WHERE i.id = ?`,
    )
    .bind(c.req.param('id'))
    .first()
  if (!item) throw new ApiError(404, 404, 'not found')
  return ok({ item })
})

// ---------- 已读状态 ----------

/** POST /read | /unread，body { ids: [1,2,3] } */
async function setReadFlag(c: Context<Env>, read: boolean): Promise<Response> {
  let body: { ids?: unknown } = {}
  try {
    body = await c.req.json<{ ids?: unknown }>()
  } catch {
    /* 空 body 按 ids 缺失处理 */
  }
  const ids = Array.isArray(body.ids)
    ? body.ids.map(Number).filter((n) => Number.isInteger(n) && n > 0)
    : []
  if (!ids.length) throw new ApiError(400, 400, 'ids required')
  if (ids.length > 200) throw new ApiError(400, 400, 'too many ids')

  const marks = ids.map(() => '?').join(',')
  const r = await c.env.DB
    .prepare(`UPDATE news_item SET read_flag = ? WHERE id IN (${marks})`)
    .bind(read ? 1 : 0, ...ids)
    .run()
  return ok({ changed: r.meta.changes, readFlag: read })
}

news.post('/read', (c) => setReadFlag(c, true))
news.post('/unread', (c) => setReadFlag(c, false))

// ---------- 订阅源 ----------

news.get('/sources', async (c) => {
  // 顺带带出抓取任务状态（上次运行 / 连续失败 / 是否被熔断暂停），资讯页顶部提示与订阅源弹窗共用
  const sources = await c.env.DB
    .prepare(
      `SELECT s.id, s.name, s.type, s.url, s.category, s.sort, s.enabled,
              (SELECT count(*) FROM news_item i WHERE i.source_id = s.id) AS itemCount,
              j.last_run_at AS lastRunAt, j.fail_streak AS failStreak,
              j.enabled AS jobEnabled, j.status AS jobStatus, j.result AS lastError
       FROM news_source s
       LEFT JOIN job j ON j.id = (
         SELECT jj.id FROM job jj
         WHERE jj.type = 'rss_fetch' AND jj.payload LIKE '%"sourceId":"' || s.id || '"%'
         ORDER BY jj.id LIMIT 1
       )
       ORDER BY s.sort`,
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
       SELECT 'rss_fetch', json_object('sourceId', ?, 'url', ?), ?, 1, 'pending', 1
       WHERE NOT EXISTS (SELECT 1 FROM job WHERE type = 'rss_fetch' AND payload LIKE '%' || ? || '%')`,
    )
    .bind(b.id, b.url, RSS_CRON, b.id)
    .run()
  return ok({ id: b.id })
})

news.put('/sources/:id', async (c) => {
  const b = await c.req.json<{ enabled?: boolean; name?: string; url?: string; sort?: number }>()
  const id = c.req.param('id')
  await c.env.DB
    .prepare(
      `UPDATE news_source SET
         enabled = COALESCE(?, enabled), name = COALESCE(?, name),
         url = COALESCE(?, url), sort = COALESCE(?, sort)
       WHERE id = ?`,
    )
    .bind(
      b.enabled === undefined ? null : (b.enabled ? 1 : 0),
      b.name ?? null, b.url ?? null, b.sort ?? null, id,
    )
    .run()
  // 抓取任务跟随订阅源开关；重新启用 = 解除熔断（清零连败、立即到期）。
  // leased 的行保持原样：正在跑的这一次交给 complete/fail 自己收尾，避免 409 丢结果。
  if (b.enabled === true) {
    await c.env.DB
      .prepare(
        `UPDATE job SET enabled = 1,
           status = CASE WHEN status IN ('failed', 'done') THEN 'pending' ELSE status END,
           attempts = CASE WHEN status = 'leased' THEN attempts ELSE 0 END,
           fail_streak = CASE WHEN status = 'leased' THEN fail_streak ELSE 0 END,
           next_run_at = CASE WHEN status = 'leased' THEN next_run_at ELSE ? END,
           lease_until = CASE WHEN status = 'leased' THEN lease_until ELSE NULL END,
           node_id = CASE WHEN status = 'leased' THEN node_id ELSE NULL END
         WHERE type = 'rss_fetch' AND payload LIKE '%' || ? || '%'`,
      )
      .bind(Date.now(), id)
      .run()
  } else if (b.enabled === false) {
    await c.env.DB
      .prepare(`UPDATE job SET enabled = 0 WHERE type = 'rss_fetch' AND payload LIKE '%' || ? || '%'`)
      .bind(id)
      .run()
  }
  return ok(null)
})

news.delete('/sources/:id', async (c) => {
  const id = c.req.param('id')
  // 同批删源 + 该源历史文章 + 抓取任务：无外键，避免留下孤儿 news_item
  await c.env.DB.batch([
    c.env.DB.prepare(
      `DELETE FROM job WHERE type = 'rss_fetch' AND payload LIKE '%' || ? || '%'`,
    ).bind(id),
    c.env.DB.prepare('DELETE FROM news_item WHERE source_id = ?').bind(id),
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
  const keyword = b.keyword.trim()
  const sourceId = b.sourceId ?? ''
  // (keyword, source_id) 唯一索引（0002）：重复提交不报错，直接回已有 id
  const r = await c.env.DB
    .prepare('INSERT OR IGNORE INTO news_block_word (keyword, source_id) VALUES (?, ?)')
    .bind(keyword, sourceId)
    .run()
  if (r.meta.changes === 0) {
    const row = await c.env.DB
      .prepare('SELECT id FROM news_block_word WHERE keyword = ? AND source_id = ?')
      .bind(keyword, sourceId)
      .first<{ id: number }>()
    return ok({ id: row?.id ?? 0 })
  }
  return ok({ id: r.meta.last_row_id })
})

news.delete('/blocks/:id', async (c) => {
  await c.env.DB.prepare('DELETE FROM news_block_word WHERE id = ?').bind(c.req.param('id')).run()
  return ok(null)
})
