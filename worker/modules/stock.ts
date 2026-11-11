/** 股票模块（原 wb_stock_*）：自选管理 + 现价实时（cache 60s 节流）+ 历史K线按需拉 */

import { Hono } from 'hono'
import { ok, ApiError, type Env } from '../core/envelope'
import { cacheGet, cacheSet } from '../core/cache'

const STOCK_EOD_CRON = '0 35 15 ? * MON-FRI' // 原系统 seed cron，零换算沿用

export const stock = new Hono<Env>()

// ---------- 自选管理 ----------

stock.get('/watch', async (c) => {
  const rows = await c.env.DB
    .prepare('SELECT code, name, sort, enabled FROM stock_watch ORDER BY sort, code')
    .all()
  return ok({ watch: rows.results })
})

stock.post('/watch', async (c) => {
  const b = await c.req.json<{ code?: string; name?: string; sort?: number }>()
  if (!b.code || !/^(sh|sz|bj)\d{6}$/.test(b.code) || !b.name) {
    throw new ApiError(400, 400, 'code（sh/sz/bj + 6位数字）与 name 必填')
  }
  await c.env.DB
    .prepare(
      `INSERT INTO stock_watch (code, name, sort) VALUES (?, ?, ?)
       ON CONFLICT (code) DO UPDATE SET name = excluded.name, sort = excluded.sort, enabled = 1`,
    )
    .bind(b.code, b.name, b.sort ?? 0)
    .run()
  await syncEodJob(c.env.DB)
  return ok({ code: b.code })
})

stock.delete('/watch/:code', async (c) => {
  await c.env.DB.prepare('DELETE FROM stock_watch WHERE code = ?').bind(c.req.param('code')).run()
  await syncEodJob(c.env.DB)
  return ok(null)
})

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
    return {
      code,
      name: nameOf.get(code) ?? f[0],
      price: Number(f[3]),
      change: Number(f[3]) - Number(f[2]),
      changePct: Number(f[2]) ? ((Number(f[3]) - Number(f[2])) / Number(f[2])) * 100 : 0,
      open: Number(f[1]), prevClose: Number(f[2]), high: Number(f[4]), low: Number(f[5]),
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
