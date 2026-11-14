import type { JobHandler } from '../types.js'
import { rssHandler } from '../jobs/rss.js'
import { stockHandler } from '../jobs/stock.js'
import {
  zsxqBackfillHandler,
  zsxqCommentsHandler,
  zsxqGroupsHandler,
  zsxqHandler,
  zsxqProbeHandler,
} from '../jobs/zsxq.js'
import { ttsHandler } from '../jobs/tts.js'

/**
 * A statically bundled script package may expose one or more task handlers.
 * Keep task types stable: they are part of the Worker/Agent data contract.
 */
export interface ScriptDefinition {
  package: string
  type: string
  handler: JobHandler
}

/** Static registry: esbuild can resolve every script and dependency at build time. */
export const scriptManifest = [
  { package: 'rss', type: 'rss_fetch', handler: rssHandler },
  { package: 'stock', type: 'stock_eod', handler: stockHandler },
  { package: 'zsxq', type: 'zsxq_sync', handler: zsxqHandler },
  { package: 'zsxq', type: 'zsxq_backfill', handler: zsxqBackfillHandler },
  { package: 'zsxq', type: 'zsxq_comments', handler: zsxqCommentsHandler },
  { package: 'zsxq', type: 'zsxq_probe', handler: zsxqProbeHandler },
  { package: 'zsxq', type: 'zsxq_groups', handler: zsxqGroupsHandler },
  { package: 'tts', type: 'tts_synthesize', handler: ttsHandler },
] satisfies readonly ScriptDefinition[]

/** Fail fast at startup/build-time import if the static registry is malformed. */
export function validateScriptManifest(
  entries: readonly ScriptDefinition[] = scriptManifest,
): void {
  const seen = new Set<string>()

  for (const entry of entries) {
    if (!entry.package.trim()) throw new Error('script manifest: package must not be empty')
    if (!entry.type.trim()) throw new Error('script manifest: task type must not be empty')
    if (seen.has(entry.type)) throw new Error(`script manifest: duplicate task type "${entry.type}"`)
    if (typeof entry.handler !== 'function') {
      throw new Error(`script manifest: handler for "${entry.type}" must be a function`)
    }
    seen.add(entry.type)
  }
}
