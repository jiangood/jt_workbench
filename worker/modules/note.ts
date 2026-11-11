/** 笔记模块：正文 CRUD + 附件（R2） */

import { Hono } from 'hono'
import { ok, ApiError, type Env } from '../core/envelope'
import { putFile, deleteFile, serveFile } from '../core/files'

interface Attach {
  key: string
  filename: string
  size: number
  contentType: string
}

export const note = new Hono<Env>()

note.get('/list', async (c) => {
  const rows = await c.env.DB
    .prepare(
      `SELECT id, title, substr(content, 1, 120) AS preview, updated_at AS updatedAt,
              json_array_length(attachments) AS attachmentCount
       FROM note ORDER BY updated_at DESC`,
    )
    .all()
  return ok({ notes: rows.results })
})

note.get('/:id', async (c) => {
  const row = await c.env.DB.prepare('SELECT * FROM note WHERE id = ?').bind(c.req.param('id')).first()
  if (!row) throw new ApiError(404, 404, 'not found')
  return ok({ note: row })
})

note.post('/save', async (c) => {
  const b = await c.req.json<{ id?: number; title?: string; content?: string }>()
  if (!b.title) throw new ApiError(400, 400, 'title 必填')
  const now = Date.now()
  if (b.id) {
    await c.env.DB
      .prepare('UPDATE note SET title = ?, content = ?, updated_at = ? WHERE id = ?')
      .bind(b.title, b.content ?? '', now, b.id)
      .run()
    return ok({ id: b.id })
  }
  const r = await c.env.DB
    .prepare('INSERT INTO note (title, content, updated_at) VALUES (?, ?, ?)')
    .bind(b.title, b.content ?? '', now)
    .run()
  return ok({ id: r.meta.last_row_id })
})

note.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const row = await c.env.DB.prepare('SELECT attachments FROM note WHERE id = ?').bind(id).first<{ attachments: string }>()
  if (row) {
    for (const a of JSON.parse(row.attachments) as Attach[]) await deleteFile(c.env, a.key)
    await c.env.DB.prepare('DELETE FROM note WHERE id = ?').bind(id).run()
  }
  return ok(null)
})

/** 附件上传：?noteId=&filename= （浏览器直接 fetch body = File） */
note.post('/attach', async (c) => {
  const noteId = Number(c.req.query('noteId'))
  const filename = c.req.query('filename')
  if (!noteId || !filename) throw new ApiError(400, 400, 'noteId/filename required')
  if (!c.req.raw.body) throw new ApiError(400, 400, 'empty body')

  const stored = await putFile(c.env, 'note', filename, c.req.raw.headers.get('content-type'), c.req.raw.body)

  const row = await c.env.DB.prepare('SELECT attachments FROM note WHERE id = ?').bind(noteId).first<{ attachments: string }>()
  if (!row) throw new ApiError(404, 404, 'note not found')
  const list = JSON.parse(row.attachments) as Attach[]
  list.push({ key: stored.key, filename, size: stored.size, contentType: stored.contentType })
  await c.env.DB.prepare('UPDATE note SET attachments = ? WHERE id = ?').bind(JSON.stringify(list), noteId).run()

  return ok({ key: stored.key, size: stored.size, attachments: list })
})

note.get('/attach/:noteId/:index', async (c) => {
  const row = await c.env.DB
    .prepare('SELECT attachments FROM note WHERE id = ?')
    .bind(c.req.param('noteId'))
    .first<{ attachments: string }>()
  const list = row ? (JSON.parse(row.attachments) as Attach[]) : []
  const a = list[Number(c.req.param('index'))]
  if (!a) throw new ApiError(404, 404, 'not found')
  return serveFile(c.env, a.key, c.req.raw)
})
