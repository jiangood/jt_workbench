import { createHash } from 'node:crypto'
import { Cron } from 'croner'

export const SCHEDULER_TIMEZONE = 'Asia/Shanghai'
export const MIN_SCHEDULE_INTERVAL_MS = 60_000
const MAX_TIMER_MS = 12 * 60 * 60 * 1000
const DEFAULT_LATE_GRACE_MS = 60_000
const DEFAULT_RETRY_MS = 30_000

export function scheduleRevision(script) {
  return createHash('sha256')
    .update(script.schedule + '\u0000' + String(script.enabled), 'utf8')
    .digest('hex')
    .slice(0, 32)
}

export function validateScriptSchedule(script) {
  if (!script || typeof script.schedule !== 'string' || script.schedule.trim().split(/\s+/).length !== 6) {
    throw new Error('script schedule must be a six-field Cron expression')
  }
  const cron = new Cron(script.schedule, { timezone: SCHEDULER_TIMEZONE, paused: true })
  const now = new Date()
  const first = cron.nextRun(now)
  if (!first) throw new Error('script schedule has no future occurrence')
  const second = cron.nextRun(new Date(first.getTime() + 1000))
  if (!second || second.getTime() - first.getTime() < MIN_SCHEDULE_INTERVAL_MS) {
    throw new Error('script schedule minimum interval is 60 seconds')
  }
  return cron
}

/**
 * Worker persists lastScheduledAt when it accepts a trigger. A reliable startup
 * catch-up uses the first missed slot as a stable idempotency key and advances
 * the Worker checkpoint through the current time; missed slots are reconciled once.
 */
export function buildStartupCatchup(script, lastScheduledAt, now = Date.now()) {
  if (!script.enabled || script.reliability !== 'reliable') return null
  const cron = validateScriptSchedule(script)
  if (lastScheduledAt === null || lastScheduledAt === undefined) {
    return {
      scriptId: script.id,
      scheduleRevision: scheduleRevision(script),
      scheduledAt: Math.floor(now / 1000) * 1000,
      through: now,
      kind: 'startup',
    }
  }
  if (!Number.isFinite(lastScheduledAt) || lastScheduledAt < 0) throw new Error('invalid schedule checkpoint')
  const firstMissed = cron.nextRun(new Date(lastScheduledAt + 1000))
  if (!firstMissed || firstMissed.getTime() > now) return null
  return {
    scriptId: script.id,
    scheduleRevision: scheduleRevision(script),
    scheduledAt: firstMissed.getTime(),
    through: now,
    kind: 'catchup',
  }
}

function triggerFor(script, scheduledAt, through, kind) {
  return {
    scriptId: script.id,
    scheduleRevision: scheduleRevision(script),
    scheduledAt,
    through,
    kind,
  }
}

export function startLocalScheduler(scripts, onTrigger, options = {}) {
  if (typeof onTrigger !== 'function') throw new Error('scheduler trigger callback is required')
  const now = options.now ?? Date.now
  const lateGraceMs = options.lateGraceMs ?? DEFAULT_LATE_GRACE_MS
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS
  const timers = new Set()
  let stopped = false

  for (const script of scripts) {
    if (!script.enabled) continue
    const cron = validateScriptSchedule(script)
    let next = cron.nextRun(new Date(now()))
    let delivering = false
    let retryTimer = null

    const arm = () => {
      if (stopped || !next) return
      const delay = Math.min(Math.max(0, next.getTime() - now()), MAX_TIMER_MS)
      const timer = setTimeout(() => {
        timers.delete(timer)
        if (stopped || !next) return
        const current = now()
        if (current < next.getTime()) {
          arm()
          return
        }

        const scheduledAt = next.getTime()
        const lateBy = current - scheduledAt
        const late = lateBy > lateGraceMs
        const kind = late ? (script.reliability === 'reliable' ? 'catchup' : 'drop') : 'cron'
        const trigger = triggerFor(script, scheduledAt, current, kind)

        // An earlier reliable request awaiting Worker recovery already represents
        // the missed slots. Do not enqueue or overlap another trigger.
        if (kind !== 'drop' && !delivering) {
          delivering = true
          const deliver = async () => {
            if (stopped) return
            try {
              await onTrigger(trigger)
              delivering = false
              if (retryTimer) {
                clearTimeout(retryTimer)
                timers.delete(retryTimer)
              }
              retryTimer = null
            } catch (error) {
              if (script.reliability === 'reliable' && !stopped) {
                retryTimer = setTimeout(() => {
                  timers.delete(retryTimer)
                  void deliver()
                }, retryMs)
                retryTimer.unref?.()
                timers.add(retryTimer)
              } else {
                delivering = false
                options.onError?.(error, script)
              }
            }
          }
          void deliver()
        }

        // Drop all other missed slots after this single catch-up decision.
        const nextFrom = late ? current + 1000 : scheduledAt + 1000
        next = cron.nextRun(new Date(nextFrom))
        arm()
      }, delay)
      timer.unref?.()
      timers.add(timer)
    }

    arm()
  }

  return {
    stop() {
      stopped = true
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
    },
  }
}
