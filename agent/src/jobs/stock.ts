/** stock_eod：新浪批量行情接口 → 结构化 items（收盘同步，agent 执行） */

import { z } from 'zod'
import { readBody, safeFetch } from '../ssrf.js'
import type { JobHandler } from '../types.js'

const payloadSchema = z.object({
  codes: z.array(z.string().regex(/^(sh|sz|bj)\d{6}$/)).min(1),
})

export const stockHandler: JobHandler = async (payload, ctx) => {
  const { codes } = payloadSchema.parse(payload)
  const items: Record<string, unknown>[] = []

  // 新浪单次批量上限 ~100，按 80 一批稳妥
  for (let i = 0; i < codes.length; i += 80) {
    const batch = codes.slice(i, i + 80)
    const url = `https://hq.sinajs.cn/list=${batch.join(',')}`
    const res = await safeFetch(url, {
      headers: { referer: 'https://finance.sina.com.cn' },
      signal: ctx.signal,
    })
    if (!res.ok) throw new Error(`sina HTTP ${res.status} ${url}`)
    const text = new TextDecoder('gbk').decode(await readBody(res, url))

    for (const m of text.matchAll(/hq_str_((?:sh|sz|bj)\d{6})="([^"]*)"/g)) {
      const [, code, raw] = m
      if (!raw) continue
      const f = raw.split(',')
      if (f.length < 32) continue
      items.push({
        code,
        name: f[0],
        open: num(f[1]), prevClose: num(f[2]), price: num(f[3]),
        high: num(f[4]), low: num(f[5]),
        volume: num(f[8]),           // 成交量（股）
        tradeDate: f[30],            // YYYY-MM-DD
      })
    }
    if (ctx.signal.aborted) break
  }
  return { items, summary: `stock_eod: ${items.length} quotes (${codes.length} codes)` }
}

function num(s: string | undefined): number | null {
  const n = Number(s)
  return Number.isFinite(n) && n !== 0 ? n : n === 0 ? 0 : null
}
