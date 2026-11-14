import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { test } from 'node:test'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

test('cached ESM scripts resolve production dependencies from the Agent image', async (t) => {
  const cacheDir = await mkdtemp(join(process.cwd(), '.runtime-script-test-'))
  t.after(() => rm(cacheDir, { recursive: true, force: true }))

  const scriptPath = join(cacheDir, 'probe.mjs')
  await writeFile(
    scriptPath,
    [
      "import { load } from 'cheerio'",
      'export function readTitle(html) { return load(html)("title").text() }',
    ].join('\n'),
    'utf8',
  )

  // Mirror production layout: /app/scripts/<id>/<version>.mjs and /app/node_modules.
  const scriptUrl = `${pathToFileURL(scriptPath).href}?test=${Date.now()}`
  const script = await import(scriptUrl)
  assert.equal(script.readTitle('<html><head><title>runtime-ok</title></head></html>'), 'runtime-ok')
})
