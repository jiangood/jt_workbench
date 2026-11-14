import { createHash } from 'node:crypto'
import { readdir, readFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { Cron } from 'croner'

const sourceRoot = resolve('agent-scripts')
const outputRoot = resolve('public/agent-scripts')
const idPattern = /^[a-z][a-z0-9_-]{0,63}$/
const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const allowedKeys = new Set([
  'id', 'name', 'version', 'description', 'schedule', 'enabled', 'timeout', 'reliability',
])

function parseMetadata(source, filename) {
  const match = source.match(/\/\*\*[\s\S]*?@script\s*([\s\S]*?)\*\//)
  if (!match) throw new Error(filename + ': missing @script metadata block')
  const json = match[1]
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\*\s?/, ''))
    .join('\n')
    .trim()
  let meta
  try { meta = JSON.parse(json) } catch (error) {
    throw new Error(filename + ': invalid metadata JSON: ' + error.message)
  }
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    throw new Error(filename + ': metadata must be an object')
  }
  for (const key of Object.keys(meta)) {
    if (!allowedKeys.has(key)) throw new Error(filename + ': unsupported metadata field ' + key)
  }
  for (const key of allowedKeys) {
    if (!(key in meta)) throw new Error(filename + ': missing metadata field ' + key)
  }
  if (typeof meta.id !== 'string' || !idPattern.test(meta.id)) throw new Error(filename + ': invalid id')
  if (typeof meta.name !== 'string' || !meta.name.trim() || meta.name.length > 80) throw new Error(filename + ': invalid name')
  if (typeof meta.version !== 'string' || !versionPattern.test(meta.version)) throw new Error(filename + ': invalid version')
  if (typeof meta.description !== 'string' || meta.description.length > 300) throw new Error(filename + ': invalid description')
  if (typeof meta.schedule !== 'string' || meta.schedule.trim().split(/\s+/).length !== 6) {
    throw new Error(filename + ': schedule must be a six-field cron expression')
  }
  if (typeof meta.enabled !== 'boolean') throw new Error(filename + ': enabled must be boolean')
  if (!Number.isInteger(meta.timeout) || meta.timeout < 1 || meta.timeout > 3600) {
    throw new Error(filename + ': timeout must be an integer from 1 to 3600 seconds')
  }
  if (meta.reliability !== 'best_effort' && meta.reliability !== 'reliable') {
    throw new Error(filename + ': reliability must be best_effort or reliable')
  }
  try {
    const next = new Cron(meta.schedule, { timezone: 'Asia/Shanghai', paused: true }).nextRun(new Date())
    if (!next) throw new Error('no next occurrence')
    const after = new Cron(meta.schedule, { timezone: 'Asia/Shanghai', paused: true }).nextRun(new Date(next.getTime() + 1000))
    if (after && after.getTime() - next.getTime() < 60_000) throw new Error('minimum interval is 60 seconds')
  } catch (error) {
    throw new Error(filename + ': invalid schedule: ' + error.message)
  }
  return meta
}

function compareVersion(a, b) {
  const [aCore, aPre] = a.split('-', 2)
  const [bCore, bPre] = b.split('-', 2)
  const av = aCore.split('.').map(Number)
  const bv = bCore.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if (av[i] !== bv[i]) return av[i] - bv[i]
  }
  if (aPre === undefined && bPre !== undefined) return 1
  if (aPre !== undefined && bPre === undefined) return -1
  return (aPre ?? '').localeCompare(bPre ?? '')
}

await rm(outputRoot, { recursive: true, force: true })
await mkdir(outputRoot, { recursive: true })
const directories = await readdir(sourceRoot, { withFileTypes: true })
const ids = new Set()
const versions = []

for (const directory of directories.filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
  if (!idPattern.test(directory.name)) throw new Error('invalid Agent script directory: ' + directory.name)
  const scriptFiles = (await readdir(join(sourceRoot, directory.name), { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.mjs'))
    .sort((a, b) => a.name.localeCompare(b.name))

  for (const entry of scriptFiles) {
    const filename = join(sourceRoot, directory.name, entry.name)
    const source = await readFile(filename, 'utf8')
    if (Buffer.byteLength(source, 'utf8') > 512 * 1024) throw new Error(filename + ': script exceeds 512 KiB')
    const meta = parseMetadata(source, filename)
    if (meta.id !== directory.name || basename(entry.name, '.mjs') !== meta.version) {
      throw new Error(filename + ': path must be <id>/<version>.mjs and match metadata')
    }
    const key = meta.id + '\u0000' + meta.version
    if (ids.has(key)) throw new Error('duplicate script version: ' + meta.id + '@' + meta.version)
    ids.add(key)
    const sha256 = createHash('sha256').update(source, 'utf8').digest('hex')
    const contentPath = '/agent-scripts/' + meta.id + '/' + meta.version + '.mjs'
    const outputPath = resolve(outputRoot, meta.id, meta.version + '.mjs')
    if (!outputPath.startsWith(outputRoot + '/')) throw new Error('unsafe output path for ' + meta.id)
    await mkdir(join(outputRoot, meta.id), { recursive: true })
    await writeFile(outputPath, source, 'utf8')
    versions.push({ ...meta, sha256, contentPath })
  }
}

versions.sort((a, b) => a.id.localeCompare(b.id) || compareVersion(a.version, b.version))
const latest = new Map()
for (const script of versions) {
  const current = latest.get(script.id)
  if (!current || compareVersion(script.version, current.version) > 0) latest.set(script.id, script)
}
const scripts = [...latest.values()].sort((a, b) => a.id.localeCompare(b.id))
await writeFile(
  join(outputRoot, 'manifest.json'),
  JSON.stringify({ schemaVersion: 1, scripts, versions }, null, 2) + '\n',
  'utf8',
)
console.log('built Agent script manifest: ' + scripts.length + ' active scripts, ' + versions.length + ' retained versions')
