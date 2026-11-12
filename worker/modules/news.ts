/** 资讯模块（原 wb_news_*）：列表 / 源管理 / 屏蔽词。正文消毒在浏览器端 DOMPurify（v3 决策 #9） */

import { Hono } from 'hono'
import type { Context } from 'hono'
import { ok, ApiError, type Env } from '../core/envelope'
import { normalizeCron, normalizeTargetKey } from '../core/node'
import { clampPublishedAt, normalizeAuthor, normalizeHtmlUrls, normalizeUrl } from '../core/ingest'

const PAGE_SIZE = 30

/**
 * rss_fetch 默认频率：每 2 小时整点。
 * 入库前必须归一化为标准 5 段——Quartz 的 `?` 在 croner 里会被替换成「解析时刻的日期分量」，
 * 曾把 next_run_at 排到 5 天后（issue #16）。这里保留 Quartz 写法但走 normalizeCron 落库。
 */
const RSS_CRON = normalizeCron('0 0 */2 * * ?')

export const news = new Hono<Env>()

// ---------- 列表 ----------

/** 列表与「全部标为已读」共用同一份筛选条件（issue #22）：口径必须一致，别各拼一份 WHERE */
interface NewsFilter {
  sourceId?: string | null
  category?: string | null
  q?: string | null
  unread?: boolean
}

function buildFilter(f: NewsFilter): {
  whereSql: string
  bind: (string | number)[]
  /** 至少有一个收窄条件（空筛选 = 「整个列表」这种大面积动作，批量已读要求显式 all:true） */
  scoped: boolean
} {
  const where: string[] = []
  const bind: (string | number)[] = []
  if (f.sourceId) {
    where.push('source_id = ?')
    bind.push(f.sourceId)
  }
  if (f.category) {
    where.push('source_id IN (SELECT id FROM news_source WHERE category = ?)')
    bind.push(f.category)
  }
  const q = (f.q ?? '').trim()
  if (q) {
    // 用户输入里的 % _ \ 当普通字符，别让 LIKE 通配符扩大命中范围
    const like = `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`
    where.push("(title LIKE ? ESCAPE '\\' OR content_html LIKE ? ESCAPE '\\')")
    bind.push(like, like)
  }
  if (f.unread) where.push('read_flag = 0')
  return { whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '', bind, scoped: where.length > 0 }
}

function filterFromQuery(c: Context<Env>): NewsFilter {
  return {
    sourceId: c.req.query('sourceId') || null,
    category: c.req.query('category') || null,
    q: c.req.query('q') || null,
    unread: c.req.query('unread') === '1',
  }
}

interface NewsListRow {
  id: number
  sourceId: string
  title: string | null
  link: string | null
  author: string | null
  publishedAt: number | null
  fetchedAt: number | null
  readFlag: number
  preview: string | null
}

interface NewsDetailRow {
  id: number
  title: string | null
  link: string | null
  author: string | null
  publishedAt: number | null
  fetchedAt: number | null
  readFlag: number
  contentHtml: string | null
  sourceName: string | null
}

/**
 * 历史数据兜底（issue #19）：入库清洗上线前的老行不改库，返回时走同一套函数——
 * 坏链 / 带邮箱作者 / 未来时间在列表和详情里都看不到。
 */
function normalizeListRow(r: NewsListRow): Omit<NewsListRow, 'fetchedAt'> {
  const link = normalizeUrl(r.link)
  return {
    id: r.id,
    sourceId: r.sourceId,
    title: r.title,
    link,
    author: normalizeAuthor(r.author),
    // 真实发布时刻不可能晚于抓取时刻：clamp 掉上游时区错标带来的未来时间
    publishedAt: clampPublishedAt(r.publishedAt, r.fetchedAt ?? Date.now()),
    readFlag: r.readFlag,
    preview: normalizeHtmlUrls(r.preview, link),
  }
}

function normalizeDetailRow(r: NewsDetailRow): Omit<NewsDetailRow, 'fetchedAt'> {
  const link = normalizeUrl(r.link)
  return {
    id: r.id,
    title: r.title,
    link,
    author: normalizeAuthor(r.author),
    publishedAt: clampPublishedAt(r.publishedAt, r.fetchedAt ?? Date.now()),
    readFlag: r.readFlag,
    contentHtml: normalizeHtmlUrls(r.contentHtml, link),
    sourceName: r.sourceName,
  }
}

news.get('/items', async (c) => {
  const page = Math.max(1, Number(c.req.query('page') ?? '1') || 1)
  const { whereSql, bind } = buildFilter(filterFromQuery(c))

  const [items, count, unread] = await Promise.all([
    c.env.DB
      .prepare(
        `SELECT id, source_id AS sourceId, title, link, author, published_at AS publishedAt,
                fetched_at AS fetchedAt, read_flag AS readFlag, substr(content_html, 1, 300) AS preview
         FROM news_item ${whereSql} ORDER BY published_at DESC, id DESC LIMIT ? OFFSET ?`,
      )
      .bind(...bind, PAGE_SIZE, (page - 1) * PAGE_SIZE)
      .all<NewsListRow>(),
    c.env.DB
      .prepare(`SELECT count(*) AS total FROM news_item ${whereSql}`)
      .bind(...bind)
      .first<{ total: number }>(),
    c.env.DB
      .prepare('SELECT count(*) AS n FROM news_item WHERE read_flag = 0')
      .first<{ n: number }>(),
  ])

  const total = count?.total ?? 0
  return ok({
    items: items.results.map(normalizeListRow),
    total,
    pages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
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
              i.fetched_at AS fetchedAt, i.read_flag AS readFlag, i.content_html AS contentHtml,
              s.name AS sourceName
       FROM news_item i LEFT JOIN news_source s ON s.id = i.source_id
       WHERE i.id = ?`,
    )
    .bind(c.req.param('id'))
    .first<NewsDetailRow>()
  if (!item) throw new ApiError(404, 404, 'not found')
  return ok({ item: normalizeDetailRow(item) })
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

/**
 * POST /read-all：把「当前筛选」的资讯一次性标为已读（issue #22）。
 * body 与列表查询参数同口径：{ sourceId?, category?, q?, unread?, all? }。
 * 空筛选等于「整个列表」，影响面最大：必须显式带 all:true（前端弹确认后才发），
 * 避免某个调用方漏传参数时把 533 条全部清成已读。
 */
news.post('/read-all', async (c) => {
  let body: { sourceId?: unknown; category?: unknown; q?: unknown; unread?: unknown; all?: unknown } = {}
  try {
    body = await c.req.json<typeof body>()
  } catch {
    /* 空 body 按「无筛选」处理，交给下面的 all:true 守卫 */
  }
  const filter: NewsFilter = {
    sourceId: typeof body.sourceId === 'string' ? body.sourceId : null,
    category: typeof body.category === 'string' ? body.category : null,
    q: typeof body.q === 'string' ? body.q : null,
    unread: body.unread === true || body.unread === 1,
  }
  const { whereSql, bind, scoped } = buildFilter(filter)
  if (!scoped && body.all !== true) throw new ApiError(400, 400, 'filters or all=true required')

  // 一条 UPDATE 打完，不按页循环
  const r = await c.env.DB
    .prepare(`UPDATE news_item SET read_flag = 1 ${whereSql}`)
    .bind(...bind)
    .run()
  return ok({ changed: r.meta.changes ?? 0 })
})


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
  // 任务：按源一行（已存在则不动）。
  // target_key（issue #4）= 规范化域名，同一站点的多个源共享「目标 × 节点」评分
  await c.env.DB
    .prepare(
      `INSERT INTO job (type, payload, cron, enabled, status, next_run_at, target_key)
       SELECT 'rss_fetch', json_object('sourceId', ?, 'url', ?), ?, 1, 'pending', 1, ?
       WHERE NOT EXISTS (SELECT 1 FROM job WHERE type = 'rss_fetch' AND payload LIKE '%' || ? || '%')`,
    )
    .bind(b.id, b.url, RSS_CRON, normalizeTargetKey(b.url), b.id)
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
  // 改了 URL：任务 payload 与 target_key 同步（否则评分会挂在旧域名上，抓取也还在用旧地址）
  if (b.url) {
    await c.env.DB
      .prepare(
        `UPDATE job SET payload = json_set(payload, '$.url', ?), target_key = ?
         WHERE type = 'rss_fetch' AND payload LIKE '%' || ? || '%'`,
      )
      .bind(b.url, normalizeTargetKey(b.url), id)
      .run()
  }
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
