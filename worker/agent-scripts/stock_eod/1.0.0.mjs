// @script
// {
//   "id": "stock_eod",
//   "name": "股票日线收盘同步",
//   "version": "1.0.0",
//   "description": "在 A 股交易日收盘后抓取自选股日线行情",
//   "schedule": "0 35 15 * * 1-5",
//   "enabled": true,
//   "timeout": 300,
//   "reliability": "best_effort"
// }

import { stockHandler } from '../../dist/remote-libs/stock-jobs-v1.mjs'

export async function run(ctx, payload) {
  if (!Array.isArray(payload?.codes) || payload.codes.length === 0) {
    return { items: [], summary: '没有启用的自选股' }
  }
  return stockHandler(payload, {
    signal: ctx.signal,
    heartbeat: typeof ctx.heartbeat === 'function' ? ctx.heartbeat : async () => {},
  })
}
