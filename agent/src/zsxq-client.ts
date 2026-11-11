/**
 * 知识星球极简客户端（TS 重写，agent 执行）
 * - 读接口只需 authorization token（对照 SDK 仓库 TestWithoutSignature 系列示例；
 *   SDK 的 HMAC-SHA1 签名为占位实现，真实 API 对 GET 读不校验签名）
 * - 响应包装 {succeeded, code, error, info, resp_data}
 * - 1059「内部错误」是知识星球服务端的瞬时故障 / 限流，直接重试往往就过；
 *   网络异常、非 JSON（风控页）、5xx 同样按瞬时错误退避重试
 */

import { describeError } from './describe-error.js'

const BASE = 'https://api.zsxq.com'
const MAX_ATTEMPTS = 3
const RETRY_DELAYS_MS = [3_000, 10_000] // 第 2/3 次尝试前的等待（1059 频繁时更需要留出间隙）

export interface ZsxqTopic {
  topic_id: number
  title?: string
  type: string
  create_time: string
  talk?: {
    text?: string
    images?: Array<{ original?: { url: string; width: number; height: number }; large?: { url: string }; middle?: { url: string }; thumbnail_url?: string }>
    files?: Array<{ file_id: number; name: string; size: number }>
  }
}

export interface ZsxqGroup {
  group_id: number
  name: string
}

export class ZsxqApiError extends Error {
  constructor(
    public code: number,
    message: string,
    /** 是否值得重试（1059 / 5xx / 风控页这类瞬时错误） */
    public retryable = false,
  ) {
    super(message)
    this.name = 'ZsxqApiError'
  }
}

/** 1059 = 服务端「内部错误」，多数是瞬时故障或限流（见 zsxq 社区项目的一致结论） */
function isTransientCode(code: number): boolean {
  return code === 1059
}

export class ZsxqClient {
  constructor(
    private readonly token: string,
    private readonly timeoutMs = 15_000,
  ) {}

  private async call<T>(path: string, params?: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const url = new URL(BASE + path)
    for (const [k, v] of Object.entries(params ?? {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v))
    }

    let lastErr: unknown
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1] ?? 5_000, signal)
      try {
        return await this.request<T>(url, signal)
      } catch (e) {
        lastErr = e
        if (signal?.aborted || !isTransient(e)) throw e
      }
    }

    // 1059 重试仍失败：把「不是 token 问题、稍后再试」说清楚，免得用户反复重置凭据
    if (lastErr instanceof ZsxqApiError && lastErr.code === 1059) {
      throw new ZsxqApiError(
        lastErr.code,
        `${lastErr.message}（知识星球接口瞬时故障或限流，已自动重试 ${MAX_ATTEMPTS} 次，请稍后再试）`,
      )
    }
    throw lastErr
  }

  private async request<T>(url: URL, signal?: AbortSignal): Promise<T> {
    const timeout = AbortSignal.timeout(this.timeoutMs)
    let res: Response
    try {
      res = await fetch(url, {
        headers: {
          authorization: this.token,
          'user-agent': 'xiaomiquan/2.57.0 workbench-agent',
          'x-version': '2.57.0',
          'x-request-id': crypto.randomUUID(),
        },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      })
    } catch (e) {
      // 网络异常 / 超时：保留 cause 链交给上层 describeError 展开
      throw new Error(`zsxq ${url.pathname} 请求失败`, { cause: e })
    }
    let body: { succeeded?: boolean; code?: number; error?: string; info?: string; resp_data?: T }
    try {
      body = (await res.json()) as typeof body
    } catch (e) {
      // 风控页 / 网关错误页会返回 HTML，JSON 解析失败时保留状态码与原因；这类页面通常是瞬时的
      throw new ZsxqApiError(res.status, `非 JSON 响应（HTTP ${res.status}）: ${describeError(e)}`, true)
    }
    if (!body.succeeded) {
      const code = body.code ?? res.status
      // 业务码 1059 与 HTTP 5xx 都算瞬时；1001「未登录」这类要立刻报出来，别白等重试
      const retryable = isTransientCode(code) || res.status >= 500
      throw new ZsxqApiError(code, body.error ?? body.info ?? `HTTP ${res.status}`, retryable)
    }
    return body.resp_data as T
  }

  listGroups(signal?: AbortSignal): Promise<{ groups: ZsxqGroup[] }> {
    return this.call('/v2/groups', undefined, signal)
  }

  listTopics(
    groupId: string,
    count: number,
    endTime?: string,
    signal?: AbortSignal,
  ): Promise<{ topics: ZsxqTopic[] }> {
    return this.call(`/v2/groups/${groupId}/topics`, { count, scope: 'all', end_time: endTime }, signal)
  }
}

/** 瞬时错误：标注了 retryable 的接口错误，以及 fetch 的网络异常 / 超时（abort 除外） */
function isTransient(e: unknown): boolean {
  if (e instanceof ZsxqApiError) return e.retryable
  return e instanceof Error && e.name !== 'AbortError'
}

/** 退避等待；任务被回收时立刻中断，不拖着 lease 不放 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
