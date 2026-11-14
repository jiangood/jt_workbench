import { ApiError, type Bindings } from './envelope'
import { ingest } from './ingest'

const EXECUTION_LEASE_MS = 5 * 60_000
const MAX_RETRY_DELAY_MS = 6 * 60 * 60_000
const DEFAULT_MAX_ATTEMPTS = 8

export interface PublishedAgentScript {
  id: string
  name: string
  version: string
  description: string
  schedule: string
  enabled: boolean
  timeout: number
  reliability: 'best_effort' | 'reliable'
  sha256: string
  contentPath: string
}

interface LocalAgentScript { id: string; version: string; sha256: string }
interface AgentReport {
  executionId: string
  leaseToken: string
  reportId: string
  status: 'succeeded' | 'failed'
  summary?: string
  error?: string
  items?: unknown[]
}
interface AgentRuntimeRequest {
  runtimeReady?: boolean
  scripts: unknown[]
  triggers?: unknown[]
  running?: { executionId?: string; leaseToken?: string }
  report?: AgentReport
}
interface ScriptManifest { active: PublishedAgentScript[]; versions: PublishedAgentScript[] }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function scriptKey(id: string, version: string): string { return id + '\u0000' + version }

async function scheduleRevision(script: PublishedAgentScript): Promise<string> {
  const bytes = new TextEncoder().encode(script.schedule + '\u0000' + String(script.enabled))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, 32)
}

function validatePublishedScript(value: unknown): PublishedAgentScript {
  if (!isRecord(value)) throw new ApiError(503, 503, 'Agent script manifest entry is invalid')
  const { id, name, version, description, schedule, enabled, timeout, reliability, sha256, contentPath } = value
  if (
    typeof id !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(id) ||
    typeof name !== 'string' || !name.trim() || name.length > 80 ||
    typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version) ||
    typeof description !== 'string' || description.length > 300 ||
    typeof schedule !== 'string' || schedule.trim().split(/\s+/).length !== 6 ||
    typeof enabled !== 'boolean' ||
    typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout < 1 || timeout > 3600 ||
    (reliability !== 'best_effort' && reliability !== 'reliable') ||
    typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256) ||
    contentPath !== '/agent-scripts/' + id + '/' + version + '.mjs'
  ) throw new ApiError(503, 503, 'Agent script manifest entry is invalid')
  return { id, name, version, description, schedule, enabled, timeout, reliability, sha256, contentPath }
}

async function readManifest(env: Bindings, requestUrl: string): Promise<ScriptManifest> {
  const response = await env.ASSETS.fetch(new Request(new URL('/agent-scripts/manifest.json', requestUrl)))
  if (!response.ok) throw new ApiError(503, 503, 'Agent script manifest unavailable')
  const raw = await response.json() as { schemaVersion?: unknown; scripts?: unknown; versions?: unknown }
  if (raw.schemaVersion !== 1 || !Array.isArray(raw.scripts) || raw.scripts.length > 100) {
    throw new ApiError(503, 503, 'Agent script manifest is invalid')
  }
  const current = raw.scripts.map(validatePublishedScript)
  const versionValues = Array.isArray(raw.versions) ? raw.versions : raw.scripts
  if (versionValues.length > 1000) throw new ApiError(503, 503, 'Agent script version manifest is too large')
  const versions = versionValues.map(validatePublishedScript)
  const currentIds = new Set<string>()
  const versionKeys = new Set<string>()
  for (const script of current) {
    if (currentIds.has(script.id)) throw new ApiError(503, 503, 'Current Agent script manifest contains duplicate ids')
    currentIds.add(script.id)
  }
  const active = current.filter((script) => script.enabled)
  for (const script of versions) {
    const key = scriptKey(script.id, script.version)
    if (versionKeys.has(key)) throw new ApiError(503, 503, 'Duplicate Agent script version')
    versionKeys.add(key)
  }
  for (const script of active) {
    const version = versions.find((item) => item.id === script.id && item.version === script.version)
    if (!version || version.sha256 !== script.sha256) throw new ApiError(503, 503, 'Active Agent script version is not retained')
  }
  return { active, versions }
}

async function readPublishedSource(env: Bindings, requestUrl: string, script: PublishedAgentScript): Promise<string> {
  const response = await env.ASSETS.fetch(new Request(new URL(script.contentPath, requestUrl)))
  if (!response.ok) throw new ApiError(503, 503, 'Agent script asset unavailable: ' + script.id)
  const source = await response.text()
  const bytes = new TextEncoder().encode(source)
  if (bytes.byteLength > 512 * 1024) throw new ApiError(503, 503, 'Agent script asset exceeds size limit')
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  const actual = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  if (actual !== script.sha256) throw new ApiError(503, 503, 'Agent script asset hash mismatch: ' + script.id)
  return source
}

function validateLocalScripts(values: unknown[]): LocalAgentScript[] {
  if (values.length > 200) throw new ApiError(400, 400, 'local script inventory is too large')
  return values.map((value) => {
    if (!isRecord(value) ||
      typeof value.id !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(value.id) ||
      typeof value.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(value.version) ||
      typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) {
      throw new ApiError(400, 400, 'invalid local script inventory entry')
    }
    return { id: value.id, version: value.version, sha256: value.sha256 }
  })
}

async function claimRuntimeOwner(db: D1Database, nodeId: string, now: number): Promise<void> {
  await db.prepare('INSERT OR IGNORE INTO agent_runtime_owner (id, node_id, claimed_at) VALUES (1, ?, ?)')
    .bind(nodeId, now).run()
  const owner = await db.prepare('SELECT node_id FROM agent_runtime_owner WHERE id = 1')
    .first<{ node_id: string }>()
  if (!owner || owner.node_id !== nodeId) throw new ApiError(409, 409, 'permanent Agent runtime owner is already assigned')
}

async function readRuntimeOwner(db: D1Database): Promise<string | null> {
  const row = await db.prepare('SELECT node_id FROM agent_runtime_owner WHERE id = 1')
    .first<{ node_id: string }>()
  return row?.node_id ?? null
}

async function reconcileScripts(
  db: D1Database,
  env: Bindings,
  requestUrl: string,
  local: LocalAgentScript[],
  manifest: ScriptManifest,
) {
  const pinned = await db.prepare(
    "SELECT DISTINCT script_id, script_version, script_sha256 FROM agent_execution WHERE status IN ('pending', 'running', 'interrupted', 'needs_attention')",
  ).all<{ script_id: string; script_version: string; script_sha256: string }>()
  const required = new Map<string, PublishedAgentScript>()
  for (const script of manifest.active) required.set(scriptKey(script.id, script.version), script)
  for (const row of pinned.results ?? []) {
    const key = scriptKey(row.script_id, row.script_version)
    const script = manifest.versions.find((item) => scriptKey(item.id, item.version) === key)
    if (!script || script.sha256 !== row.script_sha256) {
      throw new ApiError(503, 503, 'a pending execution references a missing published script version: ' + row.script_id)
    }
    required.set(key, script)
  }

  const localByVersion = new Map(local.map((script) => [scriptKey(script.id, script.version), script]))
  const updates: Array<PublishedAgentScript & { source: string }> = []
  for (const [key, script] of required) {
    const installed = localByVersion.get(key)
    if (installed?.sha256 === script.sha256) continue
    if (updates.length >= 5) break
    updates.push({ ...script, source: await readPublishedSource(env, requestUrl, script) })
  }
  const requiredKeys = new Set(required.keys())
  const deletes = local.filter((script) => !requiredKeys.has(scriptKey(script.id, script.version)))
    .slice(0, 20).map(({ id, version }) => ({ id, version }))

  const checkpoints: Array<{ scriptId: string; scheduleRevision: string; lastScheduledAt: number | null }> = []
  for (const script of manifest.active) {
    const revision = await scheduleRevision(script)
    const state = await db.prepare(
      'SELECT last_scheduled_at FROM agent_script_state WHERE script_id = ? AND schedule_revision = ?',
    ).bind(script.id, revision).first<{ last_scheduled_at: number | null }>()
    checkpoints.push({ scriptId: script.id, scheduleRevision: revision, lastScheduledAt: state?.last_scheduled_at ?? null })
  }
  return { scripts: updates, deletes, activeScripts: manifest.active, checkpoints }
}

async function updateScheduleCheckpoint(db: D1Database, scriptId: string, revision: string, through: number, now: number) {
  await db.prepare(
    'INSERT INTO agent_script_state (script_id, schedule_revision, last_scheduled_at, updated_at) VALUES (?, ?, ?, ?) ' +
    'ON CONFLICT(script_id, schedule_revision) DO UPDATE SET ' +
    'last_scheduled_at = CASE WHEN agent_script_state.last_scheduled_at IS NULL OR agent_script_state.last_scheduled_at < excluded.last_scheduled_at ' +
    'THEN excluded.last_scheduled_at ELSE agent_script_state.last_scheduled_at END, updated_at = excluded.updated_at',
  ).bind(scriptId, revision, through, now).run()
}

async function processTriggers(
  db: D1Database,
  nodeId: string,
  triggers: unknown[],
  activeScripts: PublishedAgentScript[],
  now: number,
) {
  if (triggers.length > 20) throw new ApiError(400, 400, 'too many Agent triggers')
  const byId = new Map(activeScripts.map((script) => [script.id, script]))
  const results: Array<{ scriptId: string; scheduledAt: number; accepted: boolean; reason?: string }> = []
  for (const value of triggers) {
    if (!isRecord(value) ||
      typeof value.scriptId !== 'string' ||
      typeof value.scheduleRevision !== 'string' || !/^[a-f0-9]{32}$/.test(value.scheduleRevision) ||
      typeof value.scheduledAt !== 'number' || !Number.isSafeInteger(value.scheduledAt) ||
      typeof value.through !== 'number' || !Number.isSafeInteger(value.through) || value.through < value.scheduledAt ||
      (value.kind !== 'cron' && value.kind !== 'catchup' && value.kind !== 'startup')) {
      throw new ApiError(400, 400, 'invalid Agent trigger')
    }
    const script = byId.get(value.scriptId)
    if (!script) {
      results.push({ scriptId: value.scriptId, scheduledAt: value.scheduledAt, accepted: false, reason: 'disabled_or_unknown' })
      continue
    }
    const revision = await scheduleRevision(script)
    if (revision !== value.scheduleRevision) throw new ApiError(409, 409, 'schedule revision changed: ' + script.id)
    if (script.reliability === 'best_effort' && value.kind !== 'cron') {
      throw new ApiError(400, 400, 'best_effort scripts cannot request startup catch-up')
    }
    await updateScheduleCheckpoint(db, script.id, revision, value.through, now)
    const active = await db.prepare(
      "SELECT execution_id FROM agent_execution WHERE script_id = ? AND status IN ('pending', 'running', 'interrupted', 'needs_attention') LIMIT 1",
    ).bind(script.id).first<{ execution_id: string }>()
    if (active) {
      results.push({ scriptId: script.id, scheduledAt: value.scheduledAt, accepted: true, reason: 'execution_already_active' })
      continue
    }
    const executionId = crypto.randomUUID()
    await db.prepare(
      "INSERT OR IGNORE INTO agent_execution (execution_id, script_id, script_version, script_sha256, schedule_revision, scheduled_at, trigger_kind, reliability, status, attempt, max_attempts, next_attempt_at, node_id, payload_json, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, '{}', ?, ?)",
    ).bind(
      executionId, script.id, script.version, script.sha256, revision, value.scheduledAt,
      value.kind, script.reliability, DEFAULT_MAX_ATTEMPTS, now, nodeId, now, now,
    ).run()
    results.push({ scriptId: script.id, scheduledAt: value.scheduledAt, accepted: true })
  }
  return results
}

async function processReport(db: D1Database, nodeId: string, report: AgentReport, now: number) {
  if (
    !report || typeof report.executionId !== 'string' || !report.executionId ||
    typeof report.leaseToken !== 'string' || !report.leaseToken ||
    typeof report.reportId !== 'string' || !report.reportId || report.reportId.length > 128 ||
    (report.status !== 'succeeded' && report.status !== 'failed')
  ) throw new ApiError(400, 400, 'invalid execution report')

  const row = await db.prepare(
    'SELECT execution_id, script_id, reliability, status, attempt, max_attempts, lease_token, node_id, payload_json, last_report_id ' +
    'FROM agent_execution WHERE execution_id = ?',
  ).bind(report.executionId).first<{
    execution_id: string; script_id: string; reliability: 'best_effort' | 'reliable'; status: string
    attempt: number; max_attempts: number; lease_token: string | null; node_id: string
    payload_json: string; last_report_id: string | null
  }>()
  if (!row || row.node_id !== nodeId) throw new ApiError(409, 409, 'execution lease lost')
  if (row.last_report_id === report.reportId) return { accepted: true, inserted: 0 }
  if (row.status !== 'running' || row.lease_token !== report.leaseToken) throw new ApiError(409, 409, 'execution lease lost')

  if (report.status === 'succeeded') {
    const items = report.items ?? []
    if (!Array.isArray(items) || items.length > 10_000) throw new ApiError(400, 400, 'invalid execution result items')
    let inserted = 0
    if (items.length > 0) {
      let payload: Record<string, unknown> = {}
      try {
        const parsed: unknown = JSON.parse(row.payload_json)
        if (isRecord(parsed)) payload = parsed
      } catch { /* malformed payload fails closed as empty data */ }
      const result = await ingest(db, row.script_id, payload, items, now)
      if (result === null) throw new ApiError(400, 400, 'no ingest handler for script: ' + row.script_id)
      inserted = result
    }
    const updated = await db.prepare(
      "UPDATE agent_execution SET status = 'succeeded', result_summary = ?, last_error = NULL, lease_until = NULL, lease_token = NULL, last_report_id = ?, finished_at = ?, updated_at = ? " +
      "WHERE execution_id = ? AND status = 'running' AND lease_token = ?",
    ).bind((report.summary ?? '').slice(0, 2000), report.reportId, now, now, report.executionId, report.leaseToken).run()
    if (updated.meta.changes === 0) throw new ApiError(409, 409, 'execution lease lost')
    return { accepted: true, inserted }
  }

  const error = (report.error ?? 'unknown execution failure').slice(0, 2000)
  const retry = row.reliability === 'reliable' && row.attempt < row.max_attempts
  const status = retry ? 'pending' : row.reliability === 'reliable' ? 'needs_attention' : 'failed'
  const delay = Math.min(5 * 60_000 * 2 ** Math.max(0, row.attempt - 1), MAX_RETRY_DELAY_MS)
  const failed = await db.prepare(
    'UPDATE agent_execution SET status = ?, next_attempt_at = ?, lease_until = NULL, lease_token = NULL, last_error = ?, last_report_id = ?, finished_at = ?, updated_at = ? ' +
    "WHERE execution_id = ? AND status = 'running' AND lease_token = ?",
  ).bind(status, retry ? now + delay : now, error, report.reportId, retry ? null : now, now, report.executionId, report.leaseToken).run()
  if (failed.meta.changes === 0) throw new ApiError(409, 409, 'execution lease lost')
  return { accepted: true, inserted: 0 }
}

async function renewExecutionLease(
  db: D1Database, nodeId: string, running: { executionId?: string; leaseToken?: string }, now: number,
) {
  if (typeof running.executionId !== 'string' || typeof running.leaseToken !== 'string') {
    throw new ApiError(400, 400, 'invalid running execution reference')
  }
  const result = await db.prepare(
    "UPDATE agent_execution SET lease_until = ?, updated_at = ? WHERE execution_id = ? AND status = 'running' AND node_id = ? AND lease_token = ?",
  ).bind(now + EXECUTION_LEASE_MS, now, running.executionId, nodeId, running.leaseToken).run()
  if (result.meta.changes === 0) throw new ApiError(409, 409, 'execution lease lost')
}

async function recoverOrphanedExecutions(db: D1Database, nodeId: string, now: number) {
  const rows = await db.prepare(
    "SELECT execution_id, reliability, attempt, max_attempts FROM agent_execution WHERE status = 'running' AND node_id = ?",
  ).bind(nodeId).all<{ execution_id: string; reliability: 'best_effort' | 'reliable'; attempt: number; max_attempts: number }>()
  for (const row of rows.results ?? []) {
    const status = row.reliability === 'best_effort'
      ? 'expired'
      : row.attempt < row.max_attempts ? 'interrupted' : 'needs_attention'
    await db.prepare(
      "UPDATE agent_execution SET status = ?, next_attempt_at = ?, lease_until = NULL, lease_token = NULL, last_error = 'Agent process restarted or lost execution state', finished_at = ?, updated_at = ? WHERE execution_id = ? AND status = 'running'",
    ).bind(status, now, status === 'expired' || status === 'needs_attention' ? now : null, now, row.execution_id).run()
  }
}

async function claimNextExecution(db: D1Database, nodeId: string, now: number) {
  const running = await db.prepare(
    "SELECT execution_id FROM agent_execution WHERE status = 'running' AND lease_until > ? LIMIT 1",
  ).bind(now).first<{ execution_id: string }>()
  if (running) return null
  const row = await db.prepare(
    "SELECT execution_id, script_id, script_version, script_sha256, schedule_revision, scheduled_at, trigger_kind, reliability, attempt, max_attempts, payload_json " +
    "FROM agent_execution WHERE status IN ('pending', 'interrupted') AND next_attempt_at <= ? " +
    "ORDER BY CASE reliability WHEN 'reliable' THEN 0 ELSE 1 END, created_at ASC LIMIT 1",
  ).bind(now).first<{
    execution_id: string; script_id: string; script_version: string; script_sha256: string
    schedule_revision: string; scheduled_at: number; trigger_kind: string
    reliability: 'best_effort' | 'reliable'; attempt: number; max_attempts: number; payload_json: string
  }>()
  if (!row) return null
  const leaseToken = crypto.randomUUID()
  const updated = await db.prepare(
    "UPDATE agent_execution SET status = 'running', attempt = attempt + 1, lease_token = ?, lease_until = ?, node_id = ?, started_at = COALESCE(started_at, ?), updated_at = ? " +
    "WHERE execution_id = ? AND status IN ('pending', 'interrupted') AND next_attempt_at <= ?",
  ).bind(leaseToken, now + EXECUTION_LEASE_MS, nodeId, now, now, row.execution_id, now).run()
  if (updated.meta.changes === 0) return null
  let payload: unknown = {}
  try { payload = JSON.parse(row.payload_json) } catch { /* use empty data */ }
  return {
    executionId: row.execution_id,
    scriptId: row.script_id,
    scriptVersion: row.script_version,
    scriptSha256: row.script_sha256,
    scheduleRevision: row.schedule_revision,
    scheduledAt: row.scheduled_at,
    triggerKind: row.trigger_kind,
    reliability: row.reliability,
    attempt: row.attempt + 1,
    leaseToken,
    leaseUntil: now + EXECUTION_LEASE_MS,
    payload,
  }
}

export async function handleAgentNext(
  db: D1Database,
  env: Bindings,
  nodeId: string,
  requestUrl: string,
  body: AgentRuntimeRequest,
  now: number,
) {
  const runtimeReady = body.runtimeReady === true
  if (runtimeReady) await claimRuntimeOwner(db, nodeId, now)
  else {
    const owner = await readRuntimeOwner(db)
    if (owner && owner !== nodeId) throw new ApiError(409, 409, 'Agent runtime is owned by another node')
  }

  let reportResult: { accepted: boolean; inserted: number } | null = null
  if (body.report) reportResult = await processReport(db, nodeId, body.report, now)
  if (body.running && !body.report) {
    await renewExecutionLease(db, nodeId, body.running, now)
    return {
      schemaVersion: 1,
      action: 'running' as const,
      scripts: [],
      deletes: [],
      activeScripts: [],
      checkpoints: [],
      reportAccepted: false,
      inserted: 0,
    }
  }
  if (!body.running && !body.report && runtimeReady) await recoverOrphanedExecutions(db, nodeId, now)

  const local = validateLocalScripts(body.scripts ?? [])
  const manifest = await readManifest(env, requestUrl)
  const sync = await reconcileScripts(db, env, requestUrl, local, manifest)
  const needsSync = sync.scripts.length > 0 || sync.deletes.length > 0
  const common = {
    schemaVersion: 1,
    scripts: sync.scripts,
    deletes: sync.deletes,
    activeScripts: sync.activeScripts,
    checkpoints: sync.checkpoints,
    reportAccepted: reportResult?.accepted ?? false,
    inserted: reportResult?.inserted ?? 0,
  }
  if (needsSync) return { ...common, action: 'sync' as const }
  if (!runtimeReady) return { ...common, action: 'idle' as const }

  let triggerResults: Array<{ scriptId: string; scheduledAt: number; accepted: boolean; reason?: string }> = []
  if (body.triggers !== undefined) {
    if (!Array.isArray(body.triggers)) throw new ApiError(400, 400, 'triggers must be an array')
    triggerResults = await processTriggers(db, nodeId, body.triggers, sync.activeScripts, now)
  }
  if (body.running && !body.report) return { ...common, triggerResults, action: 'running' as const }

  const execution = await claimNextExecution(db, nodeId, now)
  return { ...common, triggerResults, action: execution ? 'execute' as const : 'idle' as const, execution }
}
