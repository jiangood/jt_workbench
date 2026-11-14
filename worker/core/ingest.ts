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
  sourceId?: string
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
    sourceId: typeof it.sourceId === 'string' && it.sourceId ? it.sourceId : undefined,
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

/* ---------------- 知识星球（issue #7 全量采集） ----------------
 * zsxq_sync 一条通道传三类 items，用 kind 分流：
 *   缺省 / 'topic' → 帖子（旧 agent 没有 kind，按帖子处理）
 *   'comment'      → 评论（评论附件带 topicId + commentId，落 zsxq_file）
 *   'sync_state'   → 每个星球的回溯游标（cursor = 下一轮的 end_time，done=1 表示到历史尽头）
 * 旧 agent 只回传帖子且没有 authorId / isOwner / commentsCount 之类字段：全部按默认值兜底（0 / null），
 * 不认识的 kind 直接忽略，绝不让一条未知 item 把整批入库搞挂。
 */

interface ZsxqFileRef {
  /** 数字字符串（zsxq file_id）；旧数据没有 fileId → null（只留在帖子的 files JSON 里） */
  fileId: string | null
  name: string | null
  size: number | null
  isOwner: number
}

interface ZsxqTopicItem {
  topicId: string
  groupId: string
  groupName: string | null
  title: string | null
  talkText: string | null
  images: Array<{ u: string; w?: number | null; h?: number | null }> | null
  files: ZsxqFileRef[]
  authorId: string | null
  authorName: string | null
  isOwner: number
  commentsCount: number
  likesCount: number
  createTime: number | null
}

interface ZsxqCommentItem {
  commentId: string
  topicId: string
  groupId: string
  authorId: string | null
  authorName: string | null
  isOwner: number
  text: string | null
  images: Array<{ u: string; w?: number | null; h?: number | null }> | null
  files: ZsxqFileRef[]
  createTime: number | null
}

interface ZsxqStateItem {
  groupId: string
  cursor: string | null
  done: number
  note: string | null
  /** 本轮完整扫描到的帖子时间窗口（毫秒）；null = 本轮没完整翻完任何一页 */
  scanFrom: number | null
  scanTo: number | null
}

/** 主题存活探测：gone 由 Worker 累计缺失次数，连续两轮才落 deleted=1；unknown 只推进探测时间 */
interface ZsxqTopicCheckItem {
  topicId: string
  groupId: string
  status: 'alive' | 'gone' | 'unknown'
  code: number | null
  commentsCount: number | null
  likesCount: number | null
  message: string | null
}

/** 评论对账完成标记：更新 comments_checked_at，排队尾等下轮 */
interface ZsxqCommentStateItem {
  topicId: string
  groupId: string
}

/** 评论抓取失败：记录错误并对该帖子做指数退避 */
interface ZsxqCommentFailureItem {
  topicId: string
  groupId: string
  message: string | null
}

function asText(v: unknown): string | null {
  if (typeof v === 'string') return v || null
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return null
}

function asFlag(v: unknown): number {
  return v === true || v === 1 || v === '1' ? 1 : 0
}

function asCount(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0
}

/** files 数组：fileId 可选（旧 agent 只有 name/size），isOwner 缺省继承帖子/评论的作者身份 */
function asZsxqFiles(raw: unknown, fallbackOwner: number): ZsxqFileRef[] {
  if (!Array.isArray(raw)) return []
  const out: ZsxqFileRef[] = []
  for (const f of raw) {
    if (typeof f !== 'object' || f === null) continue
    const it = f as Record<string, unknown>
    const id = it.fileId ?? it.file_id
    out.push({
      fileId:
        typeof id === 'number' && Number.isFinite(id)
          ? String(id)
          : typeof id === 'string' && /^\d+$/.test(id)
            ? id
            : null,
      name: typeof it.name === 'string' ? it.name : null,
      size: numOrNull(it.size),
      isOwner: it.isOwner === undefined ? fallbackOwner : asFlag(it.isOwner),
    })
  }
  return out
}

function asZsxqTopicItem(item: unknown): ZsxqTopicItem | null {
  if (typeof item !== 'object' || item === null) return null
  const it = item as Record<string, unknown>
  if (typeof it.topicId !== 'string' || !it.topicId) return null
  if (typeof it.groupId !== 'string' || !it.groupId) return null
  const isOwner = asFlag(it.isOwner)
  return {
    topicId: it.topicId,
    groupId: it.groupId,
    groupName: typeof it.groupName === 'string' && it.groupName ? it.groupName : null,
    title: typeof it.title === 'string' ? it.title : null,
    talkText: typeof it.talkText === 'string' ? it.talkText : null,
    images: Array.isArray(it.images)
      ? (it.images as Array<{ u: string; w?: number | null; h?: number | null }>)
      : null,
    files: asZsxqFiles(it.files, isOwner),
    authorId: asText(it.authorId),
    authorName: asText(it.authorName),
    isOwner,
    commentsCount: asCount(it.commentsCount),
    likesCount: asCount(it.likesCount),
    createTime: numOrNull(it.createTime),
  }
}

function asZsxqCommentItem(item: unknown): ZsxqCommentItem | null {
  if (typeof item !== 'object' || item === null) return null
  const it = item as Record<string, unknown>
  if (typeof it.commentId !== 'string' || !it.commentId) return null
  if (typeof it.topicId !== 'string' || !it.topicId) return null
  if (typeof it.groupId !== 'string' || !it.groupId) return null
  const isOwner = asFlag(it.isOwner)
  return {
    commentId: it.commentId,
    topicId: it.topicId,
    groupId: it.groupId,
    authorId: asText(it.authorId),
    authorName: asText(it.authorName),
    isOwner,
    text: typeof it.text === 'string' ? it.text : null,
    images: Array.isArray(it.images)
      ? (it.images as Array<{ u: string; w?: number | null; h?: number | null }>)
      : null,
    files: asZsxqFiles(it.files, isOwner),
    createTime: numOrNull(it.createTime),
  }
}

function asZsxqStateItem(item: unknown): ZsxqStateItem | null {
  if (typeof item !== 'object' || item === null) return null
  const it = item as Record<string, unknown>
  if (typeof it.groupId !== 'string' || !it.groupId) return null
  return {
    groupId: it.groupId,
    cursor: typeof it.cursor === 'string' && it.cursor ? it.cursor : null,
    done: asFlag(it.done),
    note: typeof it.note === 'string' && it.note ? it.note.slice(0, 300) : null,
    scanFrom: numOrNull(it.scanFrom),
    scanTo: numOrNull(it.scanTo),
  }
}

function asZsxqTopicCheckItem(item: unknown): ZsxqTopicCheckItem | null {
  if (typeof item !== 'object' || item === null) return null
  const it = item as Record<string, unknown>
  if (typeof it.topicId !== 'string' || !it.topicId) return null
  if (typeof it.groupId !== 'string' || !it.groupId) return null
  // 兼容旧 agent：没有 status 时按 alive 标记判断
  const status =
    it.status === 'alive' || it.status === 'gone' || it.status === 'unknown'
      ? it.status
      : asFlag(it.alive)
        ? 'alive'
        : 'gone'
  return {
    topicId: it.topicId,
    groupId: it.groupId,
    status,
    code: typeof it.code === 'number' && Number.isFinite(it.code) ? it.code : null,
    commentsCount: countOrNull(it.commentsCount),
    likesCount: countOrNull(it.likesCount),
    message: typeof it.message === 'string' && it.message ? it.message.slice(0, 200) : null,
  }
}

function asZsxqCommentStateItem(item: unknown): ZsxqCommentStateItem | null {
  if (typeof item !== 'object' || item === null) return null
  const it = item as Record<string, unknown>
  if (typeof it.topicId !== 'string' || !it.topicId) return null
  if (typeof it.groupId !== 'string' || !it.groupId) return null
  return { topicId: it.topicId, groupId: it.groupId }
}

function asZsxqCommentFailureItem(item: unknown): ZsxqCommentFailureItem | null {
  if (typeof item !== 'object' || item === null) return null
  const it = item as Record<string, unknown>
  if (typeof it.topicId !== 'string' || !it.topicId) return null
  if (typeof it.groupId !== 'string' || !it.groupId) return null
  return {
    topicId: it.topicId,
    groupId: it.groupId,
    message: typeof it.message === 'string' && it.message ? it.message.slice(0, 200) : null,
  }
}

/** 计数：非数字 / 负数当未知（null），不要用 0 覆盖已有值 */
function countOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null
}

/** kind 分流键：缺省按帖子处理（旧 agent 兼容） */
function zsxqKind(item: unknown): string {
  if (typeof item !== 'object' || item === null) return ''
  const k = (item as Record<string, unknown>).kind
  return typeof k === 'string' && k ? k : 'topic'
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
    const fallbackSourceId = typeof payload.sourceId === 'string'' ? payload.sourceId : null
    const rows = items
      .map(asRssItem)
      .filter((r): r is RssItem => r !== null)
      .map((r) => normalizeRssItem(r, now))
      .map((r) => ({ ...r, sourceId: r.sourceId ?? fallbackSourceId }))
      .filter((r): r is RssItem & { sourceId: string } => typeof r.sourceId === 'string' && r.sourceId.length > 0)
    if (!rows.length) return items.length === 0 ? 0 : null
    const results = await db.batch(
      rows.map((r) =>
        db
          .prepare(
            `INSERT INTO news_item (source_id, external_id, title, link, author, published_at, content_html, fetched_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (source_id, external_id) DO NOTHING`,
          )
          .bind(r.sourceId, r.externalId, r.title ?? null, r.link ?? null, r.author ?? null, r.publishedAt ?? null, r.contentHtml ?? null, now),
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
  if (type === 'zsxq_sync' || type === 'zsxq_backfill' || type === 'zsxq_comments' || type === 'zsxq_probe') {
    const topics: ZsxqTopicItem[] = []
    const comments: ZsxqCommentItem[] = []
    const states: ZsxqStateItem[] = []
    const checks: ZsxqTopicCheckItem[] = []
    const commentStates: ZsxqCommentStateItem[] = []
    const commentFailures: ZsxqCommentFailureItem[] = []
    for (const item of items) {
      const kind = zsxqKind(item)
      if (kind === 'comment') {
        const c = asZsxqCommentItem(item)
        if (c) comments.push(c)
      } else if (kind === 'sync_state') {
        const s = asZsxqStateItem(item)
        if (s) states.push(s)
      } else if (kind === 'topic_check') {
        const c = asZsxqTopicCheckItem(item)
        if (c) checks.push(c)
      } else if (kind === 'comment_state') {
        const c = asZsxqCommentStateItem(item)
        if (c) commentStates.push(c)
      } else if (kind === 'comment_failure') {
        const c = asZsxqCommentFailureItem(item)
        if (c) commentFailures.push(c)
      } else if (kind === 'topic') {
        const t = asZsxqTopicItem(item)
        if (t) topics.push(t)
      }
      // 其它 kind：agent 先升级的窗口，忽略即可（不让整批入库失败）
    }
    if (!topics.length && !comments.length && !states.length && !checks.length && !commentStates.length && !commentFailures.length) {
      return 0
    }

    // 星球名随 items 捎带（agent 同步时顺带查 groups.list）；缺失时保留旧名
    const groups = new Map<string, string | null>()
    for (const t of topics) {
      if (!groups.get(t.groupId) || groups.get(t.groupId) === null) groups.set(t.groupId, t.groupName)
    }
    for (const c of comments) if (!groups.has(c.groupId)) groups.set(c.groupId, null)

    const stmts: D1PreparedStatement[] = []
    for (const [id, name] of groups) {
      stmts.push(
        db
          .prepare(
            `INSERT INTO zsxq_group (id, name) VALUES (?, ?)
             ON CONFLICT (id) DO UPDATE SET name = COALESCE(excluded.name, name)`,
          )
          .bind(id, name),
      )
    }

    // 帖子：作者身份 / 星主标记 / 互动计数是新列，旧 agent 不传就按 0、null 兜底
    // is_owner 与两个计数只增不减：某轮拿不到星主（isOwner=0）或老 agent 传 0 时，不会把已知结果抹掉
    for (const t of topics) {
      stmts.push(
        db
          .prepare(
            `INSERT INTO zsxq_topic
               (id, group_id, title, talk_text, images, files, author_id, author_name,
                is_owner, comments_count, likes_count, create_time, fetched_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (id) DO UPDATE SET
               group_id = excluded.group_id,
               title = excluded.title,
               talk_text = COALESCE(excluded.talk_text, talk_text),
               images = COALESCE(excluded.images, images),
               files = COALESCE(excluded.files, files),
               author_id = COALESCE(excluded.author_id, author_id),
               author_name = COALESCE(excluded.author_name, author_name),
               is_owner = MAX(is_owner, excluded.is_owner),
               comments_count = MAX(comments_count, excluded.comments_count),
               likes_count = MAX(likes_count, excluded.likes_count),
               create_time = COALESCE(excluded.create_time, create_time),
               -- 重新出现在列表里 = 没被删（删除标记可逆，误判能自愈）
               deleted = 0,
               deleted_at = NULL,
               miss_count = 0,
               fetched_at = excluded.fetched_at`,
          )
          .bind(
            t.topicId, t.groupId, t.title, t.talkText,
            t.images ? JSON.stringify(t.images) : null,
            t.files.length ? JSON.stringify(t.files.map(fileJson)) : null,
            t.authorId, t.authorName, t.isOwner, t.commentsCount, t.likesCount,
            t.createTime, now,
          ),
      )
      for (const f of t.files) {
        if (!f.fileId) continue
        stmts.push(
          zsxqFileStmt(db, f, {
            topicId: t.topicId, commentId: null, groupId: t.groupId, createTime: t.createTime, now,
          }),
        )
      }
    }

    for (const c of comments) {
      stmts.push(
        db
          .prepare(
            `INSERT INTO zsxq_comment
               (id, topic_id, group_id, author_id, author_name, is_owner, text, images, create_time, fetched_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (id) DO UPDATE SET
               topic_id = excluded.topic_id,
               group_id = excluded.group_id,
               author_id = COALESCE(excluded.author_id, author_id),
               author_name = COALESCE(excluded.author_name, author_name),
               is_owner = MAX(is_owner, excluded.is_owner),
               text = COALESCE(excluded.text, text),
               images = COALESCE(excluded.images, images),
               create_time = COALESCE(excluded.create_time, create_time),
               fetched_at = excluded.fetched_at`,
          )
          .bind(
            c.commentId, c.topicId, c.groupId, c.authorId, c.authorName, c.isOwner,
            c.text, c.images ? JSON.stringify(c.images) : null, c.createTime, now,
          ),
      )
      // 评论附件：topic_id = 所属帖子，comment_id = 评论（备份任务按这个归属回写 r2_key）
      for (const f of c.files) {
        if (!f.fileId) continue
        stmts.push(
          zsxqFileStmt(db, f, {
            topicId: c.topicId, commentId: c.commentId, groupId: c.groupId, createTime: c.createTime, now,
          }),
        )
      }
    }

    // 评论对账成功：推进时间戳并清除失败退避状态（0 条评论也算核对过）
    for (const c of commentStates) {
      stmts.push(
        db
          .prepare(
            `UPDATE zsxq_topic SET
               comments_checked_at = ?,
               comments_fail_count = 0,
               comments_retry_at = NULL,
               comments_last_error = NULL
             WHERE id = ? AND group_id = ?`,
          )
          .bind(now, c.topicId, c.groupId),
      )
    }

    // 评论对账失败：指数退避，首次 5 分钟，逐次翻倍，最多 6 小时。
    // 失败帖子在 retry_at 之前不进入 comments 队列，避免每轮重复打同一批失败对象。
    for (const c of commentFailures) {
      stmts.push(
        db
          .prepare(
            `UPDATE zsxq_topic SET
               comments_fail_count = comments_fail_count + 1,
               comments_retry_at = ? + MIN(21600000, 300000 * (1 << MIN(comments_fail_count, 7))),
               comments_last_error = ?
             WHERE id = ? AND group_id = ?`,
          )
          .bind(now, c.message, c.topicId, c.groupId),
      )
    }

    // 删除探测结果：alive 清掉历史缺失计数；gone 累计、连续两轮才落 deleted=1；
    // unknown（接口/权限异常）只推进探测时间，排队尾换下一批，绝不记缺失
    for (const c of checks) {
      if (c.status === 'alive') {
        stmts.push(
          db
            .prepare(
              `UPDATE zsxq_topic SET
                 checked_at = ?,
                 comments_count = MAX(comments_count, COALESCE(?, comments_count)),
                 likes_count = MAX(likes_count, COALESCE(?, likes_count)),
                 deleted = 0, deleted_at = NULL, miss_count = 0
               WHERE id = ?`,
            )
            .bind(now, c.commentsCount, c.likesCount, c.topicId),
        )
        continue
      }
      if (c.status === 'unknown') {
        stmts.push(
          db
            .prepare('UPDATE zsxq_topic SET checked_at = ? WHERE id = ?')
            .bind(now, c.topicId),
        )
        continue
      }
      stmts.push(
        db
          .prepare(
            `UPDATE zsxq_topic SET
               checked_at = ?,
               miss_count = miss_count + 1,
               last_missing_at = ?,
               deleted = CASE WHEN miss_count + 1 >= 2 THEN 1 ELSE deleted END,
               deleted_at = CASE WHEN miss_count + 1 >= 2 AND deleted = 0 THEN ? ELSE deleted_at END
             WHERE id = ?`,
          )
          .bind(now, now, now, c.topicId),
      )
    }

    // 列表对账：本轮完整扫过的时间窗口里，库里还留着但这次没出现的帖子 = 疑似删除。
    // 只认完整翻完的页（agent 侧 pageComplete），半路因预算停下不会产生窗口，避免误标。
    for (const s of states) {
      if (s.scanFrom === null || s.scanTo === null || s.scanFrom < s.scanTo) continue
      stmts.push(
        db
          .prepare(
            `UPDATE zsxq_topic SET
               miss_count = miss_count + 1,
               last_missing_at = ?,
               deleted = CASE WHEN miss_count + 1 >= 2 THEN 1 ELSE deleted END,
               deleted_at = CASE WHEN miss_count + 1 >= 2 AND deleted = 0 THEN ? ELSE deleted_at END
             WHERE group_id = ? AND deleted = 0
               AND create_time IS NOT NULL AND create_time >= ? AND create_time <= ?
               AND fetched_at < ?`,
          )
          .bind(now, now, s.groupId, s.scanTo, s.scanFrom, now),
      )
    }

    // 回溯游标：cursor 只前进到 agent 处理完的位置；done=1 = 已到历史尽头
    for (const s of states) {
      stmts.push(
        db
          .prepare(
            `INSERT INTO zsxq_sync_state (group_id, cursor, done, note, updated_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (group_id) DO UPDATE SET
               cursor = COALESCE(excluded.cursor, cursor),
               done = excluded.done,
               note = excluded.note,
               updated_at = excluded.updated_at`,
          )
          .bind(s.groupId, s.cursor, s.done, s.note, now),
      )
    }

    const results = await db.batch(stmts)
    return results.reduce((n, r) => n + (r.meta.changes ?? 0), 0)
  }
  return null // unknown type：Worker 先升级 / agent 先升级窗口的安全兜底（验收场景 #5）
}

/** 帖子 files 列的 JSON 形态（契约：[{fileId, name, size}]；没有 fileId 的老数据省掉该键） */
function fileJson(f: ZsxqFileRef): { fileId?: number; name: string | null; size: number | null } {
  const out: { fileId?: number; name: string | null; size: number | null } = { name: f.name, size: f.size }
  const id = f.fileId ? Number(f.fileId) : NaN
  if (Number.isSafeInteger(id)) out.fileId = id
  return out
}

/** 附件 upsert：只认领归属与元数据，r2_key / backup_status / error 由备份任务维护，这里绝不覆盖 */
function zsxqFileStmt(
  db: D1Database,
  f: ZsxqFileRef,
  ctx: { topicId: string | null; commentId: string | null; groupId: string | null; createTime: number | null; now: number },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO zsxq_file
         (id, topic_id, comment_id, group_id, name, size, is_owner, create_time, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         topic_id = COALESCE(excluded.topic_id, topic_id),
         comment_id = COALESCE(excluded.comment_id, comment_id),
         group_id = COALESCE(excluded.group_id, group_id),
         name = COALESCE(excluded.name, name),
         size = COALESCE(excluded.size, size),
         is_owner = MAX(is_owner, excluded.is_owner),
         create_time = COALESCE(excluded.create_time, create_time),
         fetched_at = excluded.fetched_at`,
    )
    .bind(f.fileId, ctx.topicId, ctx.commentId, ctx.groupId, f.name, f.size, f.isOwner, ctx.createTime, ctx.now)
}
