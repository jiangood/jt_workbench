import type { ScriptMetadata } from './script-sync.mjs'

export const SCHEDULER_TIMEZONE: 'Asia/Shanghai'
export const MIN_SCHEDULE_INTERVAL_MS: 60000
export interface ScheduleTrigger {
  scriptId: string
  scheduleRevision: string
  scheduledAt: number
  through: number
  kind: 'cron' | 'catchup' | 'startup'
}
export interface SchedulerScript extends ScriptMetadata {}
export interface SchedulerOptions {
  now?: () => number
  lateGraceMs?: number
  retryMs?: number
  onError?: (error: unknown, script: SchedulerScript) => void
}
export function scheduleRevision(script: Pick<SchedulerScript, 'schedule' | 'enabled'>): string
export function validateScriptSchedule(script: SchedulerScript): unknown
export function buildStartupCatchup(
  script: SchedulerScript,
  lastScheduledAt: number | null,
  now?: number,
): ScheduleTrigger | null
export function startLocalScheduler(
  scripts: SchedulerScript[],
  onTrigger: (trigger: ScheduleTrigger) => Promise<unknown>,
  options?: SchedulerOptions,
): { stop(): void }
