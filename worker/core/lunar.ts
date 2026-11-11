/** 农历换算（1901-2099）：solarlunar 是纯 JS、零依赖，Worker 与本地/浏览器同构
 *  只在提醒排期里用；Worker 的其它逻辑不依赖农历 */

import solarLunar from 'solarlunar'

export interface SolarDate {
  y: number
  m: number
  d: number
}

export interface LunarDate {
  year: number
  month: number
  day: number
  leap: boolean
}

export const LUNAR_MIN_YEAR = 1901
export const LUNAR_MAX_YEAR = 2099

/** 农历 → 公历；闰月在该年不存在时按平月处理，日期超过当月天数时取月末 */
export function lunarToSolar(year: number, month: number, day: number, leap: boolean): SolarDate | null {
  if (!Number.isInteger(year) || year < LUNAR_MIN_YEAR || year > LUNAR_MAX_YEAR) return null
  if (!Number.isInteger(month) || month < 1 || month > 12) return null
  if (!Number.isInteger(day) || day < 1 || day > 30) return null

  const useLeap = leap && solarLunar.leapMonth(year) === month
  const maxDay = useLeap ? solarLunar.leapDays(year) : solarLunar.monthDays(year, month)
  const safeDay = Math.min(day, maxDay > 0 ? maxDay : day)
  const solar = solarLunar.lunar2solar(year, month, safeDay, useLeap)
  if (solar === -1) return null
  return { y: solar.cYear, m: solar.cMonth, d: solar.cDay }
}

/** 公历 → 农历（只用来判断当前落在哪个农历年） */
export function solarToLunar(y: number, m: number, d: number): LunarDate | null {
  const lunar = solarLunar.solar2lunar(y, m, d)
  if (lunar === -1) return null
  return { year: lunar.lYear, month: lunar.lMonth, day: lunar.lDay, leap: lunar.isLeap }
}

/** “闰六月二十” / “五月二十” */
export function lunarLabel(month: number, day: number, leap: boolean): string {
  return `${leap ? '闰' : ''}${solarLunar.toChinaMonth(month)}${solarLunar.toChinaDay(day)}`
}
