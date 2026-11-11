/** SSRF 守卫：agent 默认拒绝内网/环回地址（allowPrivateAddress=false） */

const BLOCKED_HOSTNAME =
  /^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.home\.arpa|.*\.lan)$/i

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

/** fetch 包装：前置校验 + 重定向后的最终 URL 复检 + 30s 超时 */
export async function safeFetch(url: string, init?: RequestInit): Promise<Response> {
  assertPublicUrl(url)
  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(30_000),
    ...init,
  })
  if (res.url && res.url !== url) assertPublicUrl(res.url)
  return res
}
