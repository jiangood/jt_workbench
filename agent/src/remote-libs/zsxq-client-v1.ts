/**
 * 知识星球客户端（适配层）
 * - 底层使用社区 SDK（yiancode/zsxq-sdk，MIT，源码 vendored 于 ./vendor/zsxq-sdk）
 * - 对外保持项目既有接口/类型与错误语义，兼容 jobs/ingest
 * - 1059/瞬时故障、网络异常按可重试处理；保留 httpStatus 供删除判定使用
 */

import { describeError } from '../describe-error.js'
import {
  ZsxqClient as SdkClient,
  ZsxqClientBuilder,
  ZsxqException,
  NetworkException,
  TimeoutException,
  RateLimitException,
} from '../vendor/zsxq-sdk/index.js'

const MAX_ATTEMPTS = 3
const RETRY_DELAYS_MS = [3_000, 10_000]

/** 知识星球用户（星主判定靠 user_id；name 只用于展示） */
export interface ZsxqUser {
  user_id?: number
  name?: string
}

/** 图片三档尺寸；原图拿不到时退 large / middle */
export interface ZsxqImage {
  original?: { url: string; width: number; height: number }
  large?: { url: string }
  middle?: { url: string }
  thumbnail_url?: string
}

export interface ZsxqFileRef {
  file_id: number
  name: string
  size: number
}

export interface ZsxqTopic {
  topic_id: number
  title?: string
  type: string
  create_time: string
  likes_count?: number
  comments_count?: number
  owner?: ZsxqUser
  talk?: {
    owner?: ZsxqUser
    text?: string
    images?: ZsxqImage[]
    files?: ZsxqFileRef[]
  }
}

export interface ZsxqComment {
  comment_id: number
  create_time: string
  owner?: ZsxqUser
  text?: string
  images?: ZsxqImage[]
  files?: ZsxqFileRef[]
}

export interface ZsxqTopicInfo {
  topic_id?: number
  title?: string
  comments_count?: number
  likes_count?: number
  counts?: {
    comments?: number
    likes?: number
  }
}

export interface ZsxqGroup {
  group_id: number
  name: string
}

export interface ZsxqGroupDetail {
  group_id?: number
  name?: string
  owner?: ZsxqUser
  owner_id?: number
  group?: ZsxqGroupDetail
}

export class ZsxqApiError extends Error {
  constructor(
    public code: number,
    message: string,
    public retryable = false,
    public httpStatus?: number,
  ) {
    super(message)
    this.name = 'ZsxqApiError'
  }
}

function isTransientCode(code: number): boolean {
  return code === 1059
}

function asZsxqApiError(e: unknown, fallbackPath: string): ZsxqApiError {
  if (e instanceof ZsxqApiError) return e

  if (e instanceof RateLimitException) {
    const err = e as Error & { code?: number }
    return new ZsxqApiError(Number(err.code) || 40001, err.message || '请求过于频繁', true)
  }
  if (e instanceof NetworkException || e instanceof TimeoutException) {
    const err = e as Error & { code?: number }
    return new ZsxqApiError(Number(err.code) || 70001, `zsxq ${fallbackPath} 请求失败: ${err.message}`, true)
  }
  if (e instanceof ZsxqException) {
    const err = e as Error & { code?: number }
    const code = Number(err.code) || 0
    const retryable = isTransientCode(code) || code >= 500
    return new ZsxqApiError(code, err.message || '知识星球接口错误', retryable)
  }

  if (e instanceof Error && e.name === 'AbortError') {
    return new ZsxqApiError(0, e.message || 'aborted', false)
  }
  if (e instanceof Error) {
    // axios/network 类未知异常按瞬时处理（与旧实现一致：abort 除外）
    return new ZsxqApiError(70001, `zsxq ${fallbackPath} 请求失败: ${describeError(e)}`, true)
  }
  return new ZsxqApiError(70001, `zsxq ${fallbackPath} 请求失败`, true)
}

function isTransient(e: unknown): boolean {
  if (e instanceof ZsxqApiError) return e.retryable
  return e instanceof Error && e.name !== 'AbortError'
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'))
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason ?? new Error('aborted'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export class ZsxqClient {
  private readonly sdk: SdkClient
  private readonly timeoutMs: number

  constructor(token: string, timeoutMs = 15_000) {
    this.timeoutMs = timeoutMs
    // 使用社区 SDK（yiancode/zsxq-sdk，MIT，vendored）作为底层请求实现
    // 禁用 SDK 内部重试，由本适配层统一控制 1059/瞬时重试与错误语义
    this.sdk = new ZsxqClientBuilder()
      .setToken(token)
      .setTimeout(timeoutMs)
      .setRetryCount(0)
      .setAppVersion('2.83.0')
      .build()
  }

  private get http() {
    return this.sdk.httpClient as unknown as {
      get<R>(path: string, params?: Record<string, unknown>, signal?: AbortSignal): Promise<R>
    }
  }

  private async call<T>(path: string, params?: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    let lastErr: unknown
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1] ?? 5_000, signal)
      try {
        const timeout = AbortSignal.timeout(this.timeoutMs)
        const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
        return await this.http.get<T>(path, params, combined)
      } catch (e) {
        if (signal?.aborted) throw e
        const err = asZsxqApiError(e, path)
        lastErr = err
        if (!isTransient(err)) throw err
      }
    }

    if (lastErr instanceof ZsxqApiError && lastErr.code === 1059) {
      throw new ZsxqApiError(
        lastErr.code,
        `${lastErr.message}（知识星球接口瞬时故障或限流，已自动重试 ${MAX_ATTEMPTS} 次，请稍后再试）`,
        lastErr.retryable,
        lastErr.httpStatus,
      )
    }
    throw lastErr
  }

  async listGroups(signal?: AbortSignal): Promise<{ groups: ZsxqGroup[] }> {
    return this.call<{ groups: ZsxqGroup[] }>('/v2/groups', undefined, signal)
  }

  async groupDetail(groupId: string, signal?: AbortSignal): Promise<ZsxqGroupDetail> {
    const data = await this.call<any>(`/v2/groups/${groupId}`, undefined, signal)
    return (data?.group ?? data) as ZsxqGroupDetail
  }

  async listTopics(
    groupId: string,
    count: number,
    endTime?: string,
    signal?: AbortSignal,
  ): Promise<{ topics: ZsxqTopic[] }> {
    const params: Record<string, unknown> = { count, scope: 'all' }
    if (endTime) params.end_time = endTime
    return this.call<{ topics: ZsxqTopic[] }>(`/v2/groups/${groupId}/topics`, params, signal)
  }

  async topicInfo(topicId: string, signal?: AbortSignal): Promise<{ topic?: ZsxqTopicInfo }> {
    return this.call<{ topic?: ZsxqTopicInfo }>(`/v2/topics/${topicId}/info`, undefined, signal)
  }

  async listComments(
    topicId: string,
    count: number,
    endTime?: string,
    signal?: AbortSignal,
  ): Promise<{ comments: ZsxqComment[] }> {
    const params: Record<string, unknown> = { sort: 'asc', count }
    if (endTime) params.end_time = endTime
    return this.call<{ comments: ZsxqComment[] }>(`/v2/topics/${topicId}/comments`, params, signal)
  }

  async fileDownloadUrl(fileId: string | number, signal?: AbortSignal): Promise<{ download_url?: string }> {
    return this.call<{ download_url?: string }>(`/v2/files/${fileId}/download_url`, undefined, signal)
  }
}
