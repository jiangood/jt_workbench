/** 提醒排期纯计算（不碰 DB / env）
 *
 *  时间统一按 Asia/Shanghai（UTC+8，无夏令时）理解：旧系统也是这个时区。
 *  - anchor_at：规则锚点（原始事件），每年/每月递推用它保住 2/29、每月 31 号
 *  - event_at：本轮事件发生时刻（农历为换算后的公历时刻）
 *  - remind_at：下一次发送 = event_at - 提前天数
 *  - remind_offsets：降序的提前天数，0 表示当天
 */

import { lunarToSolar, solarToLunar } from './lunar'

export const DAY_MS = 86400_000
export const CN_OFFSET_MS = 8 * 3600_000
export const DEFAULT_EVENT_MINUTES = 9 * 60

export type Repeat = 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly'
export type CalendarType = 'solar' | 'lunar'

export interface ReminderRule {
  repeat: Repeat
  calendarType: CalendarType
  anchorAt: number | null
  eventAt: number | null
  remindAt: number
  offsets: number[]
  lunarMonth?: number | null
  lunarDay?: number | null
  lunarLeap?: boolean | null
}

export interface ReminderPlan {
  eventAt: number
  remindAt: number
  /** 单次提醒的全部提前点都发完，置 enabled=0 */
  disable?: boolean
}

export function localParts(ts: number): { y: number; m: number; d: number; h: number; min: number } {
  const d = new Date(ts + CN_OFFSET_MS)
  return {
    y: d.getUTCFullYear(),
    m: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
    h: d.getUTCHours(),
    min: d.getUTCMinutes(),
  }
}

export function localEpoch(y: number, m: number, d: number, h = 0, min = 0): number {
  return Date.UTC(y, m - 1, d, h, min) - CN_OFFSET_MS
}

export function startOfLocalDay(ts: number): number {
  const p = localParts(ts)
  return localEpoch(p.y, p.m, p.d)
}

export function minutesOfDay(ts: number): number {
  const p = localParts(ts)
  return p.h * 60 + p.min
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

function clampDay(y: number, m: number, d: number): number {
  return Math.min(d, daysInMonth(y, m))
}

/** 宽松解析（DB 脏数据也不抛）：去重、降序、0-365、最多 10 个，默认 [0] */
export function parseOffsets(raw: unknown): number[] {
  const parts = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[,，;；\s]+/) : []
  const values = new Set<number>()
  for (const part of parts) {
    const text = String(part).trim()
    if (!text) continue
    const n = Number(text)
    if (!Number.isInteger(n) || n < 0 || n > 365) continue
    values.add(n)
  }
  if (!values.size) values.add(0)
  return [...values].sort((a, b) => b - a).slice(0, 10)
}

/** 当前这条 remind_at 对应哪个提前点（提前 7 天 → 7；当天 → 0） */
export function offsetOf(eventAt: number, remindAt: number): number {
  return Math.max(0, Math.round((eventAt - remindAt) / DAY_MS))
}

function lunarEpoch(
  year: number,
  month: number,
  day: number,
  leap: boolean,
  h: number,
  min: number,
): number | null {
  const solar = lunarToSolar(year, month, day, leap)
  return solar ? localEpoch(solar.y, solar.m, solar.d, h, min) : null
}

/** 从本轮 occurrence 推下一个周期的 occurrence（输入必须是当前 occurrence） */
export function nextOccurrence(rule: ReminderRule, from: number): number {
  const anchor = rule.anchorAt ?? from
  const a = localParts(anchor)
  const f = localParts(from)

  if (rule.calendarType === 'lunar' && rule.repeat === 'yearly') {
    const lunarYear = solarToLunar(f.y, f.m, f.d)?.year ?? f.y
    for (let i = 1; i <= 3; i++) {
      const next = lunarEpoch(
        lunarYear + i,
        rule.lunarMonth ?? 1,
        rule.lunarDay ?? 1,
        !!rule.lunarLeap,
        a.h,
        a.min,
      )
      if (next != null) return next
    }
    // 超出农历表范围（1901-2099）时退化为公历一年，避免死循环
    return localEpoch(f.y + 1, f.m, f.d, a.h, a.min)
  }

  switch (rule.repeat) {
    case 'daily':
      return from + DAY_MS
    case 'weekly':
      return from + 7 * DAY_MS
    case 'monthly': {
      let y = f.y
      let m = f.m + 1
      if (m > 12) {
        m = 1
        y++
      }
      return localEpoch(y, m, clampDay(y, m, a.d), a.h, a.min)
    }
    case 'yearly': {
      const y = f.y + 1
      return localEpoch(y, a.m, clampDay(y, a.m, a.d), a.h, a.min)
    }
    default:
      return from
  }
}

/** 事件是否还属于“今天或未来”；当天已过时刻也保留，允许同一天内补发 */
function advanceToFuture(rule: ReminderRule, eventAt: number, now: number): number {
  const today = startOfLocalDay(now)
  if (rule.repeat === 'daily' || rule.repeat === 'weekly') {
    const step = rule.repeat === 'daily' ? DAY_MS : 7 * DAY_MS
    if (eventAt < today) return eventAt + (Math.floor((today - eventAt) / step) + 1) * step
    return eventAt
  }
  let event = eventAt
  for (let i = 0; i < 4000 && event < today; i++) event = nextOccurrence(rule, event)
  return event
}

/**
 * 排下一次发送。
 * afterOffset：刚发完的提前点（提前 30 天发完传 30）；新建/编辑不传，从头选。
 * 规则：同一天内允许补发，跨天不补；都错过就只保留当天（0）。
 */
export function planNext(rule: ReminderRule, now: number, afterOffset?: number): ReminderPlan {
  const offsets = rule.offsets.length ? rule.offsets : [0]
  let eventAt = rule.eventAt ?? rule.anchorAt ?? rule.remindAt
  const dayDone = afterOffset === 0

  if (rule.repeat !== 'none') {
    // 当天这一发已结束：先滚到下一个周期，再跳过跨天已错过的提前点
    if (dayDone) eventAt = nextOccurrence(rule, eventAt)
    eventAt = advanceToFuture(rule, eventAt, now)
  } else if (dayDone) {
    return { eventAt, remindAt: eventAt, disable: true }
  }

  const today = startOfLocalDay(now)
  const floor = dayDone ? Infinity : afterOffset ?? Infinity
  const candidates = offsets.filter((o) => o < floor)
  let chosen = candidates.find((o) => eventAt - o * DAY_MS >= today)

  if (chosen === undefined) {
    if (candidates.length) {
      // 这一轮剩下的提前点都跨天了：用最小的那个补发一次，下一轮再推进
      chosen = candidates[candidates.length - 1]
    } else if (rule.repeat === 'none') {
      return { eventAt, remindAt: eventAt, disable: true }
    } else {
      // 本轮所有提前点都处理完（且没有“当天”）：滚到下一个 occurrence 再排
      eventAt = advanceToFuture(rule, nextOccurrence(rule, eventAt), now)
      chosen = offsets.find((o) => eventAt - o * DAY_MS >= today) ?? offsets[offsets.length - 1]
    }
  }

  return { eventAt, remindAt: eventAt - chosen * DAY_MS }
}
