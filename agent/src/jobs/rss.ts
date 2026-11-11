/** rss_fetch：抓取 → 解析 → 结构化 items（M3 全链路的 agent 半边） */

import Parser from 'rss-parser'
import { z } from 'zod'
import { readBody, safeFetch } from '../ssrf.js'
import type { JobHandler } from '../types.js'

const payloadSchema = z.object({
  sourceId: z.string().min(1),
  url: z.string().url(),
})

const parser: Parser = new Parser({
  customFields: { item: [['content:encoded', 'contentEncoded']] },
})

export const rssHandler: JobHandler = async (payload, ctx) => {
  const { sourceId, url } = payloadSchema.parse(payload)

  const res = await safeFetch(url, {
    headers: { 'user-agent': 'workbench-agent/0.1 (+https://jt.410518072.xyz)' },
    signal: ctx.signal,
  })
  if (!res.ok) throw new Error(`feed HTTP ${res.status} ${url}`)
  const xml = new TextDecoder().decode(await readBody(res, url))

  const feed = await parser.parseString(xml)
  const items = feed.items.map((it) => ({
    externalId: it.guid ?? it.link ?? `${sourceId}:${crypto.randomUUID()}`,
    title: it.title?.slice(0, 500),
    link: it.link,
    author: it.creator ?? undefined,
    publishedAt: it.isoDate ? Date.parse(it.isoDate) || undefined : undefined,
    contentHtml:
      (it as { contentEncoded?: string }).contentEncoded ??
      ('content:encoded' in it ? (it as Record<string, string>)['content:encoded'] : undefined) ??
      it.content ??
      it.summary,
  }))

  return {
    items,
    summary: `${sourceId}: ${items.length} items${items.length ? '' : ' (empty feed)'}`,
  }
}
