/** 笔记模块：目录树（note_folder）+ 正文 CRUD + 附件（R2） */

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

// ---------- 目录树 ----------

/** 扁平返回（前端按 parentId 组装树），排序在后台定：同级按 sort、id */
note.get('/folders', async (c) => {
  const rows = await c.env.DB
    .prepare('SELECT id, name, parent_id AS parentId, sort FROM note_folder ORDER BY sort, id')
    .all()
  return ok({ folders: rows.results })
})

/** 新建/重命名/移动目录：{ id?, name, parentId }，parentId = null 表示根目录 */
note.post('/folders/save', async (c) => {
  const b = await c.req.json<{ id?: number; name?: string; parentId?: number | null }>()
  const name = b.name?.trim()
  if (!name) throw new ApiError(400, 400, '目录名不能为空')
  if (name.length > 60) throw new ApiError(400, 400, '目录名不能超过 60 字')

  const parentId = b.parentId ?? null
  if (parentId != null) {
    const parent = await c.env.DB.prepare('SELECT id FROM note_folder WHERE id = ?').bind(parentId).first()
    if (!parent) throw new ApiError(400, 400, '父目录不存在')
  }

  const now = Date.now()
  if (b.id) {
    const row = await c.env.DB.prepare('SELECT id FROM note_folder WHERE id = ?').bind(b.id).first()
    if (!row) throw new ApiError(404, 404, '目录不存在')
    if (parentId != null && (await hasCycle(c.env.DB, b.id, parentId))) {
      throw new ApiError(400, 400, '不能移动到自身或子目录')
    }
    await c.env.DB
      .prepare('UPDATE note_folder SET name = ?, parent_id = ?, updated_at = ? WHERE id = ?')
      .bind(name, parentId, now, b.id)
      .run()
    return ok({ id: b.id })
  }

  const r = await c.env.DB
    .prepare('INSERT INTO note_folder (name, parent_id, sort, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .bind(name, parentId, 0, now, now)
    .run()
  return ok({ id: r.meta.last_row_id })
})

/** 删除目录：笔记与子目录上移到父目录，不跟随删除 */
note.delete('/folders/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const row = await c.env.DB
    .prepare('SELECT parent_id AS parentId FROM note_folder WHERE id = ?')
    .bind(id)
    .first<{ parentId: number | null }>()
  if (row) {
    await c.env.DB.batch([
      c.env.DB.prepare('UPDATE note SET folder_id = ? WHERE folder_id = ?').bind(row.parentId, id),
      c.env.DB.prepare('UPDATE note_folder SET parent_id = ? WHERE parent_id = ?').bind(row.parentId, id),
      c.env.DB.prepare('DELETE FROM note_folder WHERE id = ?').bind(id),
    ])
  }
  return ok(null)
})

/** 从 parentId 向上走，撞到 id 说明会成环（数据已环时也拒绝，避免死循环） */
async function hasCycle(db: D1Database, id: number, parentId: number): Promise<boolean> {
  const seen = new Set<number>()
  let cur: number | null = parentId
  while (cur != null) {
    if (cur === id || seen.has(cur)) return true
    seen.add(cur)
    const row: { parentId: number | null } | null = await db
      .prepare('SELECT parent_id AS parentId FROM note_folder WHERE id = ?')
      .bind(cur)
      .first<{ parentId: number | null }>()
    cur = row?.parentId ?? null
  }
  return false
}

// ---------- 笔记 ----------

/** 列表 / 搜索：?q= 在标题与正文里做子串匹配（全库范围），不传 q 返回全部 */
note.get('/list', async (c) => {
  const cols = `id, title, substr(content, 1, 120) AS preview, folder_id AS folderId, updated_at AS updatedAt,
                json_array_length(attachments) AS attachmentCount`
  const q = (c.req.query('q') ?? '').trim()
  if (!q) {
    const rows = await c.env.DB.prepare(`SELECT ${cols} FROM note ORDER BY updated_at DESC`).all()
    return ok({ notes: rows.results })
  }
  if (q.length > 100) throw new ApiError(400, 400, '搜索词不能超过 100 字')

  // 转义 LIKE 通配符：搜 "100%" / "a_b" 时按字面匹配
  const like = `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`
  const rows = await c.env.DB
    .prepare(
      `SELECT ${cols} FROM note
       WHERE title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\'
       ORDER BY updated_at DESC LIMIT 200`,
    )
    .bind(like, like)
    .all()
  return ok({ notes: rows.results })
})

note.get('/:id', async (c) => {
  const row = await c.env.DB.prepare('SELECT * FROM note WHERE id = ?').bind(c.req.param('id')).first()
  if (!row) throw new ApiError(404, 404, 'not found')
  return ok({ note: row })
})

note.post('/save', async (c) => {
  const b = await c.req.json<{ id?: number; title?: string; content?: string; folderId?: number | null }>()
  if (!b.title) throw new ApiError(400, 400, 'title 必填')
  const folderId = await validFolderId(c.env.DB, b.folderId)
  const now = Date.now()
  if (b.id) {
    await c.env.DB
      .prepare('UPDATE note SET title = ?, content = ?, folder_id = ?, updated_at = ? WHERE id = ?')
      .bind(b.title, b.content ?? '', folderId, now, b.id)
      .run()
    return ok({ id: b.id })
  }
  const r = await c.env.DB
    .prepare('INSERT INTO note (title, content, folder_id, updated_at) VALUES (?, ?, ?, ?)')
    .bind(b.title, b.content ?? '', folderId, now)
    .run()
  return ok({ id: r.meta.last_row_id })
})

/** 目录被并发删掉时不要把笔记挂到不存在的 id 上，退化为未分类 */
async function validFolderId(db: D1Database, folderId: number | null | undefined): Promise<number | null> {
  if (folderId == null) return null
  const row = await db.prepare('SELECT id FROM note_folder WHERE id = ?').bind(folderId).first()
  return row ? folderId : null
}

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
