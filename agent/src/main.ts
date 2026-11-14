import { randomUUID } from 'node:crypto'
import pino from 'pino'
import { client, ConflictError, UnauthorizedError } from './client.js'
import { getConfig } from './config.js'
import { describeError } from './describe-error.js'
import { runRemoteScript } from './remote-runner.js'
import { buildStartupCatchup, scheduleRevision, startLocalScheduler } from './scheduler.mjs'
import {
  getScriptInventory,
  loadCachedScript,
  synchronizeScripts,
} from './script-sync.mjs'
import type {
  AgentExecution,
  AgentNextRequest,
  AgentNextResponse,
  ScheduleCheckpoint,
  ScheduleTrigger,
} from './script-sync.mjs'

const log = pino()
const IDLE_POLL_MS = 30_000
const HEARTBEAT_MS = 60_000
const SCRIPT_SYNC_MS = 5 * 60_000
const RETRY_MS = 30_000

interface RunningExecution {
  execution: AgentExecution
  controller: AbortController
}

let running: RunningExecution | null = null
let pendingExecution: AgentExecution | null = null
let scheduler: ReturnType<typeof startLocalScheduler> | null = null
let activeRevisions = new Map<string, string>()
let needsResync = true
let nextSyncAt = 0
let stopping = false
let requestQueue: Promise<void> = Promise.resolve()

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function queueExecution(execution: AgentExecution): void {
  if (running) {
    if (!pendingExecution) pendingExecution = execution
    else if (pendingExecution.executionId !== execution.executionId) {
      log.error({ current: running.execution.executionId, pending: pendingExecution.executionId, received: execution.executionId }, 'Worker returned multiple queued executions')
    }
    return
  }
  if (pendingExecution && pendingExecution.executionId !== execution.executionId) {
    log.error({ pending: pendingExecution.executionId, received: execution.executionId }, 'Worker returned an overlapping execution')
    return
  }
  pendingExecution = execution
  startPendingExecution()
}

function startPendingExecution(): void {
  if (running || !pendingExecution || stopping) return
  const execution = pendingExecution
  pendingExecution = null
  const state: RunningExecution = { execution, controller: new AbortController() }
  // Set running synchronously before any async work so the next poll cannot orphan this lease.
  running = state
  void executeAndReport(state)
}

async function requestNext(request: AgentNextRequest = {}): Promise<AgentNextResponse> {
  const task = requestQueue.then(async () => {
    if (request.running && (!running || running.execution.executionId !== request.running.executionId)) {
      return {
        now: Date.now(), schemaVersion: 1, action: 'running',
        scripts: [], deletes: [], activeScripts: [], checkpoints: [],
        reportAccepted: false, inserted: 0,
      } as AgentNextResponse
    }
    if (running && !request.running && !request.report) {
      if (request.triggers?.length) {
        return {
          now: Date.now(), schemaVersion: 1, action: 'running',
          scripts: [], deletes: [], activeScripts: [], checkpoints: [],
          reportAccepted: false, inserted: 0,
          triggerResults: request.triggers.map((trigger) => ({
            scriptId: trigger.scriptId, scheduledAt: trigger.scheduledAt,
            accepted: false, reason: 'agent_busy',
          })),
        } as AgentNextResponse
      }
      request = {
        ...request,
        running: { executionId: running.execution.executionId, leaseToken: running.execution.leaseToken },
      }
    }
    const scripts = request.running ? [] : request.scripts ?? await getScriptInventory()
    const response = await client.next({
      ...request,
      runtimeReady: true,
      scripts,
    })
    if (response.action === 'sync') needsResync = true
    if (response.execution) queueExecution(response.execution)
    return response
  })
  requestQueue = task.then(() => undefined, () => undefined)
  return task
}

async function sendReport(
  state: RunningExecution,
  report: NonNullable<AgentNextRequest['report']>,
): Promise<void> {
  while (!stopping) {
    try {
      const response = await requestNext({ report })
      if (response.reportAccepted) return
      throw new Error('Worker did not acknowledge execution report')
    } catch (error) {
      if (error instanceof ConflictError) {
        state.controller.abort(error)
        throw error
      }
      if (stopping) throw error
      if (error instanceof UnauthorizedError) {
        log.warn({ err: describeError(error), executionId: state.execution.executionId }, 'report waiting for valid node credentials')
        await sleep(60_000)
      } else {
        log.warn({ err: describeError(error), executionId: state.execution.executionId }, 'execution report will be retried')
        await sleep(RETRY_MS)
      }
    }
  }
  throw new Error('Agent is shutting down before report acknowledgement')
}

async function executeAndReport(state: RunningExecution): Promise<void> {
  const { execution, controller } = state
  const executionLog = log.child({
    executionId: execution.executionId,
    scriptId: execution.scriptId,
    scriptVersion: execution.scriptVersion,
    attempt: execution.attempt,
  })
  let heartbeat: ReturnType<typeof setInterval> | undefined

  try {
    const script = await loadCachedScript(undefined, execution.scriptId, execution.scriptVersion, execution.scriptSha256)
    heartbeat = setInterval(() => {
      if (running !== state || stopping) return
      void requestNext({
        running: { executionId: execution.executionId, leaseToken: execution.leaseToken },
      }).catch((error) => {
        executionLog.warn({ err: describeError(error) }, 'execution heartbeat failed')
        if (error instanceof ConflictError) controller.abort(error)
      })
    }, HEARTBEAT_MS)
    heartbeat.unref?.()

    executionLog.info({ scheduledAt: execution.scheduledAt }, 'remote script started')
    const result = await runRemoteScript(
      script,
      execution.payload,
      {
        logger: executionLog,
        config: {},
        signal: controller.signal,
        executionId: execution.executionId,
        scriptId: execution.scriptId,
        scriptVersion: execution.scriptVersion,
        scheduledAt: execution.scheduledAt,
      },
    )
    await sendReport(state, {
      executionId: execution.executionId,
      leaseToken: execution.leaseToken,
      reportId: randomUUID(),
      status: 'succeeded',
      summary: result.summary,
      items: result.items,
    })
    executionLog.info({ itemCount: result.items.length, summary: result.summary }, 'remote script completed')
  } catch (error) {
    executionLog.error({ err: describeError(error) }, 'remote script failed')
    if (!stopping && !(error instanceof ConflictError)) {
      try {
        await sendReport(state, {
          executionId: execution.executionId,
          leaseToken: execution.leaseToken,
          reportId: randomUUID(),
          status: 'failed',
          error: describeError(error),
        })
      } catch (reportError) {
        executionLog.error({ err: describeError(reportError) }, 'failed to report execution failure')
      }
    }
  } finally {
    if (heartbeat) clearInterval(heartbeat)
    if (running === state) running = null
    startPendingExecution()
  }
}

async function handleScheduledTrigger(trigger: ScheduleTrigger): Promise<boolean> {
  if (stopping || needsResync || running || pendingExecution) return false
  const response = await requestNext({ triggers: [trigger] })
  if (response.action === 'sync') throw new Error('script manifest changed; sync before accepting Cron trigger')
  return response.triggerResults?.find(
    (item) => item.scriptId === trigger.scriptId && item.scheduledAt === trigger.scheduledAt,
  )?.accepted ?? false
}

async function refreshScripts(): Promise<void> {
  scheduler?.stop()
  scheduler = null
  await requestQueue
  if (running || pendingExecution) {
    needsResync = true
    return
  }

  const sync = await synchronizeScripts((scripts) => client.next({ scripts }))
  const checkpoints = new Map<string, ScheduleCheckpoint>(
    sync.checkpoints.map((checkpoint) => [checkpoint.scriptId, checkpoint]),
  )
  const nextRevisions = new Map<string, string>()
  const startupTriggers: ScheduleTrigger[] = []
  const now = Date.now()

  for (const script of activeScripts) {
    const revision = scheduleRevision(script)
    nextRevisions.set(script.id, revision)
    if (activeRevisions.get(script.id) !== revision) {
      const checkpoint = checkpoints.get(script.id)
      const trigger = buildStartupCatchup(script, checkpoint?.lastScheduledAt ?? null, now)
      if (trigger) startupTriggers.push(trigger)
    }
  }
  activeRevisions = nextRevisions

  const response = await requestNext({ triggers: startupTriggers })
  if (response.action === 'sync') {
    needsResync = true
    return
  }

  scheduler = startLocalScheduler(activeScripts, handleScheduledTrigger, {
    onError: (error, script) => log.warn({ err: describeError(error), scriptId: script.id }, 'Cron trigger delivery failed'),
  })
  nextSyncAt = Date.now() + SCRIPT_SYNC_MS
  needsResync = false
  log.info({
    scripts: activeScripts.map(({ id, version, reliability, schedule }) => ({ id, version, reliability, schedule })),
    startupCatchups: startupTriggers.length,
  }, 'remote script runtime ready')
}

function handleLoopError(error: unknown, action: string): number {
  if (error instanceof ConflictError) {
    log.fatal({ err: describeError(error), action }, 'Agent runtime ownership or execution conflict; stopping')
    process.exit(1)
  }
  if (error instanceof UnauthorizedError) {
    log.warn({ action }, 'node credentials invalid or node unregistered; retrying after 60 seconds')
    return 60_000
  }
  log.error({ err: describeError(error), action }, 'Agent runtime request failed')
  return RETRY_MS
}

async function main(): Promise<void> {
  const cfg = getConfig()
  log.info({ serverUrl: cfg.serverUrl, idlePollMs: IDLE_POLL_MS }, 'single-Agent remote runtime starting')

  while (!stopping) {
    try {
      await refreshScripts()
      break
    } catch (error) {
      await sleep(handleLoopError(error, 'initial script sync'))
    }
  }

  while (!stopping) {
    if (needsResync && !running) {
      try {
        await refreshScripts()
      } catch (error) {
        await sleep(handleLoopError(error, 'script resync'))
        continue
      }
    }

    if (!running && !pendingExecution) {
      if (Date.now() >= nextSyncAt) {
        needsResync = true
        continue
      }
      try {
        await requestNext()
      } catch (error) {
        await sleep(handleLoopError(error, 'idle poll'))
        continue
      }
    }
    await sleep(IDLE_POLL_MS)
  }
}

function shutdown(signal: string): void {
  if (stopping) return
  stopping = true
  log.warn({ signal }, 'Agent shutting down')
  scheduler?.stop()
  running?.controller.abort(new Error('Agent shutdown'))
  const forceExit = setTimeout(() => process.exit(0), 10_000)
  forceExit.unref?.()
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

main().catch((error: unknown) => {
  log.fatal({ err: describeError(error) }, 'Agent runtime crashed')
  process.exit(1)
})
