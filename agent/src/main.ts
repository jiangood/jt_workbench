import pino from 'pino'
import { client, UnauthorizedError } from './client.js'
import { getConfig } from './config.js'
import { describeError } from './describe-error.js'
import { run, register } from './runner.js'
import { maybeRequestUpdate } from './update.js'
import { rssHandler } from './jobs/rss.js'
import { stockHandler } from './jobs/stock.js'
import { zsxqHandler } from './jobs/zsxq.js'

const log = pino()

// handler 注册表：查表分发，主循环永不因新功能而改（决策 #15）
register('rss_fetch', rssHandler)
register('stock_eod', stockHandler)
register('zsxq_sync', zsxqHandler)

/** poll 抖动（v4.8）：±60~90s，多节点部署时各节点 poll 时点自然错峰 */
const jitterMs = () => {
  const delay = 60_000 + Math.random() * 30_000
  return Math.random() < 0.5 ? -delay : delay
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function main(): Promise<void> {
  const cfg = getConfig()

  log.info({ workerUrl: cfg.workerUrl, pollIntervalMs: cfg.pollIntervalMs }, 'agent starting')

  while (true) {
    try {
      const poll = await client.poll()
      let jobs = poll.jobs
      if (!jobs.length) {
        // 空闲：版本落后就让 Watchtower 立刻拉新镜像（老 compose 没配 → 什么也不做）
        await maybeRequestUpdate(poll.agentLatestVersion)
      }
      while (jobs.length) {
        // 一次只干一个活（v4.9）；响应捎带下一个任务则链式连续，无活 → sleep 至下个 poll
        const next = await run(jobs[0])
        jobs = next.jobs
      }
    } catch (e) {
      if (e instanceof UnauthorizedError) {
        // 密钥被重置 / 节点被注销：后台用「安装命令」重新部署后自动恢复
        log.warn(
          '节点未登记或密钥已失效：后台 /#/admin →「执行节点」→「安装命令」重装（60s 后重试，无需重启）',
        )
        await sleep(60_000)
        continue
      }
      // 可重试错误：退避 30s，任务状态不动（lease 兜底）
      log.error({ err: describeError(e) }, 'poll failed')
      await sleep(30_000)
      continue
    }
    await sleep(cfg.pollIntervalMs + jitterMs())
  }
}

// 优雅退出：SIGTERM → 当前任务收尾（M3 完善：runner 感知信号后再退出）
process.on('SIGTERM', () => process.exit(0))

main().catch((e: unknown) => {
  log.fatal(e)
  process.exit(1)
})
