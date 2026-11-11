/** 音乐库：上传（tag 由浏览器 music-metadata 解析后随 query 提交）+ Range 流播放 */

import { Hono } from 'hono'
import { ok, ApiError, type Env } from '../core/envelope'
import { putFile, deleteFile, serveFile } from '../core/files'

export const music = new Hono<Env>()

music.get('/list', async (c) => {
  const rows = await c.env.DB
    .prepare('SELECT id, title, artist, album, filename, size, created_at AS createdAt FROM music ORDER BY created_at DESC')
    .all()
  return ok({ tracks: rows.results })
})

music.post('/upload', async (c) => {
  const filename = c.req.query('filename')
  if (!filename) throw new ApiError(400, 400, 'filename required')
  if (!c.req.raw.body) throw new ApiError(400, 400, 'empty body')

  const stored = await putFile(c.env, 'music', filename, c.req.raw.headers.get('content-type'), c.req.raw.body)
  const r = await c.env.DB
    .prepare('INSERT INTO music (title, artist, album, r2_key, filename, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(
      c.req.query('title') || filename.replace(/\.[^.]+$/, ''),
      c.req.query('artist') || null,
      c.req.query('album') || null,
      stored.key, filename, stored.size, Date.now(),
    )
    .run()
  return ok({ id: r.meta.last_row_id, size: stored.size })
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
