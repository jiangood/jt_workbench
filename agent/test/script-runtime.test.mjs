import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { executeRemoteScript } from '../src/script-runtime.mjs'

const root = join(process.cwd(), '.runtime-exec-test-' + process.pid)
const logger = { debug() {}, info() {}, warn() {}, error() {} }
const contextBase = {
  logger,
  config: {},
  executionId: 'execution-test',
  scriptId: 'runtime-test',
  scriptVersion: '1.0.0',
  scheduledAt: 1_800_000_000_000,
}

async function createScript(t, body, timeout = 10) {
  const dir = join(root, 'runtime-test')
  await mkdir(dir, { recursive: true })
  t.after(() => rm(root, { recursive: true, force: true }))
  const metadata = {
    id: 'runtime-test',
    name: 'Runtime test',
    version: '1.0.0',
    description: 'Exercise dynamic module execution',
    schedule: '0 0 */2 * * *',
    enabled: true,
    timeout,
    reliability: 'best_effort',
  }
  const source = [
    '// @script',
    '// ' + JSON.stringify(metadata),
    '',
    body,
  ].join('\n')
  const path = join(dir, '1.0.0.mjs')
  await writeFile(path, source, 'utf8')
  return { ...metadata, sha256: createHash('sha256').update(source).digest('hex'), path }
}

test('executes a cached ESM module and resolves preinstalled packages', async (t) => {
  const script = await createScript(t, [
    "import { load } from 'cheerio'",
    'export async function run(ctx, payload) {',
    '  ctx.logger.info({ executionId: ctx.executionId }, "run")',
    '  const title = load(payload.html)("title").text()',
    '  return { items: [{ title }], summary: title }',
    '}',
  ].join('\n'))

  const result = await executeRemoteScript(
    script,
    { html: '<html><head><title>remote-ok</title></head></html>' },
    { ...contextBase, signal: new AbortController().signal },
    async () => { throw new Error('fetch should not be called') },
  )
  assert.deepEqual(result, { items: [{ title: 'remote-ok' }], summary: 'remote-ok' })
})

test('aborts a cooperative script when its metadata timeout elapses', async (t) => {
  const script = await createScript(t, [
    'export async function run(ctx) {',
    '  await new Promise((resolve) => ctx.signal.addEventListener("abort", resolve, { once: true }))',
    '  return { items: [], summary: "aborted" }',
    '}',
  ].join('\n'), 1)

  await assert.rejects(
    executeRemoteScript(
      script,
      {},
      { ...contextBase, signal: new AbortController().signal },
      async () => { throw new Error('fetch should not be called') },
    ),
    /script timed out/,
  )
})

test('does not run a script whose cached bytes no longer match the manifest hash', async (t) => {
  const script = await createScript(t, 'export async function run() { return { items: [], summary: "bad" } }')
  await writeFile(script.path, 'export async function run() { return { items: [], summary: "tampered" } }', 'utf8')
  await assert.rejects(
    executeRemoteScript(
      script,
      {},
      { ...contextBase, signal: new AbortController().signal },
      async () => { throw new Error('fetch should not be called') },
    ),
    /cache hash mismatch/,
  )
})
