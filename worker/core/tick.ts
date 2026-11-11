/** Worker 内置任务（决策 #14 例外清单）：tick 锁内执行，永不下发 */
// 1. reminder_scan：一条 D1 查询 + 至多几封 Resend（key 在 Worker 手里）
// 2. 资讯-过期清理：news 保留期 DELETE + 90 天前 job_run

import type { Bindings } from './envelope'

export async function runBuiltinTasks(db: D1Database, now: number): Promise<void> {
  await db.prepare('DELETE FROM job_run WHERE run_at < ?').bind(now - 90 * 86400_000).run()
  await db.prepare('DELETE FROM news_item WHERE fetched_at < ?').bind(now - 30 * 86400_000).run()
}

export async function reminderScan(db: D1Database, env: Bindings, now: number): Promise<number> {
  const due = await db
    .prepare('SELECT id, title, note, email, repeat FROM reminder WHERE enabled = 1 AND remind_at <= ? LIMIT 5')
    .bind(now)
    .all<{ id: number; title: string; note: string | null; email: string; repeat: string }>()

  let sent = 0
  for (const r of due.results) {
    let error: string | null = null
    if (env.RESEND_API_KEY) {
      try {
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            from: env.REMINDER_FROM || 'onboarding@resend.dev',
            to: [r.email],
            subject: `【提醒】${r.title}`,
            html: `<p>${r.title}</p>${r.note ? `<p>${escapeHtml(r.note)}</p>` : ''}<p style="color:#999;font-size:12px">— Workbench</p>`,
          }),
        })
        if (!res.ok) error = `resend HTTP ${res.status} ${await res.text().catch(() => '')}`
      } catch (e) {
        error = String(e)
      }
    } else {
      error = 'RESEND_API_KEY not configured' // 未配置时保留 due 状态，配置后下轮补发
    }

    if (error === null) {
      sent++
      if (r.repeat === 'none') {
        await db
          .prepare('UPDATE reminder SET last_sent_at = ?, last_error = NULL, enabled = 0 WHERE id = ?')
          .bind(now, r.id)
          .run()
      } else {
        await db
          .prepare('UPDATE reminder SET last_sent_at = ?, last_error = NULL, remind_at = ? WHERE id = ?')
          .bind(now, advance(now, r.repeat), r.id)
          .run()
      }
    } else {
      // 失败保留 remind_at，下轮重试（Resend 限频/网络抖动自愈）
      await db.prepare('UPDATE reminder SET last_error = ? WHERE id = ?').bind(error, r.id).run()
    }
  }
  return sent
}

function advance(now: number, repeat: string): number {
  const d = new Date(now)
  if (repeat === 'daily') d.setUTCDate(d.getUTCDate() + 1)
  else if (repeat === 'weekly') d.setUTCDate(d.getUTCDate() + 7)
  else if (repeat === 'monthly') d.setUTCMonth(d.getUTCMonth() + 1)
  else return now // none：调用方置 enabled=0
  return d.getTime()
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
