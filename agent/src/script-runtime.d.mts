import type { ActiveScript } from './script-sync.mjs'

export interface ScriptLogger {
  debug(...args: any[]): void
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}
export interface ScriptRuntimeContext {
  logger: ScriptLogger
  config: Readonly<Record<string, unknown>>
  signal: AbortSignal
  executionId: string
  scriptId: string
  scriptVersion: string
  scheduledAt: number | null
}
export type ScriptFetch = (url: string, init?: RequestInit) => Promise<Response>
export interface ScriptResult {
  items: unknown[]
  summary: string
}
export function executeRemoteScript(
  script: ActiveScript,
  payload: unknown,
  context: ScriptRuntimeContext,
  safeFetch: ScriptFetch,
): Promise<ScriptResult>
