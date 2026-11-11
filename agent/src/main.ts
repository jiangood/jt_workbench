import pino from 'pino'
import { client, FatalError } from './client.js'
import { run, register } from './runner.js'
import { rssHandler } from './jobs/rss.js'
import { stockHandler } from './jobs/stock.js'
import { zsxqHandler } from './jobs/zsxq.js'

const log = pino()

// handler 注册表：查表分发，主循环永不因新功能而改（决策 #15）
register('rss_fetch', rssHandler)
register('stock_eod', stockHandler)
register('zsxq_sync', zsxqHandler)

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL ?? 600) * 1000 // 10 min（v4.6）
/** poll 抖动（v4.8）：±60~90s，多节点部署时各节点 poll 时点自然错峰 */
const jitterMs = () => {
  const delay = 60_000 + Math.random() * 30_000
  return Math.random() < 0.5 ? -delay : delay
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function main(): Promise<void> {
  log.info({ pollIntervalMs: POLL_INTERVAL_MS }, 'agent starting')
  while (true) {
    try {
      let { jobs } = await client.poll()
      while (jobs.length) {
        // 一次只干一个活（v4.9）；响应捎带下一个任务则链式连续，无活 → sleep 至下个 poll
        const next = await run(jobs[0])
        jobs = next.jobs
      }
    } catch (e) {
      if (e instanceof FatalError) {
        log.fatal({ err: String(e) }, 'fatal, exiting') // 配置错误不静默
        process.exit(1)
      }
      // 可重试错误：退避 30s，任务状态不动（lease 兜底）
      log.error({ err: String(e) }, 'poll failed')
      await sleep(30_000)
      continue
    }
    await sleep(POLL_INTERVAL_MS + jitterMs())
  }
}

// 优雅退出：SIGTERM → 当前任务收尾（M3 完善：runner 感知信号后再退出）
process.on('SIGTERM', () => process.exit(0))

main().catch((e: unknown) => {
  log.fatal(e)
  process.exit(1)
})
