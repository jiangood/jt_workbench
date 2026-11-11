/**
 * 书架：豆瓣索引建条目（可先不传文件，有资源后再上传）+ epub/pdf/txt 上传 + 分组 / 阅读状态
 * 分组沿用 category 列（自由文本，NULL = 未分组），与自选股 group_name 同语义
 * 封面经 Worker 代理（豆瓣图床带 Referer 防盗链，直连 418）
 */

import { Hono, type Context } from 'hono'
import { ok, ApiError, type Env } from '../core/envelope'
import { putFile, deleteFile, serveFile } from '../core/files'
import { cacheGet, cacheSet } from '../core/cache'

export const book = new Hono<Env>()

const STATUSES = ['unread', 'reading', 'read'] as const
type Status = (typeof STATUSES)[number]

const MAX_TITLE = 200
const MAX_AUTHOR = 120
const MAX_CATEGORY = 50
const MAX_SUMMARY = 1200

const DOUBAN_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const DOUBAN_REFERER = 'https://book.douban.com/'
const DOUBAN_IMAGE_HOSTS = /(^|\.)doubanio\.com$/i

interface BookRow {
  id: number
  title: string
  author: string | null
  category: string | null
  status: Status
  cover: string | null
  summary: string | null
  rating: number | null
  pub_year: string | null
  douban_id: string | null
  douban_url: string | null
  fmt: string | null
  r2_key: string | null
  filename: string | null
  size: number | null
  created_at: number
  updated_at: number
  finished_at: number | null
}

// ---------- 列表 ----------

book.get('/list', async (c) => {
  const rows = await c.env.DB
    .prepare(
      `SELECT id, title, author, category, status, cover, summary, rating, pub_year AS pubYear,
              douban_id AS doubanId, douban_url AS doubanUrl, fmt, filename, size,
              CASE WHEN r2_key IS NOT NULL THEN 1 ELSE 0 END AS hasFile,
              -- 文件版本 = R2 key 里的 uuid：只有换文件才变（改书名 / 阅读状态不动），缓存才不会被无谓作废
              substr(r2_key, 6, 36) AS fileVersion,
              created_at AS createdAt, updated_at AS updatedAt, finished_at AS finishedAt
         FROM book
        ORDER BY CASE status WHEN 'reading' THEN 0 WHEN 'unread' THEN 1 ELSE 2 END, updated_at DESC`,
    )
    .all()
  return ok({ books: rows.results })
})

// ---------- 豆瓣索引（搜索 / 详情 / 同步） ----------

book.get('/search', async (c) => {
  const q = (c.req.query('q') ?? '').trim().slice(0, 50)
  if (!q) return ok({ items: [] })

  const items = await doubanSuggest(c.env.DB, q)
  const rows = await c.env.DB
    .prepare('SELECT douban_id AS doubanId FROM book WHERE douban_id IS NOT NULL')
    .all<{ doubanId: string }>()
  const added = new Set(rows.results.map((r) => r.doubanId))
  return ok({ items: items.map((x) => ({ ...x, added: added.has(x.doubanId) })) })
})

/** 条目详情：标题 / 作者 / 封面 / 评分 / 简介（可选增强，抓不到不影响添加） */
book.get('/douban/:id', async (c) => {
  const id = c.req.param('id')
  if (!/^\d+$/.test(id)) throw new ApiError(400, 400, '无效的豆瓣 ID')
  const detail = (await doubanSubject(c.env.DB, id)) ?? {
    title: null,
    author: null,
    cover: null,
    rating: null,
    summary: null,
    pubYear: null,
  }
  return ok({ detail })
})

// ---------- 新增 / 编辑 ----------

book.post('/add', async (c) => {
  const b = await readJson(c)
  const title = text(b.title, MAX_TITLE)
  if (!title) throw new ApiError(400, 400, '书名必填')

  const doubanId = text(b.doubanId, 32)
  if (doubanId && !/^\d+$/.test(doubanId)) throw new ApiError(400, 400, '无效的豆瓣 ID')
  if (doubanId) {
    const dup = await c.env.DB
      .prepare('SELECT id FROM book WHERE douban_id = ?')
      .bind(doubanId)
      .first<{ id: number }>()
    if (dup) throw new ApiError(409, 409, '这本书已在书架里')
  }

  const now = Date.now()
  const status = normalizeStatus(b.status)
  const rating = normalizeRating(b.rating)
  const r = await c.env.DB
    .prepare(
      `INSERT INTO book (title, author, category, status, cover, summary, rating, pub_year,
                         douban_id, douban_url, created_at, updated_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      title,
      text(b.author, MAX_AUTHOR),
      text(b.category, MAX_CATEGORY),
      status,
      coverUrl(b.cover),
      text(b.summary, MAX_SUMMARY),
      rating,
      text(b.pubYear, 20),
      doubanId,
      httpUrl(b.doubanUrl),
      now,
      now,
      status === 'read' ? now : null,
    )
    .run()
  return ok({ id: r.meta.last_row_id })
})

book.patch('/:id', async (c) => {
  const id = c.req.param('id')
  const row = await c.env.DB.prepare('SELECT * FROM book WHERE id = ?').bind(id).first<BookRow>()
  if (!row) throw new ApiError(404, 404, '书不存在')

  const b = await readJson(c)
  const sets: string[] = []
  const values: unknown[] = []
  const set = (column: string, value: unknown) => {
    sets.push(`${column} = ?`)
    values.push(value)
  }

  if ('title' in b) {
    const title = text(b.title, MAX_TITLE)
    if (!title) throw new ApiError(400, 400, '书名不能为空')
    set('title', title)
  }
  if ('author' in b) set('author', text(b.author, MAX_AUTHOR))
  if ('category' in b) set('category', text(b.category, MAX_CATEGORY))
  if ('cover' in b) set('cover', coverUrl(b.cover))
  if ('summary' in b) set('summary', text(b.summary, MAX_SUMMARY))
  if ('rating' in b) set('rating', normalizeRating(b.rating))
  if ('pubYear' in b) set('pub_year', text(b.pubYear, 20))
  if ('status' in b) {
    const status = normalizeStatus(b.status)
    set('status', status)
    set('finished_at', status === 'read' ? (row.finished_at ?? Date.now()) : null)
  }

  if (!sets.length) return ok(null)
  set('updated_at', Date.now())
  await c.env.DB
    .prepare(`UPDATE book SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...values, id)
    .run()
  return ok(null)
})

/** 单本手动同步豆瓣信息：已关联按 ID 拉取，未关联按书名搜第一条；分组与阅读状态不动 */
book.post('/:id/sync', async (c) => {
  const row = await c.env.DB.prepare('SELECT * FROM book WHERE id = ?').bind(c.req.param('id')).first<BookRow>()
  if (!row) throw new ApiError(404, 404, '书不存在')
  return ok(await doubanSync(c.env.DB, row, false))
})

// ---------- 上传 / 阅读 / 删除 ----------

book.post('/upload', async (c) => {
  const filename = c.req.query('filename')
  if (!filename) throw new ApiError(400, 400, 'filename required')
  if (!c.req.raw.body) throw new ApiError(400, 400, 'empty body')

  const fmt = /\.pdf$/i.test(filename)
    ? 'pdf'
    : /\.epub$/i.test(filename)
      ? 'epub'
      : /\.txt$/i.test(filename)
        ? 'txt'
        : null
  if (!fmt) throw new ApiError(400, 400, '仅支持 epub / pdf / txt')

  const bookId = c.req.query('bookId')
  const existing = bookId
    ? await c.env.DB.prepare('SELECT * FROM book WHERE id = ?').bind(bookId).first<BookRow>()
    : null
  if (bookId && !existing) throw new ApiError(404, 404, '书不存在')

  const now = Date.now()
  const stored = await putFile(c.env, 'book', filename, c.req.raw.headers.get('content-type'), c.req.raw.body)
  let id: number
  try {
    if (existing) {
      await c.env.DB
        .prepare('UPDATE book SET fmt = ?, r2_key = ?, filename = ?, size = ?, updated_at = ? WHERE id = ?')
        .bind(fmt, stored.key, filename, stored.size, now, existing.id)
        .run()
      id = existing.id
    } else {
      const title = titleFromFilename(filename, c.req.query('title'))
      const author = c.req.query('author')?.trim() || null
      const category = c.req.query('category')?.trim() || null
      const status = normalizeStatus(c.req.query('status'))
      const r = await c.env.DB
        .prepare(
          `INSERT INTO book (title, author, category, status, fmt, r2_key, filename, size,
                             created_at, updated_at, finished_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          title.slice(0, MAX_TITLE),
          author?.slice(0, MAX_AUTHOR) ?? null,
          category?.slice(0, MAX_CATEGORY) ?? null,
          status,
          fmt,
          stored.key,
          filename,
          stored.size,
          now,
          now,
          status === 'read' ? now : null,
        )
        .run()
      id = Number(r.meta.last_row_id)
    }
  } catch (err) {
    // 入库失败：清掉刚写的 R2，避免孤儿文件
    await deleteFile(c.env, stored.key).catch(() => {})
    throw err
  }

  // 覆盖旧文件：新文件入库成功后再删旧 key
  if (existing?.r2_key) await deleteFile(c.env, existing.r2_key).catch(() => {})

  // 上传完成即补豆瓣信息（还没关联豆瓣条目时自动匹一次；匹配不到不影响上传结果）
  let douban: { title: string; doubanId: string } | null = null
  if (!existing?.douban_id) {
    const row = await c.env.DB.prepare('SELECT * FROM book WHERE id = ?').bind(id).first<BookRow>()
    if (row) douban = await autoSyncDouban(c.env.DB, row)
  }

  return ok({ id, size: stored.size, douban })
})

/** 阅读/下载（Range 透传：epub.js 分段读、浏览器 PDF 渐进加载）；带上原始文件名，下载不走 /read/:id */
book.get('/read/:id', async (c) => {
  const started = performance.now()
  const row = await c.env.DB
    .prepare('SELECT r2_key, filename, fmt FROM book WHERE id = ?')
    .bind(c.req.param('id'))
    .first<{ r2_key: string | null; filename: string | null; fmt: string | null }>()
  if (!row) throw new ApiError(404, 404, 'not found')
  if (!row.r2_key) throw new ApiError(404, 404, '这本书还没有上传文件')
  return serveFile(c.env, row.r2_key, c.req.raw, downloadName(row.filename, row.fmt), {
    timings: [['db', performance.now() - started]],
  })
})

book.delete('/:id', async (c) => {
  const row = await c.env.DB
    .prepare('SELECT r2_key FROM book WHERE id = ?')
    .bind(c.req.param('id'))
    .first<{ r2_key: string | null }>()
  if (row?.r2_key) await deleteFile(c.env, row.r2_key)
  await c.env.DB.prepare('DELETE FROM book WHERE id = ?').bind(c.req.param('id')).run()
  return ok(null)
})

/** 封面代理：豆瓣图床校验 Referer，直连会 418；其他外链也由 Worker 代取并长缓存（带 SSRF 防护） */
book.get('/cover', async (c) => {
  const target = parseCoverUrl(c.req.query('url') ?? '')
  const headers: Record<string, string> = { 'user-agent': DOUBAN_UA, accept: 'image/*' }
  if (DOUBAN_IMAGE_HOSTS.test(target.hostname)) headers.referer = DOUBAN_REFERER

  const res = await fetch(target.toString(), { headers, signal: AbortSignal.timeout(10_000) }).catch((err) => {
    throw new ApiError(502, 502, `封面加载失败：${err instanceof Error ? err.message : '网络错误'}`)
  })
  if (!res.ok) throw new ApiError(502, 502, `封面加载失败：HTTP ${res.status}`)
  const type = res.headers.get('content-type') || ''
  const imageType = /^image\//i.test(type) ? type : guessImageType(target.pathname)
  if (!imageType) throw new ApiError(502, 502, '封面地址不是图片')
  const out = new Headers()
  out.set('content-type', imageType)
  out.set('cache-control', 'public, max-age=604800')
  out.set('x-content-type-options', 'nosniff')
  out.set('content-security-policy', "default-src 'none'; sandbox")
  return new Response(res.body, { headers: out })
})

// ---------- 单本详情 ----------

/** 阅读页按 id 取单本：字段与 /list 对齐，避免为打开一本书下发整张书架 */
// 注册在 /list、/search、/cover 之后：GET /:id 不会抢先命中这些具体路径
book.get('/:id', async (c) => {
  const row = await c.env.DB
    .prepare(
      `SELECT id, title, author, category, status, cover, summary, rating, pub_year AS pubYear,
              douban_id AS doubanId, douban_url AS doubanUrl, fmt, filename, size,
              CASE WHEN r2_key IS NOT NULL THEN 1 ELSE 0 END AS hasFile,
              substr(r2_key, 6, 36) AS fileVersion,
              created_at AS createdAt, updated_at AS updatedAt, finished_at AS finishedAt
         FROM book
        WHERE id = ?`,
    )
    .bind(c.req.param('id'))
    .first()
  if (!row) throw new ApiError(404, 404, '书不存在')
  return ok({ book: row })
})

// ---------- 辅助 ----------

async function readJson(c: Context<Env>): Promise<Record<string, unknown>> {
  try {
    const body = await c.req.json<unknown>()
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('not object')
    return body as Record<string, unknown>
  } catch {
    throw new ApiError(400, 400, '无效的 JSON')
  }
}

interface DoubanSearchItem {
  doubanId: string
  title: string
  author: string | null
  year: string | null
  cover: string | null
  url: string | null
}

interface DoubanInfo {
  doubanId: string
  title: string | null
  author: string | null
  cover: string | null
  rating: number | null
  summary: string | null
  pubYear: string | null
  url: string
}

/**
 * 豆瓣同步核心：已关联按 ID 拉取，未关联按书名搜；`auto` 时只认标题能对上的首条结果（上传后自动匹配，
 * 宁可留空也不挂错条目）。分组与阅读状态不动；找不到 / 已被别的书占用一律抛 ApiError。
 */
async function doubanSync(
  db: D1Database,
  row: BookRow,
  auto: boolean,
): Promise<{ title: string; doubanId: string }> {
  let doubanId = row.douban_id
  if (!doubanId) {
    const items = await doubanSuggest(db, row.title)
    const hit = auto ? (titleMatches(items[0]?.title ?? '', row.title) ? items[0] : null) : items[0]
    doubanId = hit?.doubanId ?? null
    if (!doubanId) {
      throw new ApiError(404, 404, auto ? '豆瓣没有匹配到同名条目' : '豆瓣没有找到匹配条目，可先编辑书名再试')
    }
  }

  const dup = await db
    .prepare('SELECT id FROM book WHERE douban_id = ? AND id <> ?')
    .bind(doubanId, row.id)
    .first<{ id: number }>()
  if (dup) throw new ApiError(409, 409, '该豆瓣条目已关联到另一本书')

  const info = await doubanSubject(db, doubanId)
  if (!info?.title) throw new ApiError(502, 502, '豆瓣信息获取失败，请稍后再试')

  await db
    .prepare(
      `UPDATE book SET title = ?, author = ?, cover = ?, summary = ?, rating = ?, pub_year = ?,
                       douban_id = ?, douban_url = ?, updated_at = ?
        WHERE id = ?`,
    )
    .bind(
      info.title,
      info.author ?? row.author,
      info.cover ?? row.cover,
      info.summary ?? row.summary,
      info.rating ?? row.rating,
      info.pubYear ?? row.pub_year,
      doubanId,
      info.url,
      Date.now(),
      row.id,
    )
    .run()
  return { title: info.title, doubanId }
}

/** 上传后自动匹配：匹配不到 / 出错 / 豆瓣太慢（15s 上限）都只当没有，不拖住上传响应 */
async function autoSyncDouban(
  db: D1Database,
  row: BookRow,
): Promise<{ title: string; doubanId: string } | null> {
  const task = doubanSync(db, row, true).catch(() => null)
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 15_000))
  return Promise.race([task, timeout])
}

/** 自动匹配的书名比对：归一化后相等，或短标题在分隔符处结束的包含关系（epub 带副标题 / 版次） */
function titleMatches(doubanTitle: string, localTitle: string): boolean {
  const a = normalizeTitle(doubanTitle)
  const b = normalizeTitle(localTitle)
  if (!a || !b) return false
  if (a === b) return true
  return separatedPrefix(doubanTitle, localTitle) || separatedPrefix(localTitle, doubanTitle)
}

/** short 是 long 的开头一段，且 long 里紧跟分隔符（：/ （/ · 等），避免「三体」误配「三体Ⅱ·黑暗森林」 */
function separatedPrefix(short: string, long: string): boolean {
  const s = softTitle(short)
  if (s.length < 2) return false
  const l = softTitle(long)
  if (!l.startsWith(s)) return false
  return /^[\s:·•,，.。、;；/|\\\-–—_+~([【《<「『"'“‘]/.test(l.slice(s.length))
}

/** 只统一全半角 / 大小写 / 空白，保留分隔符与括号内容（比对用） */
function softTitle(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()
}

/** 去掉空白 / 标点 / 符号后比对（忽略“全集”“精装”之类标点差异） */
function normalizeTitle(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

/** 豆瓣联想搜索（30 分钟缓存）；搜索失败抛 502，由页面提示 */
async function doubanSuggest(db: D1Database, q: string): Promise<DoubanSearchItem[]> {
  const cacheKey = `book:douban:q:${q.toLowerCase()}`
  const cached = await cacheGet(db, cacheKey)
  if (cached) return JSON.parse(cached) as DoubanSearchItem[]

  const res = await fetch(`https://book.douban.com/j/subject_suggest?q=${encodeURIComponent(q)}`, {
    headers: { 'user-agent': DOUBAN_UA, referer: DOUBAN_REFERER },
    signal: AbortSignal.timeout(10_000),
  }).catch((err) => {
    throw new ApiError(502, 502, `豆瓣搜索失败：${err instanceof Error ? err.message : '网络错误'}`)
  })
  if (!res.ok) throw new ApiError(502, 502, `豆瓣搜索失败：HTTP ${res.status}`)

  const raw = await res.json<unknown>()
  const items = (Array.isArray(raw) ? raw : [])
    .filter((x): x is Record<string, string> => Boolean(x) && typeof x === 'object' && (x as { type?: string }).type === 'b')
    .filter((x) => x.id && x.title)
    .slice(0, 12)
    .map((x) => ({
      doubanId: x.id,
      title: x.title,
      author: x.author_name || null,
      year: x.year || null,
      cover: x.pic || null,
      url: x.url || null,
    }))
  await cacheSet(db, cacheKey, JSON.stringify(items), 30 * 60_000)
  return items
}

/** 豆瓣条目详情（24 小时缓存）；抓不到返回 null，不阻断添加/同步 */
async function doubanSubject(db: D1Database, id: string): Promise<DoubanInfo | null> {
  const cacheKey = `book:douban:subject:${id}`
  const cached = await cacheGet(db, cacheKey)
  if (cached) return JSON.parse(cached) as DoubanInfo

  let html: string
  try {
    const res = await fetch(`https://book.douban.com/subject/${id}/`, {
      headers: { 'user-agent': DOUBAN_UA, referer: DOUBAN_REFERER },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return null
    html = await res.text()
  } catch {
    return null
  }

  const info = parseDoubanSubject(html, id)
  if (!info.title) return null
  await cacheSet(db, cacheKey, JSON.stringify(info), 24 * 60 * 60_000)
  return info
}

function parseDoubanSubject(html: string, id: string): DoubanInfo {
  const meta = (property: string) => {
    const m = new RegExp(`<meta property="${property}" content="([^"]*)"`).exec(html)
    return m ? decodeEntities(m[1]) : null
  }
  const ratingRaw = Number(/class="[^"]*rating_num[^"]*"[^>]*>\s*([\d.]+)\s*</.exec(html)?.[1])
  const intro = /<div class="intro">([\s\S]*?)<\/div>/.exec(html)?.[1]
  const pubdate = /出版(?:时间|年):<\/span>\s*([^<]+?)\s*</.exec(html)?.[1]
  const summary = intro ? cleanText(intro).slice(0, MAX_SUMMARY) : ''

  return {
    doubanId: id,
    title: meta('og:title') || html.match(/<title>\s*([^<]+?)\s*\(豆瓣\)<\/title>/)?.[1]?.trim() || null,
    author: meta('book:author'),
    cover: meta('og:image'),
    rating: Number.isFinite(ratingRaw) && ratingRaw > 0 ? ratingRaw : null,
    summary: summary || null,
    pubYear: pubdate ? pubdate.slice(0, 20) : null,
    url: `https://book.douban.com/subject/${id}/`,
  }
}

/**
 * 上传建条目时的书名：文件名里带《书名》就以书名号内容为准（下载来的文件常带站点前缀 / 作者后缀），
 * 否则用标签里读到的标题（epub OPF），再退回去掉扩展名的文件名。
 */
function titleFromFilename(filename: string, explicit?: string): string {
  const inner = /《([^》]+)》/.exec(filename)?.[1]?.trim()
  const fallback = explicit?.trim() || filename.replace(/\.[^.]+$/, '').trim()
  return (inner || fallback || filename).slice(0, MAX_TITLE)
}

/** 下载名：老记录的 filename 可能缺后缀（或为空），用 fmt 补上 */
function downloadName(filename: string | null, fmt: string | null): string | null {
  if (!filename) return null
  const ext = (fmt || '').toLowerCase()
  if (!ext) return filename
  return new RegExp(`\\.${ext}$`, 'i').test(filename) ? filename : `${filename}.${ext}`
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, max) : null
}

function httpUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const url = new URL(value.trim())
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null
  } catch {
    return null
  }
}

/** 封面地址：允许任意公网 http(s)，拒绝环回/内网/元数据地址（SSRF 守卫） */
function coverUrl(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string') throw new ApiError(400, 400, '封面地址无效')
  const raw = value.trim()
  return raw ? parseCoverUrl(raw).toString() : null
}

function parseCoverUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new ApiError(400, 400, '封面地址无效')
  }
  const port = url.port
  if (
    !/^https?:$/.test(url.protocol) ||
    isBlockedHost(url.hostname) ||
    (port && port !== '80' && port !== '443')
  ) {
    throw new ApiError(400, 400, '封面地址无效或指向内网')
  }
  return url
}

function guessImageType(pathname: string): string | null {
  const ext = pathname.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    avif: 'image/avif',
    svg: 'image/svg+xml',
  }
  return map[ext] ?? null
}

function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (!host) return true
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return true
  }

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (v4) {
    const a = Number(v4[1])
    const b = Number(v4[2])
    if (a === 0 || a === 10 || a === 127) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 100 && b >= 64 && b <= 127) return true
    if (a >= 224) return true
  }

  if (
    host.includes(':') &&
    (host === '::1' || host === '::' || host.startsWith('::ffff:') || /^f[cd]/.test(host) || /^fe80/.test(host))
  ) {
    return true
  }
  return false
}

function normalizeStatus(value: unknown): Status {
  return STATUSES.includes(value as Status) ? (value as Status) : 'unread'
}

function normalizeRating(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 && n <= 10 ? n : null
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
}

function cleanText(html: string): string {
  return decodeEntities(html.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''))
    .replace(/\s+/g, ' ')
    .trim()
}
