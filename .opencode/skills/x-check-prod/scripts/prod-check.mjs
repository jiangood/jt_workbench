#!/usr/bin/env node
/**
 * x-check-prod：线上只读健康检查。
 * 凭据：仓库根 online-token.txt（第1行 base URL，第2行 wb_token JWT）。
 * 退出码：0=全部通过；1=有失败；2=缺凭据/缺配置（应向用户索要）。
 * 只发 GET；不回显 token。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'

const root = process.env.JT_REPO_ROOT || process.cwd()
const file = path.join(root, 'online-token.txt')

let lines
try {
  lines = readFileSync(file, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
} catch {
  console.error('MISSING_CONFIG: online-token.txt 不存在（repo root: ' + root + '）')
  console.error('需要两行：第1行线上 base URL，第2行 wb_token 会话 token。请向用户索取。')
  process.exit(2)
}
const [base, token] = lines
if (!base || !token) {
  console.error('MISSING_TOKEN: online-token.txt 需要两行（base URL + wb_token），当前行数不足。请向用户索取。')
  process.exit(2)
}
if (!/^https?:\/\//i.test(base)) {
  console.error(`MISSING_CONFIG: base URL 不是 http(s)：${mask(base)}`)
  process.exit(2)
}

console.log(`base=${base} token=${mask(token)}`)

const checks = [
  { name: 'GET /api/health (public)', p: '/api/health', auth: false },
  { name: 'GET /api/auth/status (public)', p: '/api/auth/status', auth: false },
  { name: 'GET /api/me (session)', p: '/api/me', auth: true },
  { name: 'GET /api/admin/summary (session)', p: '/api/admin/summary', auth: true },
]

let failed = 0
for (const c of checks) {
  const headers = {}
  if (c.auth) headers.cookie = `wb_token=${token}`
  try {
    const res = await fetch(base + c.p, { headers, signal: AbortSignal.timeout(15_000) })
    const body = await res.json().catch(() => null)
    const okHttp = res.status === 200
    const okEnvelope = body && typeof body.code === 'number' ? body.code === 0 : okHttp
    const pass = okHttp && okEnvelope
    if (!pass) failed++
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${c.name}  http=${res.status} code=${body?.code ?? '-'} message=${body?.message ?? ''}`)
    if (pass && body?.data != null) console.log(`      data=${JSON.stringify(body.data)}`)
  } catch (e) {
    failed++
    console.log(`FAIL  ${c.name}  network=${e?.name ?? 'Error'}: ${e?.message ?? e}`)
  }
}

console.log(`RESULT: ${failed === 0 ? 'PASS' : 'FAIL'} (${checks.length - failed}/${checks.length})`)
process.exit(failed === 0 ? 0 : 1)

function mask(s) {
  return s.length <= 8 ? '***' : `${s.slice(0, 8)}…(len=${s.length})`
}
