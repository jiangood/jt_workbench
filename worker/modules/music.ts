/** 音乐库：上传（tag 由浏览器 music-metadata 解析后随 query 提交）+ 元数据编辑 + Range 流播放 */

import { Hono, type Context } from 'hono'
import { ok, ApiError, type Env } from '../core/envelope'
import { putFile, deleteFile, serveFile } from '../core/files'

export const music = new Hono<Env>()

/** 元数据文本上限：标题较长（文件名可能很啰嗦），艺术家 / 专辑按常见习惯留足余量 */
const MAX_TITLE = 300
const MAX_META = 200

music.get('/list', async (c) => {
  const rows = await c.env.DB
    .prepare(
      `SELECT id, title, artist, album, duration, filename, size, created_at AS createdAt
       FROM music ORDER BY created_at DESC`,
    )
    .all()
  return ok({ tracks: rows.results })
})

music.post('/upload', async (c) => {
  const filename = c.req.query('filename')
  if (!filename) throw new ApiError(400, 400, 'filename required')
  if (!c.req.raw.body) throw new ApiError(400, 400, 'empty body')

  const stored = await putFile(c.env, 'music', filename, c.req.raw.headers.get('content-type'), c.req.raw.body)
  const r = await c.env.DB
    .prepare(
      'INSERT INTO music (title, artist, album, duration, r2_key, filename, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(
      c.req.query('title') || filename.replace(/\.[^.]+$/, ''),
      c.req.query('artist') || null,
      c.req.query('album') || null,
      duration(c.req.query('duration')),
      stored.key, filename, stored.size, Date.now(),
    )
    .run()
  return ok({ id: r.meta.last_row_id, size: stored.size })
})

/** 编辑元数据：标题必填，艺术家 / 专辑可清空（传空串 → NULL） */
music.patch('/:id', async (c) => {
  const id = c.req.param('id')
  if (!/^\d+$/.test(id)) throw new ApiError(400, 400, '无效的曲目 ID')
  const row = await c.env.DB
    .prepare('SELECT id, filename FROM music WHERE id = ?')
    .bind(id)
    .first<{ id: number; filename: string }>()
  if (!row) throw new ApiError(404, 404, '曲目不存在')

  const b = await readJson(c)
  const sets: string[] = []
  const values: unknown[] = []
  const set = (column: string, value: unknown) => {
    sets.push(`${column} = ?`)
    values.push(value)
  }

  if ('title' in b) {
    const title = text(b.title, MAX_TITLE)
    if (!title) throw new ApiError(400, 400, '标题不能为空')
    set('title', title)
  }
  // 艺术家 / 专辑留空表示「未知」，存 NULL 让前端统一显示占位符
  if ('artist' in b) set('artist', text(b.artist, MAX_META))
  if ('album' in b) set('album', text(b.album, MAX_META))

  if (!sets.length) return ok(null)
  await c.env.DB
    .prepare(`UPDATE music SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...values, id)
    .run()
  return ok(null)
})

music.delete('/:id', async (c) => {
  const row = await c.env.DB.prepare('SELECT r2_key FROM music WHERE id = ?').bind(c.req.param('id')).first<{ r2_key: string }>()
  if (row) {
    await deleteFile(c.env, row.r2_key)
    await c.env.DB.prepare('DELETE FROM music WHERE id = ?').bind(c.req.param('id')).run()
  }
  return ok(null)
})

/** 流播放（Range 透传，进度条拖动原生支持） */
music.get('/play/:id', async (c) => {
  const row = await c.env.DB
    .prepare('SELECT r2_key FROM music WHERE id = ?')
    .bind(c.req.param('id'))
    .first<{ r2_key: string }>()
  if (!row) throw new ApiError(404, 404, 'not found')
  return serveFile(c.env, row.r2_key, c.req.raw)
})

// ---------- 辅助 ----------

/** 时长（秒）：只接受有限正数，超出一天视为解析异常 */
function duration(raw: string | undefined): number | null {
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 && n < 86400 ? Math.round(n) : null
}

/** 去空白 + 截断；空串归一为 null（库里用 NULL 表示未知） */
function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const v = value.trim().slice(0, max)
  return v || null
}

async function readJson(c: Context<Env>): Promise<Record<string, unknown>> {
  try {
    const body = await c.req.json<unknown>()
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('not object')
    return body as Record<string, unknown>
  } catch {
    throw new ApiError(400, 400, '无效的 JSON')
  }
}
