/** 提醒模块（原 wb_reminder_*）：CRUD + 即时预览（scan 由 tick 内置任务驱动，10min 粒度）
 *  收件箱是全局参数 app_config.reminder_to（个人使用，不再逐条配置） */

import { Hono } from 'hono'
import { ok, ApiError, type Env } from '../core/envelope'
import { reminderScan } from '../core/tick'
import { getConfig } from '../core/config'

export const reminder = new Hono<Env>()

reminder.get('/list', async (c) => {
  const [rows, to] = await Promise.all([
    c.env.DB
      .prepare(
        `SELECT id, title, note, remind_at AS remindAt, repeat, enabled,
                last_sent_at AS lastSentAt, last_error AS lastError
         FROM reminder ORDER BY remind_at`,
      )
      .all(),
    getConfig(c.env, 'reminder_to'),
  ])
  return ok({ reminders: rows.results, to })
})

function validate(b: { title?: string; remindAt?: number; repeat?: string }) {
  if (!b.title) throw new ApiError(400, 400, 'title 必填')
  if (!b.remindAt || !Number.isFinite(b.remindAt)) throw new ApiError(400, 400, 'remindAt（epoch ms）必填')
  if (b.repeat && !['none', 'daily', 'weekly', 'monthly'].includes(b.repeat)) {
    throw new ApiError(400, 400, 'repeat 取值非法')
  }
}

reminder.post('/list', async (c) => {
  const b = await c.req.json<{ title?: string; note?: string; remindAt?: number; repeat?: string }>()
  validate(b)
  const r = await c.env.DB
    .prepare('INSERT INTO reminder (title, note, remind_at, repeat) VALUES (?, ?, ?, ?)')
    .bind(b.title!, b.note ?? null, b.remindAt!, b.repeat ?? 'none')
    .run()
  return ok({ id: r.meta.last_row_id })
})

reminder.put('/list/:id', async (c) => {
  const b = await c.req.json<{
    title?: string; note?: string; remindAt?: number; repeat?: string; enabled?: boolean
  }>()
  await c.env.DB
    .prepare(
      `UPDATE reminder SET
         title = COALESCE(?, title), note = COALESCE(?, note),
         remind_at = COALESCE(?, remind_at), repeat = COALESCE(?, repeat),
         enabled = COALESCE(?, enabled)
       WHERE id = ?`,
    )
    .bind(
      b.title ?? null, b.note ?? null,
      b.remindAt ?? null, b.repeat ?? null,
      b.enabled === undefined ? null : b.enabled ? 1 : 0,
      Number(c.req.param('id')),
    )
    .run()
  return ok(null)
})

reminder.delete('/list/:id', async (c) => {
  await c.env.DB.prepare('DELETE FROM reminder WHERE id = ?').bind(c.req.param('id')).run()
  return ok(null)
})

/** 手动触发一次扫描（调试/补发入口；与 tick 内的 scan 同语义，受收件服务商限频约束） */
reminder.post('/scan', async (c) => {
  const sent = await reminderScan(c.env.DB, c.env, Date.now())
  return ok({ sent })
})
