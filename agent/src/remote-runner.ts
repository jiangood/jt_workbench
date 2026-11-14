import { executeRemoteScript } from './script-runtime.mjs'
import { safeFetch } from './ssrf.js'
import type { ActiveScript } from './script-sync.mjs'
import type { ScriptRuntimeContext, ScriptResult } from './script-runtime.mjs'

/** Runtime adapter used by the execution coordinator once Worker grants an execution. */
export function runRemoteScript(
  script: ActiveScript,
  payload: unknown,
  context: ScriptRuntimeContext,
): Promise<ScriptResult> {
  return executeRemoteScript(script, payload, context, safeFetch)
}
