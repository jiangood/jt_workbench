import { createHash } from 'node:crypto'
import { readdir, readFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
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
  if (!match) throw new Error(\`${filename}: missing @script metadata block\`)
  const json = match[1]
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\*\s?/, ''))
    .join('\n')
    .trim()
  let meta
  try { meta = JSON.parse(json) } catch (error) {
    throw new Error(\`${filename}: invalid metadata JSON: ${error.message}\`)
  }
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    throw new Error(\`${filename}: metadata must be an object\`)
  }
  for (const key of Object.keys(meta)) {
    if (!allowedKeys.has(key)) throw new Error(\`${filename}: unsupported metadata field ${key}\`)
  }
  for (const key of allowedKeys) {
    if (!(key in meta)) throw new Error(\`${filename}: missing metadata field ${key}\`)
  }
  if (typeof meta.id !== 'string' || !idPattern.test(meta.id)) throw new Error(\`${filename}: invalid id\`)
  if (typeof meta.name !== 'string' || !meta.name.trim() || meta.name.length > 80) throw new Error(\`${filename}: invalid name\`)
  if (typeof meta.version !== 'string' || !versionPattern.test(meta.version)) throw new Error(\`${filename}: invalid version\`)
  if (typeof meta.description !== 'string' || meta.description.length > 300) throw new Error(\`${filename}: invalid description\`)
  if (typeof meta.schedule !== 'string' || meta.schedule.trim().split(/\s+/).length !== 6) {
    throw new Error(\`${filename}: schedule must be a six-field cron expression\`)
  }
  if (typeof meta.enabled !== 'boolean') throw new Error(\`${filename}: enabled must be boolean\`)
  if (!Number.isInteger(meta.timeout) || meta.timeout < 1 || meta.timeout > 3600) {
    throw new Error(\`${filename}: timeout must be an integer from 1 to 3600 seconds\`)
  }
  if (meta.reliability !== 'best_effort' && meta.reliability !== 'reliable') {
    throw new Error(\`${filename}: reliability must be best_effort or reliable\`)
  }
  let next
  try {
    next = new Cron(meta.schedule, { timezone: 'Asia/Shanghai', paused: true }).nextRun(new Date())
    if (!next) throw new Error('no next occurrence')
    const after = new Cron(meta.schedule, { timezone: 'Asia/Shanghai', paused: true }).nextRun(new Date(next.getTime() + 1000))
    if (after && after.getTime() - next.getTime() < 60_000) {
      throw new Error('minimum interval is 60 seconds')
    }
  } catch (error) {
    throw new Error(\`${filename}: invalid schedule: ${error.message}\`)
  }
  return meta
}

await rm(outputRoot, { recursive: true, force: true })
await mkdir(outputRoot, { recursive: true })
const entries = (await readdir(sourceRoot, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith('.mjs'))
  .sort((a, b) => a.name.localeCompare(b.name))

const ids = new Set()
const scripts = []
for (const entry of entries) {
  const filename = join(sourceRoot, entry.name)
  const source = await readFile(filename, 'utf8')
  if (Buffer.byteLength(source, 'utf8') > 512 * 1024) throw new Error(\`${entry.name}: script exceeds 512 KiB\`)
  const meta = parseMetadata(source, entry.name)
  if (ids.has(meta.id)) throw new Error(\`duplicate script id: ${meta.id}\`)
  ids.add(meta.id)
  const sha256 = createHash('sha256').update(source, 'utf8').digest('hex')
  const contentPath = \`/agent-scripts/${meta.id}/${meta.version}.mjs\`
  const outputPath = resolve(outputRoot, meta.id, \`${meta.version}.mjs\`)
  if (!outputPath.startsWith(outputRoot + '/')) throw new Error(\`unsafe output path for ${meta.id}\`)
  await mkdir(join(outputRoot, meta.id), { recursive: true })
  await writeFile(outputPath, source, 'utf8')
  scripts.push({ ...meta, sha256, contentPath })
}
scripts.sort((a, b) => a.id.localeCompare(b.id))
await writeFile(
  join(outputRoot, 'manifest.json'),
  JSON.stringify({ schemaVersion: 1, scripts }, null, 2) + '\n',
  'utf8',
)
console.log(\`built Agent script manifest: ${scripts.length} scripts\`)
