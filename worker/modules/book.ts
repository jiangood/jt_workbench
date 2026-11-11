/** 读书：上传（epub 元数据由浏览器 JSZip 读 OPF；pdf 直接打开）+ 在线阅读 */

import { Hono } from 'hono'
import { ok, ApiError, type Env } from '../core/envelope'
import { putFile, deleteFile, serveFile } from '../core/files'

export const book = new Hono<Env>()

book.get('/list', async (c) => {
  const rows = await c.env.DB
    .prepare('SELECT id, title, author, fmt, filename, size, created_at AS createdAt FROM book ORDER BY created_at DESC')
    .all()
  return ok({ books: rows.results })
})

book.post('/upload', async (c) => {
  const filename = c.req.query('filename')
  if (!filename) throw new ApiError(400, 400, 'filename required')
  if (!c.req.raw.body) throw new ApiError(400, 400, 'empty body')
  const fmt = filename.toLowerCase().endsWith('.pdf') ? 'pdf' : 'epub'

  const stored = await putFile(c.env, 'book', filename, c.req.raw.headers.get('content-type'), c.req.raw.body)
  const r = await c.env.DB
    .prepare('INSERT INTO book (title, author, fmt, r2_key, filename, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(
      c.req.query('title') || filename.replace(/\.[^.]+$/, ''),
      c.req.query('author') || null,
      fmt, stored.key, filename, stored.size, Date.now(),
    )
    .run()
  return ok({ id: r.meta.last_row_id, size: stored.size })
})

book.delete('/:id', async (c) => {
  const row = await c.env.DB.prepare('SELECT r2_key FROM book WHERE id = ?').bind(c.req.param('id')).first<{ r2_key: string }>()
  if (row) {
    await deleteFile(c.env, row.r2_key)
    await c.env.DB.prepare('DELETE FROM book WHERE id = ?').bind(c.req.param('id')).run()
  }
  return ok(null)
})

/** 阅读/下载（Range 透传：epub.js 分段读、浏览器 PDF 渐进加载） */
book.get('/read/:id', async (c) => {
  const row = await c.env.DB.prepare('SELECT r2_key FROM book WHERE id = ?').bind(c.req.param('id')).first<{ r2_key: string }>()
  if (!row) throw new ApiError(404, 404, 'not found')
  return serveFile(c.env, row.r2_key, c.req.raw)
})
