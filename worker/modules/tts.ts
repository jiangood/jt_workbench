import { Hono } from 'hono'
import { ApiError, ok, type Env } from '../core/envelope'
import { serveFile } from '../core/files'

const tts = new Hono<Env>()

const DEFAULT_VOICE = 'zh_CN-huayan-medium'

function normalizeVoice(v: unknown): string {
  const s = typeof v === 'string' ? v.trim() : ''
  // only allow safe chars (piper model name)
  if (!s || !/^[a-zA-Z0-9._-]+$/.test(s)) return DEFAULT_VOICE
  return s.slice(0, 64)
}

function normalizeKey(k: unknown): string | null {
  if (typeof k !== 'string') return null
  const s = k.trim()
  if (!s || !/^[a-f0-9]{1,64}$/i.test(s)) return null
  return s.toLowerCase()
}

async function hashText(text: string): Promise<string> {
  const data = new TextEncoder().encode(text)
  const buf = await crypto.subtle.digest('SHA-256', data)
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 40)
}

// POST /api/tts/prepare  { bookId, segments: [{key?, text}], voice? }
// Returns status per segment and enqueues synthesis job for missing ones.
tts.post('/prepare', async (c) => {
  const body = await c.req
    .json<{ bookId?: number; segments?: Array<{ key?: string; text?: string }>; voice?: string }>()
    .catch(() => ({} as { bookId?: number; segments?: Array<{ key?: string; text?: string }>; voice?: string }))
  const bookId = Number(body.bookId)
  if (!Number.isFinite(bookId) || bookId <= 0) throw new ApiError(400, 400, 'bookId 无效')
  const voice = normalizeVoice(body.voice)
  const segsIn = Array.isArray(body.segments) ? body.segments : []
  if (!segsIn.length) return ok({ segments: [] })
  if (segsIn.length > 400) throw new ApiError(400, 400, '分段过多')

  const segments: Array<{ key: string; text: string }> = []
  for (const s of segsIn) {
    const text = typeof s?.text === 'string' ? s.text.trim() : ''
    if (!text) continue
    const key = normalizeKey(s?.key) || (await hashText(text))
    segments.push({ key, text: text.slice(0, 4000) })
  }
  if (!segments.length) return ok({ segments: [] })

  const db = c.env.DB
  const now = Date.now()
  const keys = segments.map((s) => s.key)
  const placeholders = keys.map(() => '?').join(',')
  const cached = await db
    .prepare(
      `SELECT segment_key AS segmentKey, r2_key AS r2Key FROM tts_segment
       WHERE book_id = ? AND voice = ? AND segment_key IN (${placeholders})`,
    )
    .bind(bookId, voice, ...keys)
    .all<{ segmentKey: string; r2Key: string }>()
  const hit = new Map((cached.results ?? []).map((r) => [r.segmentKey, r.r2Key]))

  const missing = segments.filter((s) => !hit.has(s.key))
  if (missing.length) {
    // enqueue synthesis; duplicates are cheap and cache makes them idempotent
    const payload = JSON.stringify({ bookId, voice, segments: missing })
    await db
      .prepare(
        `INSERT INTO job (type, payload, cron, enabled, status, next_run_at, attempts, fail_streak)
         VALUES ('tts_synthesize', ?, NULL, 1, 'pending', ?, 0, 0)`,
      )
      .bind(payload, now)
      .run()
  }

  const result = segments.map((s) => {
    const r2 = hit.get(s.key)
    return r2
      ? { key: s.key, ready: true, url: `/api/tts/audio/${encodeURIComponent(r2)}` }
      : { key: s.key, ready: false }
  })
  return ok({ voice, segments: result })
})

// Serve cached audio from R2 (immutable: key encodes content by segment hash)
tts.get('/audio/:key{.+}', async (c) => {
  const key = c.req.param('key')
  if (!key || !key.startsWith('tts/')) throw new ApiError(404, 404, 'not found')
  const url = new URL(c.req.raw.url)
  if (!url.searchParams.has('v')) url.searchParams.set('v', '1')
  const req = new Request(url.toString(), c.req.raw)
  return serveFile(c.env, key, req, null)
})

export default tts
