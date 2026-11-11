/** 任务 = 数据不是代码（决策 #15）：poll 下发的只有纯数据 */
export interface Job {
  id: number
  type: string
  payload: unknown
}

/** 所有节点交互响应的统一信封（v4.9 捎带下发：jobs[0..1]） */
export interface Envelope {
  now: number
  jobs: Job[]
}

/** handler 产出统一为结构化 items 数组（M3 起按 100 条/批回传） */
export interface JobResult {
  items: unknown[]
  summary: string
}

export interface JobCtx {
  /** 被回收 / 易主 / 超时时置位，handler 在条目间检查 */
  signal: AbortSignal
  heartbeat(): Promise<void>
}

export type JobHandler = (payload: unknown, ctx: JobCtx) => Promise<JobResult>
