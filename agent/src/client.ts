import { getConfig } from './config.js'
import type { Envelope } from './types.js'
import { AGENT_VERSION } from './version.js'
import type { AgentNextRequest, AgentNextResponse } from './script-sync.mjs'

export class RetryableError extends Error {}
/** 401/403：密钥未登记 / 已被注销 —— 不是配置错误，等待后台登记后自动恢复 */
export class UnauthorizedError extends Error {}
/** 409：任务已被回收/易主 → 中止当前任务（不 complete 不 fail） */
export class ConflictError extends Error {}

/** Worker API 封装；信封 {code, data, message}，返回 data（{now, jobs[]}）；agentVersion 统一注入 */
async function call(path: string, body: Record<string, unknown> = {}): Promise<Envelope> {
  const { serverUrl, nodeKey } = getConfig()
  const res = await fetch(`${serverUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-node-key': nodeKey },
    signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({ agentVersion: AGENT_VERSION, ...body }),
  })
  if (res.status === 401 || res.status === 403) {
    throw new UnauthorizedError(`node key not registered: HTTP ${res.status}`)
  }
  if (res.status === 409) throw new ConflictError(`lease lost: HTTP 409 ${path}`)
  if (!res.ok) throw new RetryableError(`HTTP ${res.status} ${path}`)
  const env = (await res.json()) as { code: number; data?: Envelope; message?: string }
  if (env.code !== 0) throw new RetryableError(`code ${env.code} ${path}: ${env.message ?? ''}`)
  return env.data ?? { now: Date.now(), jobs: [] }
}

export const client = {
  poll: () => call('/node/poll'),
  /** Unified sync / trigger / lease / result protocol. */
  next: (request: AgentNextRequest) =>
    call('/node/agent/next', request as unknown as Record<string, unknown>) as unknown as Promise<AgentNextResponse>,
  heartbeat: (id: number) => call(`/node/jobs/${id}/heartbeat`),
  results: (id: number, items: unknown[]) => call(`/node/jobs/${id}/results`, { items }),
  complete: (id: number, summary: string) => call(`/node/jobs/${id}/complete`, { summary }),
  /** errorKind：网络类失败才让 Worker 扣节点评分（issue #4），老版本 Worker 会忽略这个字段 */
  fail: (id: number, error: string, errorKind?: string) =>
    call(`/node/jobs/${id}/fail`, errorKind ? { error, errorKind } : { error }),
}
