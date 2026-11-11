/**
 * 知识星球极简客户端（TS 重写，agent 执行）
 * - 读接口只需 authorization token（对照 SDK 仓库 TestWithoutSignature 系列示例；
 *   SDK 的 HMAC-SHA1 签名为占位实现，真实 API 对 GET 读不校验签名）
 * - 响应包装 {succeeded, code, error, info, resp_data}
 */

const BASE = 'https://api.zsxq.com'

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
  ) {
    super(message)
  }
}

export class ZsxqClient {
  constructor(
    private readonly token: string,
    private readonly timeoutMs = 15_000,
  ) {}

  private async call<T>(path: string, params?: Record<string, unknown>): Promise<T> {
    const url = new URL(BASE + path)
    for (const [k, v] of Object.entries(params ?? {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v))
    }
    const res = await fetch(url, {
      headers: {
        authorization: this.token,
        'user-agent': 'xiaomiquan/2.57.0 workbench-agent',
        'x-version': '2.57.0',
        'x-request-id': crypto.randomUUID(),
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    const body = (await res.json()) as { succeeded?: boolean; code?: number; error?: string; info?: string; resp_data?: T }
    if (!body.succeeded) throw new ZsxqApiError(body.code ?? res.status, body.error ?? body.info ?? `HTTP ${res.status}`)
    return body.resp_data as T
  }

  listGroups(): Promise<{ groups: ZsxqGroup[] }> {
    return this.call('/v2/groups')
  }

  listTopics(groupId: string, count: number, endTime?: string): Promise<{ topics: ZsxqTopic[] }> {
    return this.call(`/v2/groups/${groupId}/topics`, { count, scope: 'all', end_time: endTime })
  }
}
