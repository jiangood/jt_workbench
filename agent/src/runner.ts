import pino from 'pino'
import { client, ConflictError, RetryableError } from './client.js'
import { describeError } from './describe-error.js'
import { classifyError } from './error-kind.js'
import type { Envelope, Job, JobCtx, JobHandler } from './types.js'

const log = pino()
const HEARTBEAT_MS = 2 * 60_000 // lease 10min，3 次容错
const BATCH_SIZE = 100         // items 分块回传（Worker 侧 JSON.parse + D1 batch 在 10ms 预算内）
const BATCH_RETRY = 3

/** 单批回传，重试 3 次；3 次仍失败 → 抛出走 fail（Worker 按退避重试，已入库批被唯一约束吸收） */
async function postResults(jobId: number, items: unknown[], signal: AbortSignal): Promise<void> {
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    if (signal.aborted) throw new Error('job aborted before posting results')
    const batch = items.slice(i, i + BATCH_SIZE)
    let lastErr: unknown = null
    for (let attempt = 0; attempt < BATCH_RETRY; attempt++) {
      if (signal.aborted) throw new Error('job aborted before posting results')
      try {
        await client.results(jobId, batch)
        lastErr = null
        break
      } catch (e) {
        if (signal.aborted) throw e
        lastErr = e
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)))
      }
    }
    if (lastErr) throw lastErr
  }
}

/**
 * handler 注册表：任务=数据不是代码，type 只是查表键。
 * M3 起填充（rss_fetch / stock_eod / zsxq_sync ...）；查无此表 → fail 'unknown type'（验收场景 #5）
 */
const handlers = new Map<string, JobHandler>()

export function register(type: string, handler: JobHandler): void {
  handlers.set(type, handler)
}

/**
 * 串行执行单个任务（v4.9 单任务模型）：
 * 自动心跳（handler 无感知）→ 干活 → items 分批回传（M3）→ complete/fail 恰好一个
 * 返回响应信封——捎带下发时 jobs 可能携带下一个任务，实现链式连续
 */
export async function run(job: Job): Promise<Envelope> {
  const handler = handlers.get(job.type)
  if (!handler) {
    log.warn({ jobId: job.id, type: job.type }, 'unknown type')
    return client.fail(job.id, `unknown type: ${job.type}`)
  }

  const ac = new AbortController()
  const hb = setInterval(() => {
    client.heartbeat(job.id).catch((e: unknown) => {
      // 409 = 任务已被回收/易主 → 中止当前任务（不 complete 不 fail，所有权已易主）
      if (e instanceof ConflictError) ac.abort()
      else if (!(e instanceof RetryableError)) ac.abort()
      log.warn({ jobId: job.id, err: String(e) }, 'heartbeat failed')
    })
  }, HEARTBEAT_MS)

  const ctx: JobCtx = {
    signal: ac.signal,
    heartbeat: () => client.heartbeat(job.id).then(() => undefined),
  }
  try {
    const { items, summary } = await handler(job.payload, ctx)
    // 被回收/易主或 handler 主动中止时，丢弃本轮未提交结果；让租约回收机制重新派发任务。
    if (ac.signal.aborted || summary.trim().toLowerCase() === 'aborted') {
      return { now: Date.now(), jobs: [] }
    }
    // items 按 100 条/批 POST /results，幂等靠业务表唯一约束（天然断点续传）
    if (items.length) await postResults(job.id, items, ac.signal)
    if (ac.signal.aborted) return { now: Date.now(), jobs: [] }
    return await client.complete(job.id, summary)
  } catch (e) {
    if (ac.signal.aborted) return { now: Date.now(), jobs: [] } // 被回收：沉默放弃
    // 带上 type + cause 链：fetch failed 的真实原因（ENOTFOUND/ECONNRESET/超时）都在 cause 里
    const reason = describeError(e)
    const kind = classifyError(e)
    log.error({ jobId: job.id, type: job.type, kind, err: reason }, 'job failed')
    return client.fail(job.id, reason.slice(0, 500), kind)
  } finally {
    clearInterval(hb)
  }
}
