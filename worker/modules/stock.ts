/** 股票模块（原 wb_stock_*）：自选管理 + 现价实时（cache 60s 节流）+ 历史K线按需拉 */

import { Hono } from 'hono'
import { ok, ApiError, type Env } from '../core/envelope'
import { cacheGet, cacheSet } from '../core/cache'

const STOCK_EOD_CRON = '0 35 15 ? * MON-FRI' // 原系统 seed cron，零换算沿用

export const stock = new Hono<Env>()

// ---------- 自选管理 ----------

stock.get('/watch', async (c) => {
  const rows = await c.env.DB
    .prepare('SELECT code, name, sort, enabled, group_name AS groupName FROM stock_watch ORDER BY sort, code')
    .all()
  return ok({ watch: rows.results })
})

stock.post('/watch', async (c) => {
  const b = await c.req.json<{ code?: string; name?: string; groupName?: string | null; sort?: number }>()
  const name = b.name?.trim()
  const groupName = typeof b.groupName === 'string' ? b.groupName.trim() : ''
  if (!b.code || !/^(sh|sz|bj)\d{6}$/.test(b.code) || !name) {
    throw new ApiError(400, 400, 'code（sh/sz/bj + 6位数字）与 name 必填')
  }
  if (groupName.length > 50) throw new ApiError(400, 400, '分组名不能超过 50 个字符')
  await c.env.DB
    .prepare(
      `INSERT INTO stock_watch (code, name, sort, group_name) VALUES (?, ?, ?, ?)
       ON CONFLICT (code) DO UPDATE SET
         name = excluded.name, sort = excluded.sort,
         group_name = excluded.group_name, enabled = 1`,
    )
    .bind(b.code, name, b.sort ?? 0, groupName || null)
    .run()
  await syncEodJob(c.env.DB)
  return ok({ code: b.code })
})

stock.delete('/watch/:code', async (c) => {
  await c.env.DB.prepare('DELETE FROM stock_watch WHERE code = ?').bind(c.req.param('code')).run()
  await syncEodJob(c.env.DB)
  return ok(null)
})

// ---------- 股票搜索（东方财富联想优先，失败降级腾讯） ----------
// 单次联想请求 + 10 分钟 cache，属于展示型按需拉取，和现价/K 线一样留在 Worker。

interface Candidate {
  code: string
  name: string
}

const SEARCH_LIMIT = 10
const EASTMONEY_TOKEN = 'D43BF722C8E33BDC906FB84D85E326E8'

stock.get('/search', async (c) => {
  const keyword = (c.req.query('keyword') ?? '').trim().slice(0, 32)
  if (!keyword) return ok({ items: [] })

  const cacheKey = `stock:search:${keyword.toLowerCase()}`
  const cached = await cacheGet(c.env.DB, cacheKey)
  let candidates: Candidate[]
  if (cached) {
    candidates = JSON.parse(cached) as Candidate[]
  } else {
    let error: unknown = null
    candidates = []
    try {
      candidates = await searchEastmoney(keyword)
    } catch (err) {
      error = err
    }
    if (!candidates.length) {
      try {
        candidates = await searchTencent(keyword)
      } catch (err) {
        error = err
      }
    }
    if (!candidates.length && error) {
      const reason = error instanceof Error ? error.message : '未知错误'
      throw new ApiError(502, 502, `股票搜索失败：${reason}`)
    }
    await cacheSet(c.env.DB, cacheKey, JSON.stringify(candidates), 10 * 60_000)
  }

  const rows = await c.env.DB.prepare('SELECT code FROM stock_watch WHERE enabled = 1').all<{ code: string }>()
  const added = new Set(rows.results.map((r) => r.code))
  return ok({ items: candidates.map((x) => ({ ...x, added: added.has(x.code) })) })
})

async function searchEastmoney(keyword: string): Promise<Candidate[]> {
  const url = `https://searchapi.eastmoney.com/api/suggest/get?type=14&token=${EASTMONEY_TOKEN}&count=${SEARCH_LIMIT}&input=${encodeURIComponent(keyword)}`
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
  if (!res.ok) throw new Error(`东方财富 HTTP ${res.status}`)
  const body = await res.json<{
    QuotationCodeTable?: { Data?: Array<{ Code?: string; Name?: string; Classify?: string }> }
  }>()
  return dedupe(
    (body.QuotationCodeTable?.Data ?? [])
      .filter((r) => r.Classify === 'AStock')
      .map((r) => toCandidate(r.Code ?? '', r.Name ?? ''))
      .filter((x): x is Candidate => x !== null),
  )
}

/** 腾讯 smartbox：返回体是 GBK，名称以 \uXXXX 转义；只取 A 股（GP-A） */
async function searchTencent(keyword: string): Promise<Candidate[]> {
  const url = `https://smartbox.gtimg.cn/s3/?t=all&q=${encodeURIComponent(keyword)}`
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
  if (!res.ok) throw new Error(`腾讯 HTTP ${res.status}`)
  const text = decodeGbk(await res.arrayBuffer())
  const hint = /v_hint="([^"]*)"/.exec(text)
  if (!hint) return []

  const out: Candidate[] = []
  for (const item of hint[1].split('^')) {
    const f = item.split('~')
    if (f.length < 5) continue
    const market = f[0].toLowerCase()
    if (market !== 'sh' && market !== 'sz' && market !== 'bj') continue
    if (!f[4].startsWith('GP-A')) continue
    const candidate = toCandidate(f[1], unescapeUnicode(f[2]))
    if (candidate) out.push(candidate)
  }
  return dedupe(out)
}

function toCandidate(rawCode: string, rawName: string): Candidate | null {
  const digits = normalizeDigits(rawCode)
  const name = rawName.trim()
  if (!digits || !name) return null
  return { code: marketPrefix(digits) + digits, name }
}

/** sh600519 / SH.600519 / 600519 → 600519 */
function normalizeDigits(raw: string): string | null {
  const digits = raw
    .trim()
    .toLowerCase()
    .replace(/sh|sz|bj/g, '')
    .replace(/[._\-\s]/g, '')
  return /^\d{6}$/.test(digits) ? digits : null
}

function marketPrefix(digits: string): string {
  const first = digits[0]
  if (first === '6' || first === '5' || first === '9') return 'sh'
  if (first === '4' || first === '8') return 'bj'
  return 'sz'
}

function unescapeUnicode(value: string): string {
  return value.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
}

function dedupe(items: Candidate[]): Candidate[] {
  const seen = new Map<string, Candidate>()
  for (const item of items) {
    seen.set(item.code, seen.get(item.code) ?? item)
    if (seen.size >= SEARCH_LIMIT) break
  }
  return [...seen.values()]
}

/** stock_eod 任务：单行维护，payload codes 随自选表同步（agent 从 payload 拿代码清单） */
async function syncEodJob(db: D1Database): Promise<void> {
  const rows = await db.prepare('SELECT code FROM stock_watch WHERE enabled = 1').all<{ code: string }>()
  const codes = rows.results.map((r) => r.code)
  const payload = JSON.stringify({ codes })

  const existing = await db
    .prepare(`SELECT id FROM job WHERE type = 'stock_eod' LIMIT 1`)
    .first<{ id: number }>()
  if (!existing) {
    await db
      .prepare(`INSERT INTO job (type, payload, cron, enabled, status, next_run_at)
                VALUES ('stock_eod', ?, ?, 1, 'pending', 1)`)
      .bind(payload, STOCK_EOD_CRON)
      .run()
  } else if (codes.length) {
    await db
      .prepare(`UPDATE job SET payload = ?, enabled = 1 WHERE id = ?`)
      .bind(payload, existing.id)
      .run()
  } else {
    await db.prepare(`UPDATE job SET enabled = 0 WHERE id = ?`).bind(existing.id).run()
  }
}

// ---------- 现价（页打开实时拉 + 60s TTL 节流） ----------

stock.get('/quote', async (c) => {
  const watch = await c.env.DB
    .prepare('SELECT code, name FROM stock_watch WHERE enabled = 1 ORDER BY sort, code')
    .all<{ code: string; name: string }>()
  const codes = watch.results.map((r) => r.code)
  if (!codes.length) return ok({ quotes: [] })

  const cacheKey = `stock:quote:${codes.join(',')}`
  let body = await cacheGet(c.env.DB, cacheKey)
  if (!body) {
    const res = await fetch(`https://hq.sinajs.cn/list=${codes.join(',')}`, {
      headers: { referer: 'https://finance.sina.com.cn' },
    })
    if (!res.ok) throw new ApiError(502, 502, `行情源 HTTP ${res.status}`)
    body = decodeGbk(await res.arrayBuffer())
    await cacheSet(c.env.DB, cacheKey, body, 60_000)
  }

  const nameOf = new Map(watch.results.map((r) => [r.code, r.name]))
  const quotes = [...body.matchAll(/hq_str_((?:sh|sz|bj)\d{6})="([^"]*)"/g)].map(([, code, raw]) => {
    const f = raw.split(',')
    const prevClose = Number(f[2])
    const rawPrice = Number(f[3])
    // 盘前竞价（09:15–09:30）与停牌时新浪只给昨收：f[1]/f[3]/f[4]/f[5] 全为 0。
    // 这类「无成交价」统一按 preOpen 处理——价格回退昨收、涨跌归零，绝不再算出 -100%
    const preOpen = !(rawPrice > 0)
    const base = prevClose > 0 ? prevClose : 0
    const price = preOpen ? base : rawPrice
    const change = preOpen ? 0 : price - base
    return {
      code,
      name: nameOf.get(code) ?? f[0],
      price,
      change,
      changePct: preOpen || !base ? 0 : (change / base) * 100,
      preOpen,
      open: Number(f[1]), prevClose, high: Number(f[4]), low: Number(f[5]),
      time: `${f[30]} ${f[31]}`,
    }
  })
  return ok({ quotes })
})

/** workerd 若不支持 gbk 则退化为 latin1：GBK 字节流里逗号/数字段不受影响，仅中文名乱码（名取自自选表） */
function decodeGbk(buf: ArrayBuffer): string {
  try {
    return new TextDecoder('gbk').decode(buf)
  } catch {
    return new TextDecoder('latin1').decode(buf)
  }
}

// ---------- 历史 K 线（按需拉 + 入库合并） ----------

stock.get('/daily/:code', async (c) => {
  const code = c.req.param('code')
  if (!/^(sh|sz|bj)\d{6}$/.test(code)) throw new ApiError(400, 400, 'invalid code')
  const len = Math.min(250, Math.max(1, Number(c.req.query('days') ?? '60') || 60))

  const cacheKey = `stock:daily:${code}:${len}`
  let bars = await cacheGet(c.env.DB, cacheKey)
  if (!bars) {
    // 新浪 K 线 JSON 接口（UTF-8）：scale=240 日线
    const url = `https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData?symbol=${code}&scale=240&ma=no&datalen=${len}`
    const res = await fetch(url)
    if (!res.ok) throw new ApiError(502, 502, `K线源 HTTP ${res.status}`)
    const rows = (await res.json()) as Array<{ day: string; open: string; high: string; low: string; close: string; volume: string }>
    const parsed = rows.map((r) => ({
      day: r.day, open: Number(r.open), high: Number(r.high),
      low: Number(r.low), close: Number(r.close), volume: Number(r.volume),
    }))
    // 顺手合并入库（历史 bootstrap；重复日期被 UNIQUE 吸收）
    if (parsed.length) {
      await c.env.DB.batch(
        parsed.map((r) =>
          c.env.DB
            .prepare(
              `INSERT INTO stock_daily (code, trade_date, open, high, low, close, volume, fetched_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (code, trade_date) DO UPDATE SET
                 open = excluded.open, high = excluded.high, low = excluded.low,
                 close = excluded.close, volume = excluded.volume, fetched_at = excluded.fetched_at`,
            )
            .bind(code, r.day, r.open, r.high, r.low, r.close, r.volume, Date.now()),
        ),
      )
    }
    bars = JSON.stringify(parsed)
    await cacheSet(c.env.DB, cacheKey, bars, 10 * 60_000)
  }
  return ok({ code, bars: JSON.parse(bars) })
})
