/** 结果入库映射（v4.2「泛化任务类型」）：新数据源 = 新增 ingest + D1 加行，agent 永远只回传通用 items */
// 幂等一律靠业务表唯一约束 + ON CONFLICT DO NOTHING（天然断点续传）

/* ---------------- 资讯字段归一化（issue #19） ----------------
 * 新数据在 ingest 入库前统一清洗；历史数据由 modules/news.ts 在返回前用同一组函数兜底。
 * 只在 Worker 侧写一份，agent 不做同样的清洗（避免两边规则漂移）。
 * 不做重型 HTML 解析：只处理明确的坏链（叠加协议 / 协议相对 / 相对路径）。
 */

/** 非 http(s) 的 URI（data:/mailto: 等）：原样保留，交给浏览器端 DOMPurify 兜底 */
const NON_HTTP_URI = /^(?:data|blob|mailto|tel|javascript|about|ftp):/i
/** 形如 host.tld/… 、IPv4:port/… 、localhost:port/… 的「有 host 但缺协议」片段（要求带路径，避免把 `img.2026.png` 当域名） */
const HOST_LIKE = [
  /^(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?[/?#]/i,
  /^www\.[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?(?:[/?#]|$)/i,
  /^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?(?:[/?#]|$)/,
  /^localhost(?::\d+)?(?:[/?#]|$)/i,
]

/**
 * 剥掉叠在外层的协议壳：`https:https://x` / `https://https://x` / `//x`。
 * 返回 core（去掉协议与 host 前斜杠后的剩余部分）与「原来有几层」。
 */
function stripSchemeLayers(raw: string): { core: string; layers: number; https: boolean; hadScheme: boolean } {
  let rest = raw
  let layers = 0
  let https = false
  let hadScheme = false
  for (;;) {
    const m = /^(https?):/i.exec(rest)
    if (m) {
      if (/^https$/i.test(m[1] ?? '')) https = true
      hadScheme = true
      rest = rest.slice(m[0].length)
      if (rest.startsWith('//')) rest = rest.slice(2)
      else if (rest.startsWith('/')) rest = rest.slice(1)
      layers++
      continue
    }
    if (rest.startsWith('//')) {
      rest = rest.slice(2)
      layers++
      continue
    }
    break
  }
  return { core: rest, layers, https, hadScheme }
}

/**
 * URL 归一化：`https:https://x` → `https://x`；`//host/x` → `https://host/x`；
 * 相对路径按 base（文章 link）解析成绝对地址。
 * 只叠了一层 `http://` 的保持 http（老站点可能没有 TLS），叠壳 / 协议相对统一收敛成 https。
 */
export function normalizeUrl(raw?: string | null, base?: string | null): string | null {
  if (typeof raw !== 'string') return null
  const raw0 = raw.trim()
  if (!raw0) return null
  if (NON_HTTP_URI.test(raw0)) return raw0
  if (raw0.startsWith('#')) return raw0 // 页内锚点不要绝对化

  const { core, layers, https, hadScheme } = stripSchemeLayers(raw0)
  if (!core) return null

  // layers>0 且没有协议 = 本来就写成 //host/x（协议相对），一定是绝对地址
  if (hadScheme || layers > 0 || HOST_LIKE.some((re) => re.test(core))) {
    const scheme = https || !hadScheme || layers > 1 ? 'https:' : 'http:'
    return `${scheme}//${core}`
  }
  // 相对路径：按文章 link 解析；没有可用 base 时原样返回（浏览器会按站点根解析，聊胜于无）
  if (base) {
    try {
      return new URL(core, base).href
    } catch {
      /* base 不是合法绝对地址：退回相对写法 */
    }
  }
  return core
}

/**
 * 正文 HTML 里的链接 / 图片统一归一化：只重写 URL 属性（src/href/poster/data-*），
 * 不做 DOM 解析。顺带把正文里裸写的叠壳协议（`https:https://…`）收敛掉。
 */
export function normalizeHtmlUrls(html?: string | null, base?: string | null): string | null {
  if (typeof html !== 'string' || !html) return html ?? null
  return html
    .replace(/(?:https?:){2,}(?=\/\/)/gi, 'https:')
    .replace(
      /(\b(?:src|href|poster|data-src|data-original)\s*=\s*)(["'])([\s\S]*?)\2/gi,
      (match, pre: string, quote: string, url: string) => {
        const fixed = normalizeUrl(url, base)
        return fixed && fixed !== url ? `${pre}${quote}${fixed}${quote}` : match
      },
    )
}

/**
 * 作者清洗：去掉邮箱段，保留它后面括号里的可读信息。
 * `界面新闻 · jianli@jiemian.com(界面快报)` → `界面新闻 · 界面快报`
 * 只有邮箱 / 洗成空串 → null。
 */
export function normalizeAuthor(raw?: string | null): string | null {
  if (typeof raw !== 'string') return null
  let s = raw.replace(/\s+/g, ' ').trim()
  if (!s) return null
  s = s.replace(
    /\s*[·•|,，、/\-]?\s*[\w.!#$%&'*+/=?^`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+\s*(?:[（(]([^（()）]{1,40})[)）])?/gi,
    (_m: string, paren?: string) => (paren ? ` · ${paren}` : ''),
  )
  s = s.replace(/[（(]\s*[)）]/g, '') // 邮箱在括号里时留下的空括号
  s = s.replace(/\s*[·•|]\s*/g, ' · ')
  s = s.replace(/(?:\s*·\s*){2,}/g, ' · ')
  s = s.replace(/^[\s·•|,，、/\-]+|[\s·•|,，、/\-]+$/g, '')
  s = s.replace(/\s{2,}/g, ' ').trim()
  return s || null
}

/**
 * 发布时间兜底：上游把本地时间标成 GMT（InfoQ 北京 +8h）会让 pubDate 落在未来，
 * 直接按源写 -8h 会误伤正常源，统一 clamp 到抓取时刻即可。
 */
export function clampPublishedAt(publishedAt?: number | null, now?: number | null): number | null {
  if (typeof publishedAt !== 'number' || !Number.isFinite(publishedAt) || publishedAt <= 0) return null
  const ceiling = typeof now === 'number' && Number.isFinite(now) && now > 0 ? now : Date.now()
  return Math.min(publishedAt, ceiling)
}

interface RssItem {
  externalId: string
  title?: string
  link?: string
  author?: string
  publishedAt?: number
  contentHtml?: string
}

function asRssItem(item: unknown): RssItem | null {
  if (typeof item !== 'object' || item === null) return null
  const it = item as Record<string, unknown>
  if (typeof it.externalId !== 'string' || !it.externalId) return null
  return {
    externalId: it.externalId,
    title: typeof it.title === 'string' ? it.title : undefined,
    link: typeof it.link === 'string' ? it.link : undefined,
    author: typeof it.author === 'string' ? it.author : undefined,
    publishedAt: typeof it.publishedAt === 'number' ? it.publishedAt : undefined,
    contentHtml: typeof it.contentHtml === 'string' ? it.contentHtml : undefined,
  }
}

/** 单条资讯入库前清洗：link / author / publishedAt / 正文里的图片与链接 */
function normalizeRssItem(r: RssItem, now: number): RssItem {
  const link = normalizeUrl(r.link)
  return {
    ...r,
    link: link ?? undefined,
    author: normalizeAuthor(r.author) ?? undefined,
    publishedAt: clampPublishedAt(r.publishedAt, now) ?? undefined,
    contentHtml: normalizeHtmlUrls(r.contentHtml, link) ?? undefined,
  }
}

interface StockItem {
  code: string
  tradeDate: string
  open?: number | null
  high?: number | null
  low?: number | null
  close?: number | null
  volume?: number | null
}

function asStockItem(item: unknown): StockItem | null {
  if (typeof item !== 'object' || item === null) return null
  const it = item as Record<string, unknown>
  if (typeof it.code !== 'string' || !/^(sh|sz|bj)\d{6}$/.test(it.code)) return null
  if (typeof it.tradeDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(it.tradeDate)) return null
  return {
    code: it.code,
    tradeDate: it.tradeDate,
    open: numOrNull(it.open), high: numOrNull(it.high), low: numOrNull(it.low),
    close: numOrNull(it.price) ?? numOrNull(it.close), volume: numOrNull(it.volume),
  }
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

interface ZsxqGroupItem {
  groupId: string
  name?: string | null
}

function asZsxqGroupItem(item: unknown): ZsxqGroupItem | null {
  if (typeof item !== 'object' || item === null) return null
  const it = item as Record<string, unknown>
  if (typeof it.groupId !== 'string' || !it.groupId) return null
  return {
    groupId: it.groupId,
    name: typeof it.name === 'string' && it.name ? it.name : null,
  }
}

interface ZsxqItem {
  topicId: string
  groupId: string
  groupName?: string | null
  title?: string | null
  talkText?: string | null
  images?: Array<{ u: string; w?: number | null; h?: number | null }> | null
  files?: Array<{ name: string; size: number }> | null
  createTime?: number | null
}

function asZsxqItem(item: unknown): ZsxqItem | null {
  if (typeof item !== 'object' || item === null) return null
  const it = item as Record<string, unknown>
  if (typeof it.topicId !== 'string' || typeof it.groupId !== 'string') return null
  return {
    topicId: it.topicId,
    groupId: it.groupId,
    groupName: typeof it.groupName === 'string' && it.groupName ? it.groupName : null,
    title: typeof it.title === 'string' ? it.title : null,
    talkText: typeof it.talkText === 'string' ? it.talkText : null,
    images: Array.isArray(it.images) ? it.images : null,
    files: Array.isArray(it.files) ? it.files : null,
    createTime: typeof it.createTime === 'number' ? it.createTime : null,
  }
}

/** 按任务类型入库；返回插入行数。未注册类型返回 null（调用方按 fail 处理） */
export async function ingest(
  db: D1Database,
  type: string,
  payload: Record<string, unknown>,
  items: unknown[],
  now: number,
): Promise<number | null> {
  if (type === 'rss_fetch') {
    const sourceId = typeof payload.sourceId === 'string' ? payload.sourceId : null
    if (!sourceId) return null
    const rows = items
      .map(asRssItem)
      .filter((r): r is RssItem => r !== null)
      .map((r) => normalizeRssItem(r, now))
    if (!rows.length) return 0
    const results = await db.batch(
      rows.map((r) =>
        db
          .prepare(
            `INSERT INTO news_item (source_id, external_id, title, link, author, published_at, content_html, fetched_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (source_id, external_id) DO NOTHING`,
          )
          .bind(sourceId, r.externalId, r.title ?? null, r.link ?? null, r.author ?? null, r.publishedAt ?? null, r.contentHtml ?? null, now),
      ),
    )
    return results.reduce((n, r) => n + (r.meta.changes ?? 0), 0)
  }
  if (type === 'stock_eod') {
    const rows = items.map(asStockItem).filter((r): r is StockItem => r !== null)
    if (!rows.length) return 0
    const results = await db.batch(
      rows.map((r) =>
        db
          .prepare(
            `INSERT INTO stock_daily (code, trade_date, open, high, low, close, volume, fetched_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (code, trade_date) DO UPDATE SET
               open = excluded.open, high = excluded.high, low = excluded.low,
               close = excluded.close, volume = excluded.volume, fetched_at = excluded.fetched_at`,
          )
          .bind(r.code, r.tradeDate, r.open, r.high, r.low, r.close, r.volume, now),
      ),
    )
    return results.reduce((n, r) => n + (r.meta.changes ?? 0), 0)
  }
  if (type === 'zsxq_groups') {
    // 星球列表（勾选同步目标用）：只更新名字，不碰 enabled（勾选状态由 /api/zsxq/job 维护）
    const rows = items.map(asZsxqGroupItem).filter((r): r is ZsxqGroupItem => r !== null)
    if (!rows.length) return 0
    const results = await db.batch(
      rows.map((r) =>
        db
          .prepare(
            `INSERT INTO zsxq_group (id, name, enabled) VALUES (?, ?, 0)
             ON CONFLICT (id) DO UPDATE SET name = COALESCE(excluded.name, name)`,
          )
          .bind(r.groupId, r.name),
      ),
    )
    return results.reduce((n, r) => n + (r.meta.changes ?? 0), 0)
  }
  if (type === 'zsxq_sync') {
    const rows = items.map(asZsxqItem).filter((r): r is ZsxqItem => r !== null)
    if (!rows.length) return 0
    await db.batch([
      // 星球名随 items 捎带（agent 同步时顺带查 groups.list）；缺失时保留旧名
      ...rows.map((r) =>
        db
          .prepare(
            `INSERT INTO zsxq_group (id, name) VALUES (?, ?)
             ON CONFLICT (id) DO UPDATE SET name = COALESCE(excluded.name, name)`,
          )
          .bind(r.groupId, r.groupName),
      ),
      ...rows.map((r) =>
        db
          .prepare(
            `INSERT INTO zsxq_topic (id, group_id, title, talk_text, images, files, create_time, fetched_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (id) DO UPDATE SET
               title = excluded.title, talk_text = excluded.talk_text, images = excluded.images,
               files = excluded.files, create_time = excluded.create_time, fetched_at = excluded.fetched_at`,
          )
          .bind(
            r.topicId, r.groupId, r.title, r.talkText,
            r.images ? JSON.stringify(r.images) : null,
            r.files ? JSON.stringify(r.files) : null,
            r.createTime, now,
          ),
      ),
    ])
    return rows.length
  }
  return null // unknown type：Worker 先升级 / agent 先升级窗口的安全兜底（验收场景 #5）
}
