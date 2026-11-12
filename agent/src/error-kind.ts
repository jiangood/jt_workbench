/**
 * 失败归因（issue #4）：只有「网络类」故障才允许 Worker 扣该节点对该目标的评分。
 * HTTP 403/404、feed 解析失败之类是目标站点的内容问题，不该算节点网络质量。
 *
 * agent 是错误的第一现场（cause 链里有真实的 ENOTFOUND / ECONNREFUSED），
 * 所以在 agent 侧判定一次，随 fail 上报 errorKind；Worker 只做兜底关键词判断。
 */

export type ErrorKind = 'network' | 'http' | 'parse' | 'other'

/** Node / undici 的网络类错误码：连接、解析、超时、对端断开 */
const NETWORK_CODES = new Set([
  'ETIMEDOUT',
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
  'EPIPE',
  'EPROTO',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
])

/** 只看 cause 链上的 code / name，不做消息文本猜测（403 的响应体里也可能出现 timeout 字样） */
export function classifyError(e: unknown): ErrorKind {
  const seen = new Set<unknown>()
  let cur: unknown = e
  while (cur instanceof Error && !seen.has(cur)) {
    seen.add(cur)
    const code = (cur as { code?: unknown }).code
    if (typeof code === 'string' && NETWORK_CODES.has(code.toUpperCase())) return 'network'
    // AbortSignal.timeout() 抛的是 DOMException: TimeoutError
    if (cur.name === 'TimeoutError') return 'network'
    cur = (cur as { cause?: unknown }).cause
  }
  return 'other'
}
