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
export interface AgentNextResponse {
  now: number
  action: 'sync' | 'idle'
  schemaVersion: 1
  scripts: ScriptUpdate[]
  deletes: Array<{ id: string; version: string }>
  activeScripts: ScriptDescriptor[]
}
export interface ActiveScript extends ScriptMetadata {
  sha256: string
  path: string
}
export type NextScriptAction = (scripts: ScriptInventoryEntry[]) => Promise<AgentNextResponse>
export function parseScriptMetadata(source: string): ScriptMetadata
export function getScriptInventory(root?: string): Promise<ScriptInventoryEntry[]>
export function applyScriptSync(root: string, response: AgentNextResponse): Promise<void>
export function loadActiveScripts(root: string, activeScripts: ScriptDescriptor[]): Promise<ActiveScript[]>
export function synchronizeScripts(next: NextScriptAction, root?: string): Promise<ActiveScript[]>
