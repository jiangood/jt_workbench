#!/usr/bin/env node
/**
 * Read-only online health check for jt-workbench.
 * - Reads wb_token from online-token.txt (or --token / --token-file)
 * - Fetches admin summary/jobs/nodes from production (read-only)
 * - Prints a concise status report with focus on ZSXQ jobs
 *
 * Usage:
 *   node scripts/x-online-check.mjs
 *   node scripts/x-online-check.mjs --token-file online-token.txt
 *   node scripts/x-online-check.mjs --token <wb_token>
 *   node scripts/x-online-check.mjs --base https://jt.410518072.xyz
 */

import fs from 'node:fs/promises'
import path from 'node:path'

const DEFAULT_BASE = 'https://jt.410518072.xyz'
const ZSXQ_TYPES = new Set(['zsxq_sync', 'zsxq_backfill', 'zsxq_comments', 'zsxq_probe', 'zsxq_groups'])

function parseArgs(argv) {
  const out = { base: DEFAULT_BASE, token: null, tokenFile: 'online-token.txt', json: false }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--base') out.base = argv[++i] ?? out.base
    else if (a === '--token') out.token = argv[++i] ?? null
    else if (a === '--token-file') out.tokenFile = argv[++i] ?? out.tokenFile
    else if (a === '--json') out.json = true
    else if (a === '--help' || a === '-h') out.help = true
  }
  return out
}

async function readToken(tokenFile) {
  const p = path.resolve(process.cwd(), tokenFile)
  const text = await fs.readFile(p, 'utf8')
  const m = text.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/)
  if (!m) throw new Error(`No JWT-like token found in ${p}`)
  return m[0]
}

async function api(base, pathname, token) {
  const url = new URL(pathname, base).toString()
  const res = await fetch(url, {
    method: 'GET',
    headers: { Cookie: `wb_token=${token}` },
  })
  const text = await res.text()
  let body
  try { body = text ? JSON.parse(text) : null } catch { body = { raw: text } }
  if (!res.ok) {
    const msg = body?.message || body?.error || text || res.statusText
    throw new Error(`${res.status} ${msg} (${pathname})`)
  }
  if (body && typeof body === 'object' && 'code' in body && body.code !== 0) {
    throw new Error(`api code=${body.code} message=${body.message ?? ''} (${pathname})`)
  }
  return body?.data ?? body
}

function fmtTs(ts) {
  if (!ts) return '—'
  try { return new Date(ts).toLocaleString('zh-CN', { hour12: false }) } catch { return String(ts) }
}

function ago(ts) {
  if (!ts) return ''
  const d = Date.now() - ts
  const abs = Math.abs(d)
  const min = Math.round(abs / 60000)
  const label = min < 60 ? `${min}m` : min < 1440 ? `${Math.round(min / 60)}h` : `${Math.round(min / 1440)}d`
  return d >= 0 ? `${label} ago` : `in ${label}`
}

function jobFlags(j) {
  const flags = []
  if (!j.enabled) flags.push('disabled')
  if (j.status === 'leased' && j.nextRunAt && j.nextRunAt < Date.now() - 60_000) flags.push('OVERDUE+leased')
  if (j.lastOk === false) flags.push('last-failed')
  if (typeof j.result === 'string' && /unknown type|error|fail|timeout/i.test(j.result)) flags.push('result-warning')
  return flags
}

function printJobs(jobs) {
  const list = Array.isArray(jobs?.jobs) ? jobs.jobs : Array.isArray(jobs) ? jobs : []
  const zsxq = list.filter(j => ZSXQ_TYPES.has(j.type))
  const abnormal = list.filter(j => jobFlags(j).length > 0 || ZSXQ_TYPES.has(j.type))

  console.log('\n== ZSXQ Jobs ==')
  if (!zsxq.length) console.log('(none)')
  for (const j of zsxq) {
    const flags = jobFlags(j)
    console.log(`- #${j.id} ${j.typeLabel || j.type} [${j.type}] status=${j.status} enabled=${j.enabled} cron=${j.cron ?? '—'}`)
    console.log(`  target=${j.sourceName ?? JSON.stringify(j.payload ?? {})} node=${j.nodeId ?? '—'} last=${fmtTs(j.lastRunAt)} (${ago(j.lastRunAt)}) next=${fmtTs(j.nextRunAt)} (${ago(j.nextRunAt)}) ok=${j.lastOk}`)
    console.log(`  result=${String(j.result ?? '').slice(0, 180)}`)
    if (flags.length) console.log(`  flags: ${flags.join(', ')}`)
  }

  console.log('\n== Other flagged jobs ==')
  const others = abnormal.filter(j => !ZSXQ_TYPES.has(j.type))
  if (!others.length) console.log('(none)')
  for (const j of others) {
    const flags = jobFlags(j)
    console.log(`- #${j.id} ${j.typeLabel || j.type} [${j.type}] status=${j.status} enabled=${j.enabled} node=${j.nodeId ?? '—'} ok=${j.lastOk}`)
    console.log(`  last=${fmtTs(j.lastRunAt)} (${ago(j.lastRunAt)}) next=${fmtTs(j.nextRunAt)} (${ago(j.nextRunAt)}) flags=${flags.join(',') || '—'}`)
    console.log(`  result=${String(j.result ?? '').slice(0, 160)}`)
  }
  return { total: list.length, zsxq: zsxq.length, flagged: abnormal.length }
}

function printNodes(nodesData) {
  const list = Array.isArray(nodesData?.nodes) ? nodesData.nodes : Array.isArray(nodesData) ? nodesData : []
  console.log('\n== Nodes ==')
  if (!list.length) console.log('(none)')
  for (const n of list) {
    const id = n.node_id ?? n.id ?? n.name ?? '?'
    const ver = n.agent_version ?? n.version ?? '—'
    const online = n.online ?? n.status ?? '—'
    const hb = n.last_seen_at ?? n.lastHeartbeatAt ?? n.last_seen
    const held = n.heldJobs ?? n.held_jobs ?? n.tasks ?? '—'
    const out = n.outdated ? ' outdated' : ''
    console.log(`- ${id}: online=${online} agent=${ver}${out} held=${held} heartbeat=${fmtTs(hb)} (${ago(hb)})`)
  }
  return { total: list.length }
}

async function main() {
  const args = parseArgs(process.argv)
  if (args.help) {
    console.log('Usage: node scripts/x-online-check.mjs [--base URL] [--token TOKEN | --token-file PATH] [--json]')
    process.exit(0)
  }
  const token = args.token || await readToken(args.tokenFile)
  const base = args.base.replace(/\/+$/, '')
  const checkedAt = new Date().toISOString()
  console.log(`== Online check (read-only) ==\nbase=${base}\ncheckedAt=${checkedAt}`)

  const [summaryRes, jobsRes, nodesRes] = await Promise.allSettled([
    api(base, '/api/admin/summary', token),
    api(base, '/api/admin/jobs', token),
    api(base, '/api/admin/nodes', token),
  ])

  const report = { base, checkedAt, summary: null, jobs: null, nodes: null, errors: {} }

  if (summaryRes.status === 'fulfilled') {
    report.summary = summaryRes.value
    const s = summaryRes.value || {}
    console.log('\n== Summary ==')
    if (s.cards) console.log(`cards: ${JSON.stringify(s.cards)}`)
    if (s.zsxq) console.log(`zsxq: total=${s.zsxq.total} deleted=${s.zsxq.deleted} enabled=${s.zsxq.enabled} hasToken=${s.zsxq.hasToken}`)
    if (s.nodes) console.log(`nodes: ${Array.isArray(s.nodes) ? s.nodes.map(n=>`${n.node_id}:${n.agent_version}${n.online?'':'(offline)'}`).join(', ') : JSON.stringify(s.nodes)}`)
  } else {
    report.errors.summary = summaryRes.reason?.message || String(summaryRes.reason)
    console.log(`\n== Summary ==\nERROR: ${report.errors.summary}`)
  }

  if (jobsRes.status === 'fulfilled') {
    report.jobs = printJobs(jobsRes.value)
  } else {
    report.errors.jobs = jobsRes.reason?.message || String(jobsRes.reason)
    console.log(`\n== Jobs ==\nERROR: ${report.errors.jobs}`)
  }

  if (nodesRes.status === 'fulfilled') {
    report.nodes = printNodes(nodesRes.value)
  } else {
    report.errors.nodes = nodesRes.reason?.message || String(nodesRes.reason)
    console.log(`\n== Nodes ==\nERROR: ${report.errors.nodes}`)
  }

  if (args.json) {
    console.log('\n== JSON ==')
    console.log(JSON.stringify(report, null, 2))
  }

  if (report.errors.summary || report.errors.jobs || report.errors.nodes) process.exitCode = 2
}

main().catch(err => {
  console.error(`ERROR: ${err?.message || err}`)
  process.exit(1)
})
