/** R2 文件收发（决策 #8：节点不连数据，文件一律经 Worker 流式进出；Range 流播放原生支持） */

import { ApiError } from './envelope'

export interface StoredFile {
  key: string
  size: number
  contentType: string
}

type BindingsLike = { R2: R2Bucket }

function fileKey(module: string, filename: string): string {
  return `${module}/${crypto.randomUUID()}/${encodeURIComponent(filename)}`
}

/** 流式上传：不缓冲整个 body（Worker 内存/CPU 预算友好） */
export async function putFile(
  env: BindingsLike,
  module: string,
  filename: string,
  contentType: string | null,
  body: ReadableStream<Uint8Array>,
): Promise<StoredFile> {
  const key = fileKey(module, filename)
  const ct = contentType || guessType(filename)
  const obj = await env.R2.put(key, body, { httpMetadata: { contentType: ct } })
  return { key, size: obj.size, contentType: ct }
}

// ---------- 分片上传（Cloudflare 单请求体上限 100MB，大文件只能切片走 R2 multipart） ----------

export interface MultipartUpload {
  key: string
  uploadId: string
}

/** 开一个 multipart 上传：key 由 Worker 生成，前端只拿 key + uploadId 回传 */
export async function startMultipart(
  env: BindingsLike,
  module: string,
  filename: string,
  contentType: string | null,
): Promise<MultipartUpload> {
  const key = fileKey(module, filename)
  const mp = await env.R2.createMultipartUpload(key, {
    httpMetadata: { contentType: contentType || guessType(filename) },
  })
  return { key: mp.key, uploadId: mp.uploadId }
}

/**
 * key 由前端带回，必须是本模块自己签发的形状（module/uuid/文件名）：
 * 否则拿到上传地址的人可以往任意 key 写 / 覆盖别的模块文件。
 */
export function ownKey(module: string, key: string | undefined | null): string {
  const re = new RegExp(`^${module}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/`)
  if (!key || !re.test(key)) throw new ApiError(400, 400, '无效的上传标识')
  return key
}

/** 单次分片写入（流式，不落地内存）；partNumber 从 1 开始 */
export async function uploadPart(
  env: BindingsLike,
  key: string,
  uploadId: string,
  partNumber: number,
  body: ReadableStream<Uint8Array>,
): Promise<R2UploadedPart> {
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) {
    throw new ApiError(400, 400, '无效的分片号')
  }
  try {
    return await env.R2.resumeMultipartUpload(key, uploadId).uploadPart(partNumber, body)
  } catch (err) {
    // R2 的错误（uploadId 失效 / 分片太小）原样带出去，前端能看到具体原因
    throw new ApiError(400, 400, `分片上传失败：${err instanceof Error ? err.message : String(err)}`)
  }
}

/** 校验前端回传的分片清单：升序、去重交给 R2，这里只保证结构合法 */
export function parseParts(input: unknown): R2UploadedPart[] {
  const list = (input as { parts?: unknown } | null)?.parts
  if (!Array.isArray(list) || !list.length || list.length > 10000) {
    throw new ApiError(400, 400, '分片信息无效')
  }
  const parts = list.map((part) => {
    const p = part as { partNumber?: unknown; etag?: unknown } | null
    const partNumber = Number(p?.partNumber)
    const etag = typeof p?.etag === 'string' ? p.etag : ''
    if (!Number.isInteger(partNumber) || partNumber < 1 || !etag) {
      throw new ApiError(400, 400, '分片信息无效')
    }
    return { partNumber, etag }
  })
  return parts.sort((a, b) => a.partNumber - b.partNumber)
}

/** 合并分片：成功后就是普通对象，serveFile / Range 都不受影响 */
export async function completeMultipart(
  env: BindingsLike,
  key: string,
  uploadId: string,
  parts: R2UploadedPart[],
  filename: string,
  contentType?: string | null,
): Promise<StoredFile> {
  try {
    const obj = await env.R2.resumeMultipartUpload(key, uploadId).complete(parts)
    const ct = (contentType || '').slice(0, 200) || guessType(filename)
    return { key, size: obj.size, contentType: ct }
  } catch (err) {
    throw new ApiError(400, 400, `合并不完整：${err instanceof Error ? err.message : String(err)}`)
  }
}

/** 取消上传：不 abort 的话未完成分片会一直占 R2 存储 */
export async function abortMultipart(env: BindingsLike, key: string, uploadId: string): Promise<void> {
  try {
    await env.R2.resumeMultipartUpload(key, uploadId).abort()
  } catch {
    /* 已经 complete / abort 过的 uploadId 会报错，清理动作失败不影响前端 */
  }
}

export async function deleteFile(env: BindingsLike, key: string): Promise<void> {
  await env.R2.delete(key)
}

/**
 * 缓存策略（跨境链路只有 ~84KB/s，重下一次就是几十秒）：
 * - URL 带 ?v=<版本>：文件内容与该版本一一对应（换文件必然换 v），可长缓存、永不重验
 * - 不带 v：允许浏览器存下字节，但每次回源校验（304 只花一个 RTT，不重传 body）
 * 一律 private：/api/* 走 Cookie 鉴权，缓存只能属于当前浏览器
 */
const CACHE_IMMUTABLE = 'private, max-age=31536000, immutable'
const CACHE_REVALIDATE = 'private, max-age=0, must-revalidate'

export interface ServeOptions {
  /** 调用方已经耗掉的阶段耗时（如 db），拼进 Server-Timing，线上排查「慢在哪」用 */
  timings?: Array<[string, number]>
}

/**
 * 取文件：透传 Range 头（音频拖动进度条 / PDF 分段 / 阅读器按章拉取）
 * filename 有值时会带 Content-Disposition，浏览器另存 / 下载时用原始文件名（含后缀），
 * 否则 URL 里的 /read/:id 会被当成文件名存下来。
 */
export async function serveFile(
  env: BindingsLike,
  key: string,
  request: Request,
  filename?: string | null,
  opts: ServeOptions = {},
): Promise<Response> {
  const started = performance.now()
  const cacheControl = new URL(request.url).searchParams.has('v') ? CACHE_IMMUTABLE : CACHE_REVALIDATE
  const ifNoneMatch = request.headers.get('if-none-match')
  const range = parseRange(request.headers.get('range'))

  // 无 Range（或格式不认识）：整文件 200
  if (!range) {
    const obj = await env.R2.get(key)
    if (!obj) return notFound()
    // 命中校验：body 流不消费，R2 不计出网流量
    if (etagHit(ifNoneMatch, obj.httpEtag)) {
      return new Response(null, { status: 304, headers: baseHeaders(obj.httpEtag, cacheControl, opts, started) })
    }
    return fileResponse(obj, null, filename, cacheControl, opts, started)
  }

  // 起播最常见的是 bytes=0-（开区间）：直接整对象流式读，size 从对象里拿，省掉一次 head 往返
  if (range.from === 0 && range.to === null) {
    const obj = await env.R2.get(key)
    if (!obj) return notFound()
    if (obj.size === 0) {
      const headers = baseHeaders(obj.httpEtag, cacheControl, opts, started)
      headers.set('content-range', 'bytes */0')
      return new Response('range not satisfiable', { status: 416, headers })
    }
    return fileResponse(obj, { start: 0, end: obj.size - 1, size: obj.size }, filename, cacheControl, opts, started)
  }

  // 有 Range：先 head 拿总大小，再分段读
  const head = await env.R2.head(key)
  if (!head) return notFound()
  const size = head.size

  let start: number
  let end: number
  if (range.from === null) {
    // 后缀范围 bytes=-N：最后 N 字节
    start = Math.max(0, size - (range.to ?? 0))
    end = size - 1
  } else {
    start = range.from
    end = range.to === null ? size - 1 : Math.min(range.to, size - 1)
  }
  if (start >= size || start > end) {
    const headers = baseHeaders(head.httpEtag, cacheControl, opts, started)
    headers.set('content-range', `bytes */${size}`)
    return new Response('range not satisfiable', { status: 416, headers })
  }

  const obj = await env.R2.get(key, { range: { offset: start, length: end - start + 1 } })
  if (!obj) return notFound()
  return fileResponse(obj, { start, end, size }, filename, cacheControl, opts, started)
}

interface RangeSpec {
  from: number | null
  to: number | null
}

/** 只认单段 bytes=a-b / bytes=a- / bytes=-N；多段（逗号）直接退回整文件 */
function parseRange(header: string | null): RangeSpec | null {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m) return null
  if (!m[1] && !m[2]) return null
  return { from: m[1] ? Number(m[1]) : null, to: m[2] ? Number(m[2]) : null }
}

/** If-None-Match 与 R2 etag 比对（支持列表 / 弱校验前缀 / *） */
function etagHit(header: string | null, etag: string): boolean {
  if (!header) return false
  if (header.trim() === '*') return true
  return header.split(',').some((part) => part.trim().replace(/^W\//, '') === etag)
}

function baseHeaders(etag: string, cacheControl: string, opts: ServeOptions, started: number): Headers {
  const headers = new Headers()
  headers.set('etag', etag)
  headers.set('cache-control', cacheControl)
  headers.set('accept-ranges', 'bytes')
  headers.set('x-content-type-options', 'nosniff')
  headers.set('server-timing', serverTiming(opts, started))
  return headers
}

function serverTiming(opts: ServeOptions, started: number): string {
  const parts = (opts.timings ?? []).map(([name, ms]) => `${name};dur=${Math.round(ms)}`)
  parts.push(`r2;dur=${Math.round(performance.now() - started)}`)
  return parts.join(', ')
}

function notFound(): Response {
  return new Response('not found', { status: 404 })
}

function fileResponse(
  obj: R2ObjectBody,
  range: { start: number; end: number; size: number } | null,
  filename: string | null | undefined,
  cacheControl: string,
  opts: ServeOptions,
  started: number,
): Response {
  const headers = baseHeaders(obj.httpEtag, cacheControl, opts, started)
  obj.writeHttpMetadata(headers)
  if (!headers.has('content-type')) headers.set('content-type', 'application/octet-stream')
  if (filename) headers.set('content-disposition', contentDisposition(filename))
  if (range) {
    headers.set('content-range', `bytes ${range.start}-${range.end}/${range.size}`)
    headers.set('content-length', String(range.end - range.start + 1))
  } else if (obj.size != null) {
    headers.set('content-length', String(obj.size))
  }
  return new Response(obj.body, { status: range ? 206 : 200, headers })
}

/** RFC 6266 + 5987：ASCII 兜底 + UTF-8 原名（中文文件名不乱码） */
function contentDisposition(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)
  return `inline; filename="${fallback}"; filename*=UTF-8''${encoded}`
}

function guessType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    mp3: 'audio/mpeg', flac: 'audio/flac', m4a: 'audio/mp4', ogg: 'audio/ogg', wav: 'audio/wav', ape: 'audio/x-ape',
    epub: 'application/epub+zip', pdf: 'application/pdf', mobi: 'application/x-mobipocket-ebook',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
    txt: 'text/plain', md: 'text/markdown',
  }
  return map[ext] ?? 'application/octet-stream'
}
