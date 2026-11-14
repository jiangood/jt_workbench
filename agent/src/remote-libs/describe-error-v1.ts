/**
 * 错误描述：把 Error 连同 cause 链压成一行。
 * undici 的 `TypeError: fetch failed` 真正原因（ENOTFOUND / ECONNRESET / EPROTO…）只在 cause 里，
 * String(e) 会把它丢掉；job fail 的 message 会进 job.result，后台「最近任务运行」直接可读。
 */
export function describeError(e: unknown): string {
  if (!(e instanceof Error)) return String(e)

  const parts: string[] = []
  const seen = new Set<unknown>()
  let cur: unknown = e
  while (cur instanceof Error && !seen.has(cur)) {
    seen.add(cur)
    const code = (cur as { code?: unknown }).code
    const suffix = code === undefined || code === '' ? '' : ` [${String(code)}]`
    parts.push(`${cur.name}${suffix}: ${cur.message}`)
    cur = (cur as { cause?: unknown }).cause
  }
  if (cur !== undefined && cur !== null && !(cur instanceof Error)) parts.push(String(cur))
  return parts.join(' <- ')
}
