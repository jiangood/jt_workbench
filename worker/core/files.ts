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

/** 取文件：透传 Range 头（音频拖动进度条 / PDF 分段） */
export async function serveFile(env: BindingsLike, key: string, request: Request): Promise<Response> {
  const rangeHeader = request.headers.get('range')
  const m = rangeHeader ? /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim()) : null

  // 无 Range（或格式不认识）：整文件 200
  if (!m || (!m[1] && !m[2])) {
    const obj = await env.R2.get(key)
    if (!obj) return new Response('not found', { status: 404 })
    return fileResponse(obj, null)
  }

  // 有 Range：先 head 拿总大小，再分段读
  const head = await env.R2.head(key)
  if (!head) return new Response('not found', { status: 404 })
  const size = head.size

  let start: number
  let end: number
  if (!m[1]) {
    // 后缀范围 bytes=-N：最后 N 字节
    start = Math.max(0, size - Number(m[2]))
    end = size - 1
  } else {
    start = Number(m[1])
    end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1
  }
  if (start >= size || start > end) {
    return new Response('range not satisfiable', {
      status: 416,
      headers: { 'content-range': `bytes */${size}` },
    })
  }

  const obj = await env.R2.get(key, { range: { offset: start, length: end - start + 1 } })
  if (!obj) return new Response('not found', { status: 404 })
  return fileResponse(obj, { start, end, size })
}

function fileResponse(obj: R2ObjectBody, range: { start: number; end: number; size: number } | null): Response {
  const headers = new Headers()
  obj.writeHttpMetadata(headers)
  headers.set('etag', obj.httpEtag)
  headers.set('accept-ranges', 'bytes')
  if (!headers.has('content-type')) headers.set('content-type', 'application/octet-stream')
  if (range) {
    headers.set('content-range', `bytes ${range.start}-${range.end}/${range.size}`)
    headers.set('content-length', String(range.end - range.start + 1))
  } else if (obj.size != null) {
    headers.set('content-length', String(obj.size))
  }
  return new Response(obj.body, { status: range ? 206 : 200, headers })
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
