export interface ScriptMetadata {
  id: string
  name: string
  version: string
  description: string
  schedule: string
  enabled: boolean
  timeout: number
  reliability: 'best_effort' | 'reliable'
}
export interface ScriptDescriptor extends ScriptMetadata {
  sha256: string
  contentPath: string
}
export interface ScriptUpdate extends ScriptDescriptor {
  source: string
}
export interface ScriptInventoryEntry {
  id: string
  version: string
  sha256: string
}
export interface ScheduleCheckpoint {
  scriptId: string
  scheduleRevision: string
  lastScheduledAt: number | null
}
export interface AgentExecution {
  executionId: string
  scriptId: string
  scriptVersion: string
  scriptSha256: string
  scheduleRevision: string
  scheduledAt: number
  triggerKind: 'cron' | 'catchup' | 'startup'
  reliability: 'best_effort' | 'reliable'
  attempt: number
  leaseToken: string
  leaseUntil: number
  payload: unknown
}
export interface TriggerResult {
  scriptId: string
  scheduledAt: number
  accepted: boolean
  reason?: string
}
export interface AgentNextRequest {
  runtimeReady?: boolean
  scripts?: ScriptInventoryEntry[]
  triggers?: Array<{
    scriptId: string
    scheduleRevision: string
    scheduledAt: number
    through: number
    kind: 'cron' | 'catchup' | 'startup'
  }>
  running?: { executionId: string; leaseToken: string }
  report?: {
    executionId: string
    leaseToken: string
    reportId: string
    status: 'succeeded' | 'failed'
    summary?: string
    error?: string
    items?: unknown[]
  }
}
export interface AgentNextResponse {
  now: number
  action: 'sync' | 'execute' | 'running' | 'idle'
  schemaVersion: 1
  scripts: ScriptUpdate[]
  deletes: Array<{ id: string; version: string }>
  activeScripts: ScriptDescriptor[]
  checkpoints?: ScheduleCheckpoint[]
  reportAccepted?: boolean
  inserted?: number
  triggerResults?: TriggerResult[]
  execution?: AgentExecution | null
  agentLatestVersion?: string
}
export interface ActiveScript extends ScriptMetadata {
  sha256: string
  path: string
}
export interface SyncResult {
  scripts: ActiveScript[]
  checkpoints: ScheduleCheckpoint[]
}
export type NextScriptAction = (scripts: ScriptInventoryEntry[]) => Promise<AgentNextResponse>
export function parseScriptMetadata(source: string): ScriptMetadata
export function getScriptInventory(root?: string): Promise<ScriptInventoryEntry[]>
export function applyScriptSync(root: string, response: AgentNextResponse): Promise<void>
export function loadCachedScript(root: string | undefined, id: string, version: string, sha256: string): Promise<ActiveScript>
export function loadActiveScripts(root: string, activeScripts: ScriptDescriptor[]): Promise<ActiveScript[]>
export function synchronizeScripts(next: NextScriptAction, root?: string): Promise<SyncResult>
