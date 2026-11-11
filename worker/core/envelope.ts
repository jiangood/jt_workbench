/** 统一 JSON 信封 {code, data, message} + 错误处理（决策 #11） */

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: number,
    message: string,
  ) {
    super(message)
  }
}

export interface Bindings {
  DB: D1Database
  NODE_KEY: string
  JWT_SECRET: string
  // 仅作首访引导：凭据以 D1 auth_state 为准，后台改密后这三项可不再配置
  ADMIN_USER?: string
  ADMIN_PWD_SALT?: string
  ADMIN_PWD_HASH?: string
  RESEND_API_KEY: string
  REMINDER_FROM: string
  AGENT_LATEST_VERSION?: string
  R2: R2Bucket
}

export type Env = {
  Bindings: Bindings
  Variables: {
    user: string
  }
}

export function ok<T>(data: T, message = 'ok'): Response {
  return Response.json({ code: 0, data, message })
}

export function fail(status: number, code: number, message: string): Response {
  return Response.json({ code, data: null, message }, { status })
}

/** Hono onError：ApiError 按其状态码，其余一律 500（不泄漏内部错误） */
export function onError(err: unknown): Response {
  if (err instanceof ApiError) return fail(err.status, err.code, err.message)
  console.error('unhandled error:', String(err))
  return fail(500, 500, 'internal error')
}

export function notFound(): Response {
  return fail(404, 404, 'not found')
}

// ---------- 节点协议响应（所有 /node/* 交互统一 {now, jobs[0..1]}，v4.9 捎带下发） ----------

export interface Job {
  id: number
  type: string
  payload: unknown
}

export function nodeOk(data: Record<string, unknown> = {}): Response {
  return Response.json({ code: 0, data: { ...data, now: Date.now() }, message: 'ok' })
}

export function nodeErr(status: number, message: string): Response {
  return fail(status, status, message)
}
