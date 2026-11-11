/** Worker 内置任务（决策 #14 例外清单）：tick 锁内执行，永不下发 */
// 1. reminder_scan：一条 D1 查询 + 至多几封邮件（SMTP 直连 / Resend，key 在 Worker 手里）
// 2. 资讯-过期清理：news 保留期 DELETE + 90 天前 job_run + 过期 cache 行

import type { Bindings } from './envelope'
import { sendMail } from './mail'

export async function runBuiltinTasks(db: D1Database, now: number): Promise<void> {
  // 一次 batch（自带事务）：运行历史 90 天 / 资讯 30 天 / 过期缓存行（cache 有 TTL 但从未清理，不删会永久堆积）
  await db.batch([
    db.prepare('DELETE FROM job_run WHERE run_at < ?').bind(now - 90 * 86400_000),
    db.prepare('DELETE FROM news_item WHERE fetched_at < ?').bind(now - 30 * 86400_000),
    db.prepare('DELETE FROM cache WHERE expires_at < ?').bind(now),
  ])
}

export async function reminderScan(db: D1Database, env: Bindings, now: number): Promise<number> {
  const due = await db
    .prepare('SELECT id, title, note, repeat FROM reminder WHERE enabled = 1 AND remind_at <= ? LIMIT 5')
    .bind(now)
    .all<{ id: number; title: string; note: string | null; repeat: string }>()

  // 并发发信（最多 5 封）：SMTP 单封最多 20s，串行会把一次 poll 拖到 1 分钟以上
  const results = await Promise.all(
    due.results.map(async (r) => {
      try {
        await sendMail(env, {
          subject: `【提醒】${r.title}`,
          html: `<p>${escapeHtml(r.title)}</p>${r.note ? `<p>${escapeHtml(r.note)}</p>` : ''}<p style="color:#999;font-size:12px">— 个人工作台</p>`,
        })
        return { r, error: null as string | null }
      } catch (err) {
        // 未配置 / 网络抖动都只记录错误：保留 remind_at，下轮自动重试
        return { r, error: (err instanceof Error ? err.message : String(err)).slice(0, 500) }
      }
    }),
  )

  let sent = 0
  for (const { r, error } of results) {
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
