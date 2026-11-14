// @script
// {
//   "id": "rss_fetch",
//   "name": "RSS 抓取",
//   "version": "1.0.0",
//   "description": "按启用的数据源抓取 RSS/Atom 并回传通用资讯条目",
//   "schedule": "0 0 */2 * * *",
//   "enabled": true,
//   "timeout": 300,
//   "reliability": "best_effort"
// }

import Parser from 'rss-parser'
import { createHash } from 'node:crypto'

const parser = new Parser({
  timeout: 25_000,
  headers: { 'user-agent': 'jt-workbench-agent/1.0' },
})
const MAX_FEED_BYTES = 5 * 1024 * 1024
const MAX_ITEMS_PER_SOURCE = 100

async function readTextBounded(response, maxBytes) {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      total += part.value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        throw new Error('feed exceeds 5 MiB')
      }
      chunks.push(part.value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder('utf-8').decode(bytes)
}

function stableId(item, sourceId) {
  const raw = item.guid || item.id || item.link || String(item.title ?? '') + '|' + String(item.isoDate ?? item.pubDate ?? '')
  if (raw) return String(raw).slice(0, 1000)
  return createHash('sha256').update(sourceId + '|' + JSON.stringify(item)).digest('hex')
}

function toTimestamp(value) {
  if (typeof value !== 'string' || !value) return undefined
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : undefined
}

export async function run(ctx, payload) {
  const sources = Array.isArray(payload?.sources) ? payload.sources : []
  if (sources.length === 0) return { items: [], summary: '没有启用的 RSS 数据源' }

  const items = []
  const errors = []
  let succeeded = 0

  for (const source of sources) {
    if (ctx.signal.aborted) throw new Error('RSS execution aborted')
    if (!source || typeof source.sourceId !== 'string' || typeof source.url !== 'string') continue
    try {
      const response = await ctx.fetch(source.url, {
        headers: { accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' },
        signal: ctx.signal,
      })
      if (!response.ok) throw new Error('HTTP ' + response.status)
      const contentLength = Number(response.headers.get('content-length') ?? 0)
      if (contentLength > MAX_FEED_BYTES) throw new Error('feed exceeds 5 MiB')
      const xml = await readTextBounded(response, MAX_FEED_BYTES)
      const feed = await parser.parseString(xml)
      const feedItems = Array.isArray(feed.items) ? feed.items.slice(0, MAX_ITEMS_PER_SOURCE) : []
      for (const item of feedItems) {
        const title = typeof item.title === 'string' ? item.title : ''
        const link = typeof item.link === 'string' ? item.link : ''
        const contentHtml = typeof item['content:encoded'] === 'string'
          ? item['content:encoded']
          : typeof item.content === 'string' ? item.content
          : typeof item.contentSnippet === 'string' ? item.contentSnippet : undefined
        items.push({
          sourceId: source.sourceId,
          externalId: stableId(item, source.sourceId),
          title,
          link,
          author: typeof item.creator === 'string' ? item.creator
            : typeof item.author === 'string' ? item.author : undefined,
          publishedAt: toTimestamp(item.isoDate) ?? toTimestamp(item.pubDate),
          contentHtml,
        })
      }
      succeeded++
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      errors.push(source.sourceId + ': ' + message)
      ctx.logger.warn({ sourceId: source.sourceId, error: message }, 'RSS source fetch failed')
    }
  }

  if (succeeded === 0 && sources.length > 0) {
    throw new Error('all RSS sources failed: ' + errors.slice(0, 5).join('; '))
  }
  const summary = '成功 ' + succeeded + '/' + sources.length + ' 个数据源，抓取 ' + items.length + ' 条' +
    (errors.length ? '；失败 ' + errors.length + ' 个：' + errors.slice(0, 3).join('; ') : '')
  return { items, summary: summary.slice(0, 2000) }
}
