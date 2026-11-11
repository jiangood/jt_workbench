/** solarlunar 的 package.json exports 没带 types，补一份最小声明（只用到农历换算） */
declare module 'solarlunar' {
  interface SolarLunarResult {
    lYear: number
    lMonth: number
    lDay: number
    isLeap: boolean
    cYear: number
    cMonth: number
    cDay: number
    monthCn: string
    dayCn: string
  }

  interface SolarLunar {
    lunar2solar(year: number, month: number, day: number, isLeapMonth?: boolean): SolarLunarResult | -1
    solar2lunar(year?: number, month?: number, day?: number): SolarLunarResult | -1
    leapMonth(year: number): number
    leapDays(year: number): number
    monthDays(year: number, month: number): number
    toChinaMonth(month: number): string
    toChinaDay(day: number): string
  }

  const solarLunar: SolarLunar
  export default solarLunar
}
