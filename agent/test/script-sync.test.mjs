import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  applyScriptSync,
  getScriptInventory,
  parseScriptMetadata,
  synchronizeScripts,
} from '../src/script-sync.mjs'

const meta = {
  id: 'sample',
  name: 'Sample task',
  version: '1.0.0',
  description: 'A test script',
  schedule: '0 0 */2 * * *',
  enabled: true,
  timeout: 30,
  reliability: 'best_effort',
}
const source = [
  '// @script',
  '// ' + JSON.stringify(meta),
  '' ,
  'export async function run() { return "ok" }',
].join('\n')
const descriptor = {
  ...meta,
  sha256: createHash('sha256').update(source).digest('hex'),
  contentPath: '/agent-scripts/sample/1.0.0.mjs',
}
const update = { ...descriptor, source }
const idle = { action: 'idle', schemaVersion: 1, scripts: [], deletes: [], activeScripts: [descriptor] }

async function tempRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'agent-script-sync-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

test('parses the script metadata header strictly', () => {
  assert.deepEqual(parseScriptMetadata(source), meta)
  assert.throws(() => parseScriptMetadata(source.replace('"reliability":"best_effort"', '"reliability":"unknown"')))
})

test('syncs source atomically, verifies its hash, and returns active cached scripts', async (t) => {
  const root = await tempRoot(t)
  let calls = 0
  const active = await synchronizeScripts(async (inventory) => {
    calls++
    if (calls === 1) {
      assert.deepEqual(inventory, [])
      return { action: 'sync', schemaVersion: 1, scripts: [update], deletes: [], activeScripts: [descriptor] }
    }
    assert.equal(inventory.length, 1)
    assert.equal(inventory[0].sha256, descriptor.sha256)
    return idle
  }, root)

  assert.equal(calls, 2)
  assert.equal(active.length, 1)
  assert.equal(active[0].id, 'sample')
  assert.equal(await readFile(active[0].path, 'utf8'), source)
})

test('rejects a bad hash without replacing the last known good version', async (t) => {
  const root = await tempRoot(t)
  const path = join(root, 'sample', '1.0.0.mjs')
  await mkdir(join(root, 'sample'), { recursive: true })
  await writeFile(path, source, 'utf8')
  const bad = { ...update, sha256: '0'.repeat(64) }

  await assert.rejects(
    synchronizeScripts(async () => ({
      action: 'sync', schemaVersion: 1, scripts: [bad], deletes: [], activeScripts: [descriptor],
    }), root),
    /sha256 mismatch/,
  )
  assert.equal(await readFile(path, 'utf8'), source)
})

test('applies revocations only to validated cache identities', async (t) => {
  const root = await tempRoot(t)
  const path = join(root, 'sample', '1.0.0.mjs')
  await mkdir(join(root, 'sample'), { recursive: true })
  await writeFile(path, source, 'utf8')
  let calls = 0
  await synchronizeScripts(async () => {
    calls++
    return calls === 1
      ? { action: 'sync', schemaVersion: 1, scripts: [], deletes: [{ id: 'sample', version: '1.0.0' }], activeScripts: [] }
      : { action: 'idle', schemaVersion: 1, scripts: [], deletes: [], activeScripts: [] }
  }, root)
  assert.deepEqual(await getScriptInventory(root), [])
  await assert.rejects(
    applyScriptSync(root, { schemaVersion: 1, scripts: [], deletes: [{ id: '../escape', version: '1.0.0' }] }),
    /invalid script delete identity/,
  )
})
