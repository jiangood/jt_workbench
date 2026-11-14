import assert from 'node:assert/strict'
import { Cron } from 'croner'
import { test } from 'node:test'
import {
  buildStartupCatchup,
  scheduleRevision,
  startLocalScheduler,
  validateScriptSchedule,
} from '../src/scheduler.mjs'

const script = {
  id: 'zsxq_sync',
  name: 'Knowledge sync',
  version: '1.0.0',
  description: 'Reliable cursor sync',
  schedule: '0 0 */2 * * *',
  enabled: true,
  timeout: 300,
  reliability: 'reliable',
}

test('schedule revision changes only when schedule semantics change', () => {
  assert.equal(scheduleRevision(script), scheduleRevision({ ...script, version: '1.1.0', description: 'changed code' }))
  assert.notEqual(scheduleRevision(script), scheduleRevision({ ...script, schedule: '0 30 */2 * * *' }))
  assert.notEqual(scheduleRevision(script), scheduleRevision({ ...script, enabled: false }))
})

test('validates six-field schedules and enforces the minimum interval', () => {
  assert.ok(validateScriptSchedule(script))
  assert.throws(() => validateScriptSchedule({ ...script, schedule: '* * * * *' }), /six-field/)
  assert.throws(() => validateScriptSchedule({ ...script, schedule: '*/30 * * * * *' }), /minimum interval/)
  assert.throws(() => validateScriptSchedule({ ...script, schedule: 'not a cron expression' }))
})

test('best_effort does not create startup catch-up; reliable creates one merged reconcile', () => {
  const now = Date.parse('2026-11-14T12:30:00+08:00')
  assert.equal(buildStartupCatchup({ ...script, reliability: 'best_effort' }, null, now), null)

  const startup = buildStartupCatchup(script, null, now)
  assert.equal(startup.kind, 'startup')
  assert.equal(startup.scheduledAt, Math.floor(now / 1000) * 1000)

  const checkpoint = Date.parse('2026-11-14T08:00:00+08:00')
  const catchup = buildStartupCatchup(script, checkpoint, now)
  assert.equal(catchup.kind, 'catchup')
  assert.equal(catchup.scheduledAt, Date.parse('2026-11-14T10:00:00+08:00'))
  assert.equal(catchup.through, now)

  const current = Date.parse('2026-11-14T12:00:00+08:00')
  assert.equal(buildStartupCatchup(script, current, now), null)
})

test('local scheduler fires at the next Asia/Shanghai slot and can be stopped', async () => {
  const cron = new Cron('0 * * * * *', { timezone: 'Asia/Shanghai', paused: true })
  const due = cron.nextRun(new Date(Date.now() + 1000))
  assert.ok(due)
  const base = due.getTime() - 200
  const started = Date.now()
  const triggers = []
  const scheduler = startLocalScheduler(
    [{ ...script, schedule: '0 * * * * *', reliability: 'best_effort' }],
    async (trigger) => { triggers.push(trigger); return true },
    {
      now: () => base + (Date.now() - started),
      lateGraceMs: 1000,
    },
  )
  await new Promise((resolve) => setTimeout(resolve, 400))
  scheduler.stop()
  assert.equal(triggers.length, 1)
  assert.equal(triggers[0].scheduledAt, due.getTime())
  assert.equal(triggers[0].kind, 'cron')
})
