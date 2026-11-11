/** R2 文件收发（决策 #8：节点不连数据，文件一律经 Worker 流式进出；Range 流播放原生支持） */

export interface StoredFile {
  key: string
  size: number
  contentType: string
}

/** 流式上传：不缓冲整个 body（Worker 内存/CPU 预算友好） */
export async function putFile(
  env: BindingsLike,
  module: string,
  filename: string,
  contentType: string | null,
  body: ReadableStream<Uint8Array>,
): Promise<StoredFile> {
  const key = `${module}/${crypto.randomUUID()}/${encodeURIComponent(filename)}`
  const ct = contentType || guessType(filename)
  const obj = await env.R2.put(key, body, { httpMetadata: { contentType: ct } })
  return { key, size: obj.size, contentType: ct }
}

type BindingsLike = { R2: R2Bucket }

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
