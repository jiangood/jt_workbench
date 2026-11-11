/**
 * 登录：盐 + 双轮 SHA-256 + JWT(HMAC-SHA256, 30 天) + auth_state 撤销
 *
 * 凭据存 D1（auth_state 单行表），后台可改密、首次访问可初始化；
 * wrangler secret（ADMIN_USER / ADMIN_PWD_SALT / ADMIN_PWD_HASH）只作一次性引导：
 * 老部署第一次登录成功时自动搬进 D1，之后改密不再需要重新写 secret。
 */

import { fail, ok, type Bindings, type Env } from './envelope'
import { cacheGet, cacheSet } from './cache'
import type { Context, Next } from 'hono'
import { getCookie } from 'hono/cookie'

const SESSION_MS = 30 * 86400_000
export const COOKIE_NAME = 'wb_token'
export const MIN_PASSWORD_LEN = 8

// 登录失败限频（按来源 IP，滑动 15 分钟）：公开仓库后用户名是已知的，只靠密码强度不够
const LOGIN_WINDOW_MS = 15 * 60_000
const LOGIN_MAX_FAILS = 10

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** SHA256(salt ‖ SHA256(pwd)) —— 与 scripts/gen-password.mjs 输出一致 */
export async function hashPassword(password: string, salt: string): Promise<string> {
  return sha256Hex(salt + (await sha256Hex(password)))
}

function randomHex(bytes = 16): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// ---------- 凭据（D1） ----------

export interface Credential {
  username: string | null
  pwd_hash: string | null
  pwd_salt: string | null
}

/** 读 D1 凭据。0009 未迁移（列不存在）时按「未配置」处理，login 仍可走 secret 引导 */
export async function readCredential(env: Bindings): Promise<Credential | null> {
  try {
    return await env.DB.prepare('SELECT username, pwd_hash, pwd_salt FROM auth_state WHERE id = 1').first<Credential>()
  } catch {
    return null
  }
}

export async function isInitialized(env: Bindings): Promise<boolean> {
  const cred = await readCredential(env)
  return !!(cred?.pwd_hash || env.ADMIN_PWD_HASH)
}

/**
 * 撤销基线：截断到整秒。
 * 中间件按 iat(秒)×1000 与它比较，同一秒内「改密 → 重新登录」不会被误判成旧会话。
 */
export function revocationBaseline(): number {
  return Math.floor(Date.now() / 1000) * 1000
}

async function writeCredential(env: Bindings, username: string, hash: string, salt: string): Promise<void> {
  await env.DB
    .prepare(
      `INSERT INTO auth_state (id, password_changed_at, username, pwd_hash, pwd_salt)
       VALUES (1, 0, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET username = excluded.username,
         pwd_hash = excluded.pwd_hash, pwd_salt = excluded.pwd_salt`,
    )
    .bind(username, hash, salt)
    .run()
}

async function verifyCredential(env: Bindings, username: string, password: string): Promise<boolean> {
  const cred = await readCredential(env)
  if (cred?.pwd_hash && cred.pwd_salt) {
    const user = cred.username ?? env.ADMIN_USER ?? 'admin'
    return username === user && (await hashPassword(password, cred.pwd_salt)) === cred.pwd_hash
  }

  // 兼容老部署：secret 里的凭据校验通过后搬进 D1（幂等）
  if (!env.ADMIN_PWD_HASH || !env.ADMIN_PWD_SALT) return false
  const user = env.ADMIN_USER ?? 'admin'
  if (username !== user) return false
  if ((await hashPassword(password, env.ADMIN_PWD_SALT)) !== env.ADMIN_PWD_HASH) return false
  try {
    await writeCredential(env, user, env.ADMIN_PWD_HASH, env.ADMIN_PWD_SALT)
  } catch (err) {
    console.error('seed auth credential failed:', String(err)) // 迁移未跑：本次仍放行，下轮登录重试
  }
  return true
}

// ---------- JWT ----------

interface JwtPayload {
  sub: string
  iat: number // 秒（RFC 7519）；与 auth_state.password_changed_at（毫秒）比较前统一为毫秒
  exp: number // 秒
}

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const bin = btoa(String.fromCharCode(...new Uint8Array(bytes)))
  return bin.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return b64url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)))
}

export async function issueJwt(secret: string, username: string): Promise<{ token: string; iatSec: number }> {
  const iat = Math.floor(Date.now() / 1000)
  const payload: JwtPayload = { sub: username, iat, exp: iat + Math.floor(SESSION_MS / 1000) }
  const head = b64url(new TextEncoder().encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })))
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)))
  return { token: `${head}.${body}.${await hmac(secret, `${head}.${body}`)}`, iatSec: iat }
}

export async function verifyJwt(secret: string, token: string | undefined): Promise<JwtPayload | null> {
  if (!token) return null
  const [head, body, sig] = token.split('.')
  if (!head || !body || !sig) return null
  if ((await hmac(secret, `${head}.${body}`)) !== sig) return null
  try {
    const payload = JSON.parse(atob(body.replace(/-/g, '+').replace(/_/g, '/'))) as JwtPayload
    if (payload.exp * 1000 < Date.now()) return null
    return payload
  } catch {
    return null
  }
}

// ---------- 端点 ----------

async function readBody<T>(c: Context<Env>): Promise<T> {
  try {
    return await c.req.json<T>()
  } catch {
    return {} as T
  }
}

function setSessionCookie(c: Context<Env>, token: string): void {
  c.header(
    'Set-Cookie',
    `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.floor(SESSION_MS / 1000)}`,
  )
}

function clearSessionCookie(c: Context<Env>): void {
  c.header('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`)
}

async function startSession(c: Context<Env>, username: string): Promise<void> {
  const { token } = await issueJwt(c.env.JWT_SECRET, username)
  setSessionCookie(c, token)
}

function clientIp(c: Context<Env>): string {
  return c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local'
}

/** 登录页用：是否需要首访初始化（公开端点，不泄漏账号信息） */
export async function authStatus(c: Context<Env>): Promise<Response> {
  return ok({ initialized: await isInitialized(c.env), minPasswordLength: MIN_PASSWORD_LEN })
}

export async function login(c: Context<Env>): Promise<Response> {
  const ip = clientIp(c)
  const failKey = `auth:fail:${ip}`
  const fails = Number((await cacheGet(c.env.DB, failKey)) ?? 0)
  if (fails >= LOGIN_MAX_FAILS) return fail(429, 429, 'too many failed attempts, try again later')

  const { username, password } = await readBody<{ username?: string; password?: string }>(c)
  if (!username || !password) return fail(400, 400, 'username/password required')

  const valid = await verifyCredential(c.env, username, password)
  if (!valid) {
    await cacheSet(c.env.DB, failKey, String(fails + 1), LOGIN_WINDOW_MS)
    return fail(401, 401, 'invalid credentials')
  }
  await cacheSet(c.env.DB, failKey, '0', LOGIN_WINDOW_MS)

  // auth_state 撤销基线：首登种子 password_changed_at=0（改密码时才推进）
  await c.env.DB
    .prepare('INSERT INTO auth_state (id, password_changed_at) VALUES (1, 0) ON CONFLICT (id) DO NOTHING')
    .run()

  await startSession(c, username)
  return c.json({ code: 0, data: { username }, message: 'ok' })
}

/** 首次访问初始化：仅在 D1 无凭据且未配置 secret 引导时可用（并发只有一个生效） */
export async function setup(c: Context<Env>): Promise<Response> {
  if (await isInitialized(c.env)) return fail(409, 409, 'already initialized')

  const { username, password } = await readBody<{ username?: string; password?: string }>(c)
  const name = username?.trim() || c.env.ADMIN_USER || 'admin'
  if (!name || !password) return fail(400, 400, 'username/password required')
  if (name.length > 32) return fail(400, 400, 'username too long')
  if (password.length < MIN_PASSWORD_LEN) return fail(400, 400, `password must be at least ${MIN_PASSWORD_LEN} chars`)
  if (await isInitialized(c.env)) return fail(409, 409, 'already initialized')

  const salt = randomHex()
  const hash = await hashPassword(password, salt)
  try {
    await c.env.DB
      .prepare(
        `INSERT INTO auth_state (id, password_changed_at, username, pwd_hash, pwd_salt)
         VALUES (1, 0, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET username = excluded.username,
           pwd_hash = excluded.pwd_hash, pwd_salt = excluded.pwd_salt
         WHERE auth_state.pwd_hash IS NULL`,
      )
      .bind(name, hash, salt)
      .run()
  } catch (err) {
    console.error('setup failed:', String(err))
    return fail(500, 500, 'auth schema not ready (run d1 migrations)')
  }

  const cred = await readCredential(c.env)
  if (cred?.pwd_hash !== hash) return fail(409, 409, 'already initialized')

  await startSession(c, name)
  return c.json({ code: 0, data: { username: name, initialized: true }, message: 'ok' })
}

/** 后台改密：校验当前密码 → 写 D1 → 推进 password_changed_at（撤销全部旧会话，含本次） */
export async function changePassword(c: Context<Env>): Promise<Response> {
  const { oldPassword, newPassword } = await readBody<{ oldPassword?: string; newPassword?: string }>(c)
  if (!oldPassword || !newPassword) return fail(400, 400, 'oldPassword/newPassword required')
  if (newPassword.length < MIN_PASSWORD_LEN) return fail(400, 400, `password must be at least ${MIN_PASSWORD_LEN} chars`)

  const cred = await readCredential(c.env)
  const salt = cred?.pwd_salt ?? c.env.ADMIN_PWD_SALT
  const hash = cred?.pwd_hash ?? c.env.ADMIN_PWD_HASH
  if (!salt || !hash) return fail(400, 400, 'credential not initialized')
  if ((await hashPassword(oldPassword, salt)) !== hash) return fail(403, 403, 'old password incorrect')

  const username = cred?.username ?? c.env.ADMIN_USER ?? 'admin'
  const nextSalt = randomHex()
  const nextHash = await hashPassword(newPassword, nextSalt)
  try {
    await c.env.DB
      .prepare(
        `INSERT INTO auth_state (id, password_changed_at, username, pwd_hash, pwd_salt)
         VALUES (1, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET password_changed_at = excluded.password_changed_at,
           username = excluded.username, pwd_hash = excluded.pwd_hash, pwd_salt = excluded.pwd_salt`,
      )
      .bind(revocationBaseline(), username, nextHash, nextSalt)
      .run()
  } catch (err) {
    console.error('change password failed:', String(err))
    return fail(500, 500, 'auth schema not ready (run d1 migrations)')
  }

  clearSessionCookie(c)
  return c.json({ code: 0, data: { changed: true, relogin: true }, message: 'ok' })
}

export async function logout(c: Context<Env>): Promise<Response> {
  clearSessionCookie(c)
  return c.json({ code: 0, data: null, message: 'ok' })
}

/** /api/* JWT 中间件（公开端点已在 index.ts 里先注册，不会进这里）：签名 + 过期 + auth_state 撤销 */
export async function authMiddleware(c: Context<Env>, next: Next): Promise<Response | void> {
  const payload = await verifyJwt(c.env.JWT_SECRET, getCookie(c, COOKIE_NAME))
  if (!payload) return fail(401, 401, 'unauthorized')

  const row = await c.env.DB.prepare('SELECT password_changed_at FROM auth_state WHERE id = 1').first<{
    password_changed_at: number | null
  }>()
  // 单位统一：iat（秒）× 1000 vs password_changed_at（毫秒）
  if (row?.password_changed_at && payload.iat * 1000 < row.password_changed_at) {
    return fail(401, 401, 'session revoked')
  }

  c.set('user', payload.sub)
  await next()
}
