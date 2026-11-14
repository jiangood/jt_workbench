/** SSRF 守卫：agent 默认拒绝内网/环回地址（allowPrivateAddress=false） */

import { describeError } from './describe-error-v1.js'

const BLOCKED_HOSTNAME =
  /^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.home\.arpa|.*\.lan)$/i

const TIMEOUT_MS = 30_000

export function assertPublicUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`invalid url: ${raw}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`blocked protocol: ${url.protocol}`)
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '') // 去掉 IPv6 括号
  if (
    BLOCKED_HOSTNAME.test(host) ||
    host === '::1' || host === '::' ||
    host.startsWith('127.') || host.startsWith('10.') || host.startsWith('192.168.') ||
    host.startsWith('169.254.') || host.startsWith('fc') || host.startsWith('fd') ||
    host.endsWith('.0/17') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host) || // CGNAT 100.64/10
    /^0\./.test(host)
  ) {
    throw new Error(`blocked private address: ${host}`)
  }
  return url
}

/** 任务中止信号 + 30s 超时（任一触发都中断请求） */
function combinedSignal(signal?: AbortSignal | null): AbortSignal {
  const timeout = AbortSignal.timeout(TIMEOUT_MS)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

/**
 * fetch 包装：前置校验 + 重定向后的最终 URL 复检 + 30s 超时。
 * 失败时抛带 URL 的包装错误，原因放 cause（runner 的 describeError 会展开成完整链路）。
 */
export async function safeFetch(url: string, init?: RequestInit): Promise<Response> {
  assertPublicUrl(url)
  let res: Response
  try {
    res = await fetch(url, { redirect: 'follow', ...init, signal: combinedSignal(init?.signal) })
  } catch (e) {
    throw new Error(`fetch ${url} failed`, { cause: e })
  }
  if (res.url && res.url !== url) assertPublicUrl(res.url)
  return res
}

/** 读响应体：超时/断流同样补上 URL（大 feed 常在读 body 阶段才超时） */
export async function readBody(res: Response, url: string): Promise<Uint8Array> {
  try {
    return new Uint8Array(await res.arrayBuffer())
  } catch (e) {
    throw new Error(`read ${url} failed`, { cause: e })
  }
}
