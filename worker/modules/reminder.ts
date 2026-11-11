/** 提醒模块（原 wb_reminder_*）：CRUD + 即时预览（scan 由 tick 内置任务驱动，10min 粒度）
 *  收件箱是全局参数 app_config.reminder_to（个人使用，不再逐条配置）
 *
 *  支持：单次 / 每天 / 每周 / 每月 / 每年；公历或农历（农历仅每年）；多个提前天数。
 *  事件日期与通知日期分离：anchor_at（规则锚点）→ event_at（本轮事件）→ remind_at（下次发送）。
 */

import { Hono } from 'hono'
import { ok, ApiError, type Env } from '../core/envelope'
import { reminderScan } from '../core/tick'
import { getConfig } from '../core/config'
import { lunarLabel, lunarToSolar, solarToLunar } from '../core/lunar'
import {
  DEFAULT_EVENT_MINUTES,
  localEpoch,
  localParts,
  minutesOfDay,
  offsetOf,
  parseOffsets,
  planNext,
  startOfLocalDay,
  type CalendarType,
  type ReminderRule,
  type Repeat,
} from '../core/recurrence'

export const reminder = new Hono<Env>()

interface ReminderRow {
  id: number
  title: string
  note: string | null
  calendarType: string
  lunarMonth: number | null
  lunarDay: number | null
  lunarLeap: number
  anchorAt: number | null
  eventAt: number | null
  remindAt: number
  remindOffsets: string
  repeat: string
  enabled: number
  lastSentAt: number | null
  lastError: string | null
}

interface Body {
  title?: string
  note?: string
  repeat?: string
  offsets?: number[] | string
  calendar?: string
  eventAt?: number
  eventMinutes?: number
  lunarMonth?: number
  lunarDay?: number
  lunarLeap?: boolean
  enabled?: boolean
}

interface LunarFields {
  month: number
  day: number
  leap: boolean
  minutes: number
}

const REPEATS: Repeat[] = ['none', 'daily', 'weekly', 'monthly', 'yearly']
const MAX_TITLE = 100

const SELECT_COLUMNS = `id, title, note,
  calendar_type AS calendarType, lunar_month AS lunarMonth, lunar_day AS lunarDay,
  lunar_leap AS lunarLeap, anchor_at AS anchorAt, event_at AS eventAt,
  remind_at AS remindAt, remind_offsets AS remindOffsets, repeat, enabled,
  last_sent_at AS lastSentAt, last_error AS lastError`

reminder.get('/list', async (c) => {
  const [rows, to] = await Promise.all([
    c.env.DB
      .prepare(`SELECT ${SELECT_COLUMNS} FROM reminder ORDER BY enabled DESC, remind_at`)
      .all<ReminderRow>(),
    getConfig(c.env, 'reminder_to'),
  ])

  const reminders = rows.results.map((r) => {
    const eventAt = r.eventAt ?? r.remindAt
    return {
      ...r,
      eventAt,
      anchorAt: r.anchorAt ?? eventAt,
      offsets: parseOffsets(r.remindOffsets),
      lunarLeap: !!r.lunarLeap,
      lunarText:
        r.calendarType === 'lunar' && r.lunarMonth && r.lunarDay
          ? lunarLabel(r.lunarMonth, r.lunarDay, !!r.lunarLeap)
          : null,
    }
  })
  return ok({ reminders, to })
})

reminder.post('/list', async (c) => {
  const b = await c.req.json<Body>()
  const title = parseTitle(b.title)
  const repeat = parseRepeat(b.repeat, 'none')
  const calendarType = parseCalendar(b.calendar, 'solar')
  const offsets = parseInputOffsets(b.offsets) ?? [0]
  assertOffsets(repeat, offsets)
  const now = Date.now()

  const lunar = calendarType === 'lunar' ? parseLunarFields(b, repeat) : null
  const anchorAt = lunar ? nextLunarAt(now, lunar) : parseEventAt(b.eventAt)
  const plan = planNext(ruleOf(repeat, calendarType, anchorAt, anchorAt, offsets, lunar), now)

  const r = await c.env.DB
    .prepare(
      `INSERT INTO reminder
         (title, note, calendar_type, lunar_month, lunar_day, lunar_leap,
          anchor_at, event_at, remind_at, remind_offsets, repeat, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      title,
      parseNote(b.note),
      lunar ? 'lunar' : 'solar',
      lunar?.month ?? null,
      lunar?.day ?? null,
      lunar?.leap ? 1 : 0,
      anchorAt,
      plan.eventAt,
      plan.remindAt,
      offsets.join(','),
      repeat,
      b.enabled === false ? 0 : 1,
    )
    .run()
  return ok({ id: r.meta.last_row_id })
})

reminder.put('/list/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const b = await c.req.json<Body>()
  const existing = await c.env.DB.prepare(`SELECT ${SELECT_COLUMNS} FROM reminder WHERE id = ?`)
    .bind(id)
    .first<ReminderRow>()
  if (!existing) throw new ApiError(404, 404, '提醒不存在')

  const title = b.title === undefined ? existing.title : parseTitle(b.title)
  const note = b.note === undefined ? existing.note : parseNote(b.note)
  const repeat = parseRepeat(b.repeat, toRepeat(existing.repeat))
  const calendarType = parseCalendar(b.calendar, toCalendar(existing.calendarType))
  const offsets =
    b.offsets === undefined ? parseOffsets(existing.remindOffsets) : parseInputOffsets(b.offsets)!
  assertOffsets(repeat, offsets)
  const enabled = b.enabled === undefined ? existing.enabled : b.enabled ? 1 : 0

  const now = Date.now()
  const existingCalendar = toCalendar(existing.calendarType)
  const existingAnchor = existing.anchorAt ?? existing.eventAt ?? existing.remindAt
  const existingEvent = existing.eventAt ?? existingAnchor

  // 合并农历字段（未传的沿用旧值），并判断“日期规则”是否真的变了
  const lunar =
    calendarType === 'lunar'
      ? parseLunarFields(
          {
            ...b,
            lunarMonth: b.lunarMonth ?? existing.lunarMonth ?? undefined,
            lunarDay: b.lunarDay ?? existing.lunarDay ?? undefined,
            lunarLeap: b.lunarLeap ?? !!existing.lunarLeap,
            eventMinutes: b.eventMinutes ?? minutesOfDay(existingAnchor),
          },
          repeat,
        )
      : null
  const lunarChanged =
    !!lunar &&
    (existingCalendar !== 'lunar' ||
      lunar.month !== existing.lunarMonth ||
      lunar.day !== existing.lunarDay ||
      lunar.leap !== (existing.lunarLeap === 1) ||
      lunar.minutes !== minutesOfDay(existingAnchor))

  const solarDateChanged =
    calendarType === 'solar' &&
    (existingCalendar !== 'solar' ||
      (b.eventAt !== undefined && Math.trunc(Number(b.eventAt)) !== existingAnchor))

  const sameRepeat = repeat === toRepeat(existing.repeat)
  const sameCalendar = calendarType === existingCalendar
  const sameOffsets = offsets.join(',') === parseOffsets(existing.remindOffsets).join(',')
  const sameDate = calendarType === 'lunar' ? !lunarChanged : !solarDateChanged

  // 只改标题/备注/启用时保持原排期，避免把今天刚发过的提前点重发一遍
  if (sameRepeat && sameCalendar && sameOffsets && sameDate) {
    await c.env.DB.prepare('UPDATE reminder SET title = ?, note = ?, enabled = ? WHERE id = ?')
      .bind(title, note, enabled, id)
      .run()
    return ok(null)
  }

  // 日期规则没变（只改提前点/重复方式）时从“本轮事件”续排，而不是从原始锚点重排
  const dateChanged = calendarType === 'lunar' ? lunarChanged : solarDateChanged
  const anchorAt =
    calendarType === 'lunar' && lunar && lunarChanged
      ? nextLunarAt(now, lunar)
      : calendarType === 'solar' && dateChanged
        ? parseEventAt(b.eventAt)
        : existingAnchor
  const eventSeed = dateChanged ? anchorAt : existingEvent
  // 只改提前点/重复方式时，推断“上一发是哪个提前点”，避免把今天已发过的再发一遍
  const oldOffsets = parseOffsets(existing.remindOffsets)
  const lastSentOffset = oldOffsets.filter((o) => o > offsetOf(existingEvent, existing.remindAt)).pop()
  const afterOffset = !dateChanged && sameRepeat && sameCalendar ? lastSentOffset : undefined
  const plan = planNext(
    ruleOf(repeat, calendarType, anchorAt, eventSeed, offsets, lunar),
    now,
    afterOffset,
  )

  await c.env.DB
    .prepare(
      `UPDATE reminder SET
         title = ?, note = ?, calendar_type = ?, lunar_month = ?, lunar_day = ?, lunar_leap = ?,
         anchor_at = ?, event_at = ?, remind_at = ?, remind_offsets = ?, repeat = ?, enabled = ?
       WHERE id = ?`,
    )
    .bind(
      title,
      note,
      lunar ? 'lunar' : 'solar',
      lunar?.month ?? null,
      lunar?.day ?? null,
      lunar?.leap ? 1 : 0,
      anchorAt,
      plan.eventAt,
      plan.remindAt,
      offsets.join(','),
      repeat,
      enabled,
      id,
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

// ---------------------------------------------------------------- helpers

function ruleOf(
  repeat: Repeat,
  calendarType: CalendarType,
  anchorAt: number,
  eventAt: number,
  offsets: number[],
  lunar: LunarFields | null,
): ReminderRule {
  return {
    repeat,
    calendarType,
    anchorAt,
    eventAt,
    remindAt: eventAt,
    offsets,
    lunarMonth: lunar?.month ?? null,
    lunarDay: lunar?.day ?? null,
    lunarLeap: lunar?.leap ?? false,
  }
}

/** 校验并合并农历字段（不计算下一次公历日期） */
function parseLunarFields(b: Body, repeat: Repeat): LunarFields {
  if (repeat !== 'yearly') throw new ApiError(400, 400, '农历提醒仅支持每年重复')
  const month = parseLunarNumber(b.lunarMonth, 1, 12, '农历月份')
  const day = parseLunarNumber(b.lunarDay, 1, 30, '农历日期')
  return {
    month,
    day,
    leap: b.lunarLeap === true,
    minutes: parseMinutes(b.eventMinutes, DEFAULT_EVENT_MINUTES),
  }
}

/** 从今天所在的农历年找下一次农历月/日，换算成本轮公历时刻 */
function nextLunarAt(now: number, lunar: LunarFields): number {
  const today = startOfLocalDay(now)
  const p = localParts(now)
  const lunarYear = solarToLunar(p.y, p.m, p.d)?.year ?? p.y
  const h = Math.floor(lunar.minutes / 60)
  const min = lunar.minutes % 60

  for (let i = 0; i < 3; i++) {
    const solar = lunarToSolar(lunarYear + i, lunar.month, lunar.day, lunar.leap)
    if (!solar) continue
    const ts = localEpoch(solar.y, solar.m, solar.d, h, min)
    // 当天已过时刻也保留，交给 planNext 做“同一天内补发”
    if (ts >= today) return ts
  }
  throw new ApiError(400, 400, '农历日期超出支持范围（1901-2099）')
}

function parseTitle(value: unknown): string {
  const title = typeof value === 'string' ? value.trim() : ''
  if (!title) throw new ApiError(400, 400, '标题不能为空')
  if (title.length > MAX_TITLE) throw new ApiError(400, 400, `标题不能超过 ${MAX_TITLE} 个字符`)
  return title
}

function parseNote(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function parseRepeat(value: unknown, fallback: Repeat): Repeat {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value !== 'string' || !REPEATS.includes(value as Repeat)) {
    throw new ApiError(400, 400, 'repeat 取值非法')
  }
  return value as Repeat
}

function parseCalendar(value: unknown, fallback: CalendarType): CalendarType {
  if (value === undefined || value === null || value === '') return fallback
  if (value !== 'solar' && value !== 'lunar') throw new ApiError(400, 400, 'calendar 取值非法')
  return value
}

/** API 入参严格校验：0-365 的整数，去重降序，最多 10 个 */
function parseInputOffsets(value: unknown): number[] | null {
  if (value === undefined) return null
  if (value === null || value === '') return [0]
  const parts = Array.isArray(value) ? value : String(value).split(/[,，;；\s]+/)
  const values = new Set<number>()
  for (const part of parts) {
    const text = String(part).trim()
    if (!text) continue
    const n = Number(text)
    if (!Number.isInteger(n) || n < 0 || n > 365) {
      throw new ApiError(400, 400, '提前天数需为 0-365 的整数')
    }
    values.add(n)
  }
  if (!values.size) values.add(0)
  if (values.size > 10) throw new ApiError(400, 400, '提前提醒最多 10 个')
  return [...values].sort((a, b) => b - a)
}

function assertOffsets(repeat: Repeat, offsets: number[]): void {
  if ((repeat === 'daily' || repeat === 'weekly') && offsets.some((o) => o !== 0)) {
    throw new ApiError(400, 400, '每天/每周提醒不支持提前天数')
  }
}

function parseEventAt(value: unknown): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) throw new ApiError(400, 400, '请选择事件时间')
  return Math.trunc(n)
}

function parseMinutes(value: unknown, fallback: number): number {
  if (value === undefined || value === null) return fallback
  const n = Number(value)
  if (!Number.isInteger(n) || n < 0 || n > 1439) throw new ApiError(400, 400, '事件时间非法')
  return n
}

function parseLunarNumber(value: unknown, min: number, max: number, label: string): number {
  const n = Number(value)
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ApiError(400, 400, `${label}需在 ${min}-${max} 之间`)
  }
  return n
}

function toRepeat(value: string): Repeat {
  return REPEATS.includes(value as Repeat) ? (value as Repeat) : 'none'
}

function toCalendar(value: string): CalendarType {
  return value === 'lunar' ? 'lunar' : 'solar'
}
