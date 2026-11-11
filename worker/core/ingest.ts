/** 结果入库映射（v4.2「泛化任务类型」）：新数据源 = 新增 ingest + D1 加行，agent 永远只回传通用 items */
// 幂等一律靠业务表唯一约束 + ON CONFLICT DO NOTHING（天然断点续传）

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
    const rows = items.map(asRssItem).filter((r): r is RssItem => r !== null)
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
