import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { parseScriptMetadata } from './script-sync.mjs'

function hash(source) {
  return createHash('sha256').update(source, 'utf8').digest('hex')
}

function combinedSignal(signals) {
  const active = signals.filter(Boolean)
  if (active.length === 1) return active[0]
  return AbortSignal.any(active)
}

export async function executeRemoteScript(script, payload, context, safeFetch) {
  if (!script || typeof script.path !== 'string' || typeof script.sha256 !== 'string') {
    throw new Error('invalid active script reference')
  }
  if (typeof safeFetch !== 'function') throw new Error('safe fetch implementation is required')

  const source = await readFile(script.path, 'utf8')
  if (hash(source) !== script.sha256) throw new Error('script cache hash mismatch: ' + script.id)
  const metadata = parseScriptMetadata(source)
  for (const key of ['id', 'name', 'version', 'description', 'schedule', 'enabled', 'timeout', 'reliability']) {
    if (metadata[key] !== script[key]) throw new Error('script cache metadata mismatch: ' + script.id + ' (' + key + ')')
  }
  if (context.scriptId !== script.id || context.scriptVersion !== script.version) {
    throw new Error('script execution context identity mismatch: ' + script.id)
  }

  const timeoutController = new AbortController()
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    timeoutController.abort(new Error('script timeout after ' + script.timeout + 's'))
  }, script.timeout * 1000)
  const signal = combinedSignal([context.signal, timeoutController.signal])

  const scriptContext = {
    ...context,
    signal,
    fetch: (url, init = {}) => {
      const requestSignal = combinedSignal([signal, init.signal])
      return safeFetch(url, { ...init, signal: requestSignal })
    },
  }

  try {
    const moduleUrl = pathToFileURL(script.path).href + '?sha256=' + script.sha256
    const loaded = await import(moduleUrl)
    if (typeof loaded.run !== 'function') throw new Error('remote script must export async function run(ctx, payload)')
    const result = await loaded.run(scriptContext, payload)
    if (timedOut) throw new Error('script timed out: ' + script.id)
    if (context.signal?.aborted) throw new Error('script aborted: ' + script.id)
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      throw new Error('script result must be an object: ' + script.id)
    }
    if (!Array.isArray(result.items) || result.items.length > 10_000) {
      throw new Error('script result items must be an array with at most 10000 entries: ' + script.id)
    }
    if (typeof result.summary !== 'string' || result.summary.length > 2000) {
      throw new Error('script result summary must be a string up to 2000 characters: ' + script.id)
    }
    // Reject circular structures and BigInt before they reach the Worker transport.
    JSON.stringify(result.items)
    return { items: result.items, summary: result.summary }
  } finally {
    clearTimeout(timeout)
  }
}
