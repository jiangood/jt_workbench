/** Worker 内置任务（决策 #14 例外清单）：tick 锁内执行，永不下发 */
// 1. reminder_scan：一条 D1 查询 + 至多几封邮件（SMTP 直连 / Resend，key 在 Worker 手里）
// 2. 资讯-过期清理：news 保留期 DELETE + 90 天前 job_run + 过期 cache 行
// 3. 熔断任务每日重开：网络恢复 / 新节点上线后自愈（详见 rearmBrokenJobs）

import type { Bindings } from './envelope'
import { sendMail } from './mail'
import { lunarLabel } from './lunar'
import {
  DAY_MS,
  localParts,
  offsetOf,
  parseOffsets,
  planNext,
  startOfLocalDay,
  type CalendarType,
  type Repeat,
} from './recurrence'

const REPEAT_TEXT: Record<Repeat, string> = {
  none: '单次',
  daily: '每天',
  weekly: '每周',
  monthly: '每月',
  yearly: '每年',
}

export async function runBuiltinTasks(db: D1Database, now: number): Promise<void> {
  // 一次 batch（自带事务）：运行历史 90 天 / 资讯 30 天 / 过期缓存行（cache 有 TTL 但从未清理，不删会永久堆积）
  await db.batch([
    db.prepare('DELETE FROM job_run WHERE run_at < ?').bind(now - 90 * 86400_000),
    db.prepare('DELETE FROM news_item WHERE fetched_at < ?').bind(now - 30 * 86400_000),
    db.prepare('DELETE FROM cache WHERE expires_at < ?').bind(now),
  ])
  await rearmBrokenJobs(db, now)
}

// 熔断 ≠ 死刑：被熔断停用的任务每天自动重开一次，等新节点上线或网络恢复后自愈。
// 条件 enabled=0 AND status='failed' 只匹配熔断停用（一次性任务跑完是 done，不受影响）；
// last_run_at 距今超 24h 才重开 → 重开一轮若仍不通（3 轮 × 3 次 ≈ 6h）会再次熔断并刷新
// last_run_at，天然形成「每天至多折腾一轮」的节奏，不会跟着 10 分钟的 tick 空转。
const REARM_AFTER_MS = 24 * 60 * 60_000

async function rearmBrokenJobs(db: D1Database, now: number): Promise<void> {
  await db
    .prepare(
      `UPDATE job SET enabled = 1, status = 'pending', attempts = 0, fail_streak = 0,
         next_run_at = ?, lease_until = NULL, result = NULL
       WHERE enabled = 0 AND status = 'failed' AND COALESCE(last_run_at, 0) < ?`,
    )
    .bind(now, now - REARM_AFTER_MS)
    .run()
}

interface DueReminder {
  id: number
  title: string
  note: string | null
  repeat: string
  calendarType: string
  lunarMonth: number | null
  lunarDay: number | null
  lunarLeap: number
  anchorAt: number | null
  eventAt: number | null
  remindAt: number
  remindOffsets: string
}

export async function reminderScan(db: D1Database, env: Bindings, now: number): Promise<number> {
  const due = await db
    .prepare(
      `SELECT id, title, note, repeat,
              calendar_type AS calendarType, lunar_month AS lunarMonth, lunar_day AS lunarDay,
              lunar_leap AS lunarLeap, anchor_at AS anchorAt, event_at AS eventAt,
              remind_at AS remindAt, remind_offsets AS remindOffsets
       FROM reminder WHERE enabled = 1 AND remind_at <= ? LIMIT 5`,
    )
    .bind(now)
    .all<DueReminder>()

  // 并发发信（最多 5 封）：SMTP 单封最多 20s，串行会把一次 poll 拖到 1 分钟以上
  const results = await Promise.all(
    due.results.map(async (r) => {
      try {
        await sendMail(env, buildMail(r, now))
        return { r, error: null as string | null }
      } catch (err) {
        // 未配置 / 网络抖动都只记录错误：保留 remind_at，下轮自动重试
        return { r, error: (err instanceof Error ? err.message : String(err)).slice(0, 500) }
      }
    }),
  )

  let sent = 0
  for (const { r, error } of results) {
    if (error !== null) {
      await db.prepare('UPDATE reminder SET last_error = ? WHERE id = ?').bind(error, r.id).run()
      continue
    }

    sent++
    const eventAt = r.eventAt ?? r.remindAt
    const offsets = parseOffsets(r.remindOffsets)
    const plan = planNext(
      {
        repeat: toRepeat(r.repeat),
        calendarType: toCalendar(r.calendarType),
        anchorAt: r.anchorAt ?? eventAt,
        eventAt,
        remindAt: r.remindAt,
        offsets,
        lunarMonth: r.lunarMonth,
        lunarDay: r.lunarDay,
        lunarLeap: !!r.lunarLeap,
      },
      now,
      offsetOf(eventAt, r.remindAt),
    )

    if (plan.disable) {
      await db
        .prepare('UPDATE reminder SET last_sent_at = ?, last_error = NULL, enabled = 0 WHERE id = ?')
        .bind(now, r.id)
        .run()
    } else {
      await db
        .prepare(
          'UPDATE reminder SET last_sent_at = ?, last_error = NULL, event_at = ?, remind_at = ? WHERE id = ?',
        )
        .bind(now, plan.eventAt, plan.remindAt, r.id)
        .run()
    }
  }
  return sent
}

function buildMail(r: DueReminder, now: number) {
  const eventAt = r.eventAt ?? r.remindAt
  const p = localParts(eventAt)
  const dateText = `${p.y}-${pad(p.m)}-${pad(p.d)} ${pad(p.h)}:${pad(p.min)}`
  const days = Math.round((startOfLocalDay(eventAt) - startOfLocalDay(now)) / DAY_MS)
  const whenText = days > 0 ? `还有 ${days} 天` : days === 0 ? '就是今天' : `已过 ${-days} 天`
  const lunarText =
    r.calendarType === 'lunar' && r.lunarMonth && r.lunarDay
      ? `农历${lunarLabel(r.lunarMonth, r.lunarDay, !!r.lunarLeap)} · `
      : ''
  const repeatText = REPEAT_TEXT[toRepeat(r.repeat)]
  const offsets = parseOffsets(r.remindOffsets)

  return {
    subject: `【提醒】${r.title}${days > 0 ? ` · 还有 ${days} 天` : days === 0 ? ' · 今天' : ''}`,
    html:
      `<p><strong>${escapeHtml(r.title)}</strong></p>` +
      (r.note ? `<p>${escapeHtml(r.note)}</p>` : '') +
      `<p>${lunarText}${dateText}（${whenText}）</p>` +
      `<p style="color:#666">${repeatText} · ${offsetText(offsets)}</p>` +
      `<p style="color:#999;font-size:12px">— 个人工作台</p>`,
  }
}

function offsetText(offsets: number[]): string {
  const leads = offsets.filter((o) => o > 0)
  const sameDay = offsets.includes(0)
  if (!leads.length) return '当天提醒'
  return `提前 ${leads.join('/')} 天${sameDay ? ' + 当天' : ''}`
}

function toRepeat(value: string): Repeat {
  return value === 'daily' || value === 'weekly' || value === 'monthly' || value === 'yearly'
    ? value
    : 'none'
}

function toCalendar(value: string): CalendarType {
  return value === 'lunar' ? 'lunar' : 'solar'
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
