import type { Envelope } from './types.js'

const WORKER_URL = env('WORKER_URL')
const NODE_ID = env('NODE_ID')
const NODE_KEY = env('NODE_KEY')
const AGENT_VERSION = '0.1.0'

/** 配置错误 = 致命：立即抛出，main 里 exit(1)，不静默 */
function env(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`missing env: ${name}`)
  return v
}

export class FatalError extends Error {}
export class RetryableError extends Error {}
/** 409：任务已被回收/易主 → 中止当前任务（不 complete 不 fail） */
export class ConflictError extends Error {}

/** Worker API 封装；信封 {code, data, message}，返回 data（{now, jobs[]}）；nodeId/agentVersion 统一注入 */
async function call(path: string, body: Record<string, unknown> = {}): Promise<Envelope> {
  const res = await fetch(`${WORKER_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-node-key': NODE_KEY },
    body: JSON.stringify({ nodeId: NODE_ID, agentVersion: AGENT_VERSION, ...body }),
  })
  if (res.status === 401 || res.status === 403) {
    throw new FatalError(`node key rejected: HTTP ${res.status}`)
  }
  if (res.status === 409) throw new ConflictError(`lease lost: HTTP 409 ${path}`)
  if (!res.ok) throw new RetryableError(`HTTP ${res.status} ${path}`)
  const env = (await res.json()) as { code: number; data?: Envelope; message?: string }
  if (env.code !== 0) throw new RetryableError(`code ${env.code} ${path}: ${env.message ?? ''}`)
  return env.data ?? { now: Date.now(), jobs: [] }
}

export const client = {
  poll: () => call('/node/poll', { agentVersion: AGENT_VERSION }),
  heartbeat: (id: number) => call(`/node/jobs/${id}/heartbeat`),
  results: (id: number, items: unknown[]) => call(`/node/jobs/${id}/results`, { items }),
  complete: (id: number, summary: string) => call(`/node/jobs/${id}/complete`, { summary }),
  fail: (id: number, error: string) => call(`/node/jobs/${id}/fail`, { error }),
}
