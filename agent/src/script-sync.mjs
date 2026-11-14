import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'

const idPattern = /^[a-z][a-z0-9_-]{0,63}$/
const versionPattern = /^\d+\.\d+\.\d+$/
const metadataKeys = ['id', 'name', 'version', 'description', 'schedule', 'enabled', 'timeout', 'reliability']
const defaultRoot = () => join(process.cwd(), '.agent-scripts')

function digest(source) {
  return createHash('sha256').update(source, 'utf8').digest('hex')
}

function scriptPath(root, id, version) {
  if (!idPattern.test(id) || !versionPattern.test(version)) throw new Error('invalid script cache identity')
  const base = resolve(root)
  const path = resolve(base, id, version + '.mjs')
  if (!path.startsWith(base + '/')) throw new Error('script cache path escaped root')
  return path
}

export function parseScriptMetadata(source) {
  const normalized = source.replace(/^\uFEFF/, '')
  const match = normalized.match(/^\s*\/\/\s*@script\s*\r?\n((?:\s*\/\/.*(?:\r?\n|$))+)/)
  if (!match) throw new Error('missing // @script metadata header')
  const json = match[1].split(/\r?\n/).map((line) => line.replace(/^\s*\/\/\s?/, '')).join('\n').trim()
  let meta
  try { meta = JSON.parse(json) } catch (error) {
    throw new Error('invalid script metadata JSON: ' + error.message)
  }
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw new Error('script metadata must be an object')
  const keys = Object.keys(meta).sort()
  if (keys.join(',') !== [...metadataKeys].sort().join(',')) throw new Error('script metadata fields are incomplete or unknown')
  if (typeof meta.id !== 'string' || !idPattern.test(meta.id)) throw new Error('invalid script id')
  if (typeof meta.name !== 'string' || !meta.name.trim() || meta.name.length > 80) throw new Error('invalid script name')
  if (typeof meta.version !== 'string' || !versionPattern.test(meta.version)) throw new Error('invalid script version')
  if (typeof meta.description !== 'string' || meta.description.length > 300) throw new Error('invalid script description')
  if (typeof meta.schedule !== 'string' || meta.schedule.trim().split(/\s+/).length !== 6) throw new Error('script schedule must have six fields')
  if (typeof meta.enabled !== 'boolean') throw new Error('script enabled must be boolean')
  if (!Number.isInteger(meta.timeout) || meta.timeout < 1 || meta.timeout > 3600) throw new Error('invalid script timeout')
  if (meta.reliability !== 'best_effort' && meta.reliability !== 'reliable') throw new Error('invalid script reliability')
  return meta
}

function validateDescriptor(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid script descriptor')
  const meta = {
    id: value.id, name: value.name, version: value.version, description: value.description,
    schedule: value.schedule, enabled: value.enabled, timeout: value.timeout, reliability: value.reliability,
  }
  const serialized = Object.entries(meta).map(([key, field]) => JSON.stringify(key) + ':' + JSON.stringify(field)).join(',')
  const parsed = parseScriptMetadata('// @script\n// {' + serialized + '}\n')
  if (typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) throw new Error('invalid script sha256')
  if (value.contentPath !== '/agent-scripts/' + parsed.id + '/' + parsed.version + '.mjs') {
    throw new Error('invalid script content path')
  }
  return parsed
}

function assertMetadataMatches(sourceMeta, descriptorMeta) {
  for (const key of metadataKeys) {
    if (sourceMeta[key] !== descriptorMeta[key]) throw new Error('script metadata mismatch: ' + key)
  }
}

export async function getScriptInventory(root = defaultRoot()) {
  const base = resolve(root)
  await mkdir(base, { recursive: true })
  const inventory = []
  const dirs = await readdir(base, { withFileTypes: true })
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue
    if (!idPattern.test(dir.name)) throw new Error('invalid script cache directory: ' + dir.name)
    const files = await readdir(join(base, dir.name), { withFileTypes: true })
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith('.mjs')) continue
      const version = basename(file.name, '.mjs')
      if (!versionPattern.test(version)) throw new Error('invalid cached script filename: ' + file.name)
      const path = scriptPath(base, dir.name, version)
      const bytes = await readFile(path)
      const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      const meta = parseScriptMetadata(source)
      if (meta.id !== dir.name || meta.version !== version) throw new Error('cached script path does not match metadata')
      inventory.push({ id: meta.id, version: meta.version, sha256: digest(source) })
    }
  }
  return inventory.sort((a, b) => a.id.localeCompare(b.id) || a.version.localeCompare(b.version))
}

export async function applyScriptSync(root, response) {
  if (!response || response.schemaVersion !== 1 || !Array.isArray(response.scripts) || !Array.isArray(response.deletes)) {
    throw new Error('invalid script sync response')
  }
  if (response.scripts.length > 5 || response.deletes.length > 20) throw new Error('script sync batch exceeds limit')

  const updates = response.scripts.map((update) => {
    const meta = validateDescriptor(update)
    if (typeof update.source !== 'string') throw new Error('script source must be text')
    if (digest(update.source) !== update.sha256) throw new Error('script sha256 mismatch: ' + meta.id)
    const sourceMeta = parseScriptMetadata(update.source)
    assertMetadataMatches(sourceMeta, meta)
    return { ...meta, sha256: update.sha256, source: update.source }
  })
  const deletes = response.deletes.map((item) => {
    if (!item || typeof item !== 'object') throw new Error('invalid script delete entry')
    if (typeof item.id !== 'string' || !idPattern.test(item.id) ||
        typeof item.version !== 'string' || !versionPattern.test(item.version)) {
      throw new Error('invalid script delete identity')
    }
    return { id: item.id, version: item.version }
  })

  const base = resolve(root)
  for (const update of updates) {
    const target = scriptPath(base, update.id, update.version)
    const dir = join(base, update.id)
    await mkdir(dir, { recursive: true })
    const temporary = target + '.' + randomUUID() + '.tmp'
    try {
      await writeFile(temporary, update.source, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      await rename(temporary, target)
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined)
      throw error
    }
  }

  for (const item of deletes) {
    const target = scriptPath(base, item.id, item.version)
    await rm(target, { force: true })
    await rmdir(join(base, item.id)).catch(() => undefined)
  }
}

export async function loadCachedScript(root = defaultRoot(), id, version, sha256) {
  const base = resolve(root)
  const path = scriptPath(base, id, version)
  const bytes = await readFile(path)
  const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  if (digest(source) !== sha256) throw new Error('cached script hash mismatch: ' + id + '@' + version)
  const meta = parseScriptMetadata(source)
  if (meta.id !== id || meta.version !== version) throw new Error('cached script identity mismatch: ' + id + '@' + version)
  return { ...meta, sha256, path }
}

export async function loadActiveScripts(root, activeScripts) {
  if (!Array.isArray(activeScripts) || activeScripts.length > 100) throw new Error('invalid active script manifest')
  const seen = new Set()
  const active = []
  for (const descriptor of activeScripts) {
    const meta = validateDescriptor(descriptor)
    if (!meta.enabled) throw new Error('disabled script included in active manifest')
    if (seen.has(meta.id)) throw new Error('duplicate active script id: ' + meta.id)
    seen.add(meta.id)
    const cached = await loadCachedScript(root, meta.id, meta.version, descriptor.sha256)
    assertMetadataMatches(cached, meta)
    active.push(cached)
  }
  return active
}

export async function synchronizeScripts(next, root = defaultRoot()) {
  if (typeof next !== 'function') throw new Error('script sync callback is required')
  for (let round = 0; round < 100; round++) {
    const inventory = await getScriptInventory(root)
    const response = await next(inventory)
    if (!response || response.schemaVersion !== 1) throw new Error('unsupported Agent script protocol')
    const scripts = response.scripts ?? []
    const deletes = response.deletes ?? []
    if (response.action === 'idle') {
      if (scripts.length || deletes.length) throw new Error('idle response contains sync actions')
      return {
        scripts: await loadActiveScripts(root, response.activeScripts ?? []),
        checkpoints: response.checkpoints ?? [],
      }
    }
    if (response.action !== 'sync') throw new Error('unexpected Agent action: ' + response.action)
    if (!scripts.length && !deletes.length) throw new Error('empty script sync response would not converge')
    await applyScriptSync(root, response)
  }
  throw new Error('script synchronization did not converge within 100 rounds')
}
