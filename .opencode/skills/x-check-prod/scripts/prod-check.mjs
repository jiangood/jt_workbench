#!/usr/bin/env node
/**
 * x-check-prod：线上健康检查（账号密码登录版，支持会话 cookie 缓存）。
 * 凭据：仓库根 online-token.txt（第1行 base URL，第2行账号 username，第3行密码 password）。
 * 缓存：仓库根 online-cookie.txt（gitignored，第1行 base URL，第2行 cookie；会话失效时自动重登并刷新）。
 * 工作流：优先用缓存 cookie 跑会话检查；失效则 POST /admin/auth/login（密码用登录页同款 eye 编码）重建会话。
 * 退出码：0=全部通过；1=有失败；2=缺凭据/缺配置（应向用户索要）。
 */
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import path from 'node:path'

const root = process.env.JT_REPO_ROOT || process.cwd()
const credFile = path.join(root, 'online-token.txt')
const cookieFile = path.join(root, 'online-cookie.txt')

let lines
try {
  lines = readFileSync(credFile, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
} catch {
  console.error('MISSING_CONFIG: online-token.txt 不存在（repo root: ' + root + '）')
  console.error('需要三行：第1行线上 base URL，第2行账号（username），第3行密码（password）。请向用户索要。')
  process.exit(2)
}
const [base, username, password] = lines
if (!base || !username || !password) {
  console.error('MISSING_CRED: online-token.txt 需要三行（base URL + username + password），当前行数不足。请向用户索要。')
  process.exit(2)
}
if (!/^https?:\/\//i.test(base)) {
  console.error(`MISSING_CONFIG: base URL 不是 http(s)：${mask(base)}`)
  process.exit(2)
}

console.log(`base=${base} account=${username}`)

// 登录页前端（生产 bundle 中 eye()）的密码编码：逐字符 codePoint + 序号 + 2，再 btoa。
// 线上 login 接口期望接收编码后的密码（AuthController.decodeWebPassword）。
function encodeWebPassword(raw) {
  const codes = []
  for (let i = 0; i < raw.length; i++) codes.push(raw.codePointAt(i) + i + 2)
  return btoa(String.fromCodePoint(...codes))
}

function loadCachedCookie(expectedBase) {
  try {
    const [b, c] = readFileSync(cookieFile, 'utf8').split(/\r?\n/).map((s) => s.trim())
    if (b === expectedBase && c) return c
  } catch {}
  return ''
}

function saveCachedCookie(b, c) {
  try { writeFileSync(cookieFile, `${b}\n${c}\n`, 'utf8') } catch {}
}

function clearCachedCookie() {
  try { unlinkSync(cookieFile) } catch {}
}

async function fetchJson(p, { method = 'GET', headers = {}, body } = {}) {
  const res = await fetch(base + p, { method, headers, body, signal: AbortSignal.timeout(15_000) })
  const json = await res.json().catch(() => null)
  const okHttp = res.status === 200
  const okEnvelope = json && typeof json.code === 'number' ? (json.code === 0 || json.code === 200) : okHttp
  return { res, json, pass: okHttp && okEnvelope }
}

function isAuthFail(result) {
  if (!result) return true
  const { res, json } = result
  if (res.status === 401) return true
  // login-info 未登录时返回 code=500, message=未登录
  if (json?.code === 500 && typeof json?.message === 'string' && json.message.includes('未登录')) return true
  return false
}

let cookie = loadCachedCookie(base)
let failed = 0
let loginSkipped = false

if (cookie) {
  // 先用缓存 cookie 验证会话，避免不必要的登录 POST
  const probe = await fetchJson('/admin/public/login-info', { headers: { cookie } }).catch((e) => ({ err: e }))
  if (probe.err || !probe.pass || isAuthFail(probe)) {
    clearCachedCookie()
    cookie = ''
  } else {
    loginSkipped = true
  }
}

if (!cookie) {
  // 登录（建立会话）
  let loginBody = null
  try { loginBody = { username, password: encodeWebPassword(password) } } catch {}
  if (!loginBody) {
    failed++
    console.log('FAIL  POST /admin/auth/login  error=密码编码失败（密码含不支持字符）')
  } else {
    try {
      const { res, json, pass: basePass } = await fetchJson('/admin/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(loginBody),
      })
      cookie = (res.headers.getSetCookie?.() ?? []).map((s) => s.split(';')[0]).filter(Boolean).join('; ')
      const pass = basePass && cookie.length > 0
      console.log(`${pass ? 'PASS' : 'FAIL'}  POST /admin/auth/login (login → session cookie)  http=${res.status} code=${json?.code ?? '-'} message=${json?.message ?? ''} cookie=${cookie ? 'ok' : 'none'}`)
      if (pass) saveCachedCookie(base, cookie)
      else { cookie = ''; failed++ }
    } catch (e) {
      failed++
      console.log(`FAIL  POST /admin/auth/login  network=${e?.name ?? 'Error'}: ${e?.message ?? e}`)
    }
  }
} else {
  console.log('SKIP  POST /admin/auth/login (使用缓存会话 cookie，未重新登录)')
}

// 只读 GET 检查（线上实际接口）
const checks = [
  { name: 'GET /admin/public/site-info (public)', p: '/admin/public/site-info' },
  { name: 'GET /admin/public/login-info (session)', p: '/admin/public/login-info', session: true },
  { name: 'GET /admin/user-center/sessions (session)', p: '/admin/user-center/sessions', session: true },
]

for (const c of checks) {
  const headers = {}
  if (c.session && cookie) headers.cookie = cookie
  try {
    const { res, json, pass: basePass } = await fetchJson(c.p, { headers })
    let pass = basePass
    if (c.session && !cookie) pass = false
    // 若是缓存 cookie 导致的会话失效，不在此自动重登以免隐藏问题；报告 FAIL 即可。
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${c.name}  http=${res.status} code=${json?.code ?? '-'} message=${json?.message ?? ''}`)
    if (pass && json?.data != null) console.log(`      data=${JSON.stringify(json.data).slice(0, 400)}`)
    if (!pass) {
      failed++
      if (c.session && loginSkipped && isAuthFail({ res, json })) clearCachedCookie()
    }
  } catch (e) {
    failed++
    console.log(`FAIL  ${c.name}  network=${e?.name ?? 'Error'}: ${e?.message ?? e}`)
  }
}

const total = 1 + checks.length
console.log(`RESULT: ${failed === 0 ? 'PASS' : 'FAIL'} (${total - failed}/${total})`)
process.exit(failed === 0 ? 0 : 1)

function mask(s) {
  return s.length <= 8 ? '***' : `${s.slice(0, 8)}…(len=${s.length})`
}
