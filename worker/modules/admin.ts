/** 系统管理：Dashboard 汇总 / 节点状态 / 参数诊断 / 会话轮换 */

import { Hono } from 'hono'
import type { Context } from 'hono'
import { fail, ok, type Env } from '../core/envelope'
import { changePassword, revocationBaseline } from '../core/auth'
import {
  addNode,
  getRegisteredNode,
  isValidNodeName,
  listRegisteredNodes,
  MAX_NODE_NAME_LEN,
  randomNodeKey,
  rotateNodeKey,
  unregisterNode,
} from '../core/nodekey'
import { buildInstall, requestOrigin } from '../core/install'
import { sendMail } from '../core/mail'
import { lunarLabel } from '../core/lunar'
import { parseOffsets } from '../core/recurrence'
import { findField, getConfigs, listConfig, resetConfig, setConfig, validateConfig } from '../core/config'

const ONLINE_MS = 30 * 60_000 // 3× poll 间隔容错（v4.6）
const EXPORT_WINDOW_MS = 7 * 86400_000 // 与「任务运行」页一致：最近 7 天
const EXPORT_LIMIT = 300 // 失败记录上限（防止一次导出过大）

const SECRET_FIELD = /token|secret|passw|api[-_]?key|authorization|cookie/i

/** payload 脱敏：导出文件可能被拿去给 AI 分析，密钥类字段一律打码 */
function redactPayload(raw: string | null): unknown {
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return raw
  }
  const walk = (value: unknown, depth = 0): unknown => {
    if (depth > 5 || value === null || typeof value !== 'object') return value
    if (Array.isArray(value)) return value.map((item) => walk(item, depth + 1))
    const out: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_FIELD.test(key) ? '***' : walk(val, depth + 1)
    }
    return out
  }
  return walk(parsed)
}

async function readBody<T>(c: Context<Env>): Promise<T> {
  try {
    return await c.req.json<T>()
  } catch {
    return {} as T
  }
}

/** 节点列表：登记表为主（已登记但从未 poll 也显示），心跳/版本/在持任务为辅 */
async function nodesPayload(env: Env['Bindings']) {
  const db = env.DB
  const now = Date.now()
  const [registered, states, held] = await Promise.all([
    listRegisteredNodes(env),
    db.prepare('SELECT node_id, agent_version, last_seen_at FROM node_state').all<{
      node_id: string
      agent_version: string
      last_seen_at: number
    }>(),
    db
      .prepare(`SELECT node_id, count(*) AS n FROM job WHERE status = 'leased' GROUP BY node_id`)
      .all<{ node_id: string; n: number }>(),
  ])
  const stateMap = new Map((states.results ?? []).map((r) => [r.node_id, r]))
  const heldMap = new Map((held.results ?? []).map((r) => [r.node_id, r.n]))

  return registered.map((r) => {
    const st = stateMap.get(r.node_id)
    return {
      node_id: r.node_id,
      created_at: r.created_at,
      updated_at: r.updated_at,
      agent_version: st?.agent_version ?? '',
      last_seen_at: st?.last_seen_at ?? null,
      online: !!st && now - st.last_seen_at < ONLINE_MS,
      heldJobs: heldMap.get(r.node_id) ?? 0,
    }
  })
}

/** 任务类型 → 可读名称：运行列表只显示 #id 不便于追踪，未知类型回落原始 type */
const JOB_TYPE_LABEL: Record<string, string> = {
  rss_fetch: '资讯抓取',
  stock_eod: '收盘行情',
  zsxq_sync: '星球同步',
  zsxq_groups: '星球列表',
}

function jobDisplayName(jobId: number, type: string | null, sourceName: string | null): string {
  const label = (type && JOB_TYPE_LABEL[type]) || type || `任务 #${jobId}`
  // RSS 任务按源一行，带上源名才能区分同类型的多个任务
  return sourceName ? `${label} · ${sourceName}` : label
}

export const admin = new Hono<Env>()

/** Dashboard 汇总：各模块计数 + 首页卡片数据 + 节点在线态 */
admin.get('/summary', async (c) => {
  const db = c.env.DB
  const now = Date.now()
  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)

  const [newsToday, newsUnread, reminderDue, counts, nodes, heldJobs, cfg, newsLatest, upcoming, notes, zsxqLatest, watch] =
    await Promise.all([
      db.prepare('SELECT count(*) AS n FROM news_item WHERE fetched_at >= ?').bind(todayStart.getTime()).first<{ n: number }>(),
      db.prepare('SELECT count(*) AS n FROM news_item WHERE read_flag = 0').first<{ n: number }>(),
      db.prepare('SELECT count(*) AS n FROM reminder WHERE enabled = 1 AND remind_at <= ?').bind(now).first<{ n: number }>(),
      db.batch([
        db.prepare('SELECT count(*) AS n FROM stock_watch WHERE enabled = 1'),
        db.prepare('SELECT count(*) AS n FROM music'),
        db.prepare('SELECT count(*) AS n FROM book'),
        db.prepare('SELECT count(*) AS n FROM note'),
        db.prepare('SELECT count(*) AS n FROM zsxq_topic'),
        db.prepare('SELECT count(*) AS n FROM zsxq_group WHERE enabled = 1'),
      ]),
      db.prepare('SELECT node_id, agent_version, last_seen_at FROM node_state').all(),
      db.prepare(`SELECT node_id, count(*) AS n FROM job WHERE status = 'leased' GROUP BY node_id`).all(),
      getConfigs(c.env, ['agent_latest_version', 'zsxq_token']),
      // 首页卡片：只取需要的列与条数，避免把整页列表塞进汇总响应
      db
        .prepare(
          `SELECT i.id, i.title, i.link, i.published_at AS publishedAt, i.read_flag AS readFlag,
                  i.fetched_at AS fetchedAt, s.name AS sourceName
           FROM news_item i LEFT JOIN news_source s ON s.id = i.source_id
           ORDER BY i.published_at DESC, i.id DESC LIMIT 8`,
        )
        .all(),
      db
        .prepare(
          `SELECT id, title, calendar_type AS calendarType, lunar_month AS lunarMonth,
                  lunar_day AS lunarDay, lunar_leap AS lunarLeap, anchor_at AS anchorAt,
                  event_at AS eventAt, remind_at AS remindAt, remind_offsets AS remindOffsets, repeat
           FROM reminder WHERE enabled = 1
           ORDER BY COALESCE(event_at, remind_at) LIMIT 4`,
        )
        .all<Record<string, unknown>>(),
      db
        .prepare(
          `SELECT id, title, substr(content, 1, 90) AS preview, updated_at AS updatedAt
           FROM note ORDER BY updated_at DESC LIMIT 4`,
        )
        .all(),
      db
        .prepare(
          `SELECT title, substr(talk_text, 1, 120) AS preview, create_time AS createTime
           FROM zsxq_topic ORDER BY create_time DESC LIMIT 3`,
        )
        .all(),
      db
        .prepare('SELECT code, name FROM stock_watch WHERE enabled = 1 ORDER BY sort, code LIMIT 6')
        .all(),
    ])

  const held = Object.fromEntries((heldJobs.results ?? []).map((r: Record<string, unknown>) => [r.node_id, r.n]))
  const latest = cfg.agent_latest_version
  const card = (i: number) => (counts[i].results[0] as { n: number }).n
  const upcomingRows = (upcoming.results ?? []).map((row) => {
    const eventAt = (row.eventAt as number | null) ?? (row.remindAt as number)
    return {
      ...row,
      eventAt,
      anchorAt: (row.anchorAt as number | null) ?? eventAt,
      offsets: parseOffsets(row.remindOffsets),
      lunarLeap: !!row.lunarLeap,
      lunarText:
        row.calendarType === 'lunar' && row.lunarMonth && row.lunarDay
          ? lunarLabel(Number(row.lunarMonth), Number(row.lunarDay), !!row.lunarLeap)
          : null,
    }
  })

  return ok({
    cards: {
      newsToday: newsToday?.n ?? 0,
      reminderDue: reminderDue?.n ?? 0,
      stockWatch: card(0),
      music: card(1),
      book: card(2),
      note: card(3),
    },
    news: { today: newsToday?.n ?? 0, unread: newsUnread?.n ?? 0, latest: newsLatest.results ?? [] },
    reminders: { due: reminderDue?.n ?? 0, upcoming: upcomingRows },
    stocks: { watch: watch.results ?? [] },
    notes: { total: card(3), latest: notes.results ?? [] },
    library: { music: card(1), book: card(2) },
    zsxq: {
      total: card(4),
      enabled: card(5) > 0,
      hasToken: !!cfg.zsxq_token,
      latest: zsxqLatest.results ?? [],
    },
    nodes: (nodes.results ?? []).map((n: Record<string, unknown>) => ({
      ...n,
      online: now - (n.last_seen_at as number) < ONLINE_MS,
      heldJobs: held[n.node_id as string] ?? 0,
      outdated: latest ? n.agent_version !== latest : false,
    })),
  })
})

/** 节点状态页：登记表 + node_state + 最近 job_run（版本漂移可见，v4.12） */
admin.get('/nodes', async (c) => {
  const now = Date.now()
  const [nodes, runs] = await Promise.all([
    nodesPayload(c.env),
    c.env.DB.prepare(
      `SELECT r.job_id, r.ok, r.message, r.ms, r.run_at, r.node_id, r.agent_version,
              j.type AS job_type, s.name AS source_name
       FROM job_run r
       LEFT JOIN job j ON j.id = r.job_id
       LEFT JOIN news_source s
         ON j.type = 'rss_fetch'
        AND s.id = json_extract(CASE WHEN json_valid(j.payload) THEN j.payload ELSE '{}' END, '$.sourceId')
       WHERE r.run_at > ? ORDER BY r.run_at DESC LIMIT 50`,
    )
      .bind(now - 7 * 86400_000)
      .all<{
        job_id: number
        ok: number
        message: string | null
        ms: number | null
        run_at: number
        node_id: string | null
        agent_version: string | null
        job_type: string | null
        source_name: string | null
      }>(),
  ])
  return ok({
    nodes,
    recentRuns: (runs.results ?? []).map((r) => ({
      ...r,
      job_name: jobDisplayName(r.job_id, r.job_type, r.source_name),
    })),
  })
})

/**
 * 任务失败导出（「任务运行」页按钮）：最近 7 天失败记录 + 对应任务当前配置。
 * 只读、仅管理员；payload 里 token/密钥字段脱敏后返回，前端拼成 Markdown 下载。
 */
admin.get('/runs/export', async (c) => {
  const now = Date.now()
  const since = now - EXPORT_WINDOW_MS
  const [runs, jobs] = await Promise.all([
    c.env.DB.prepare(
      `SELECT job_id, message, ms, run_at, node_id, agent_version
       FROM job_run WHERE ok = 0 AND run_at > ? ORDER BY run_at DESC LIMIT ${EXPORT_LIMIT}`,
    )
      .bind(since)
      .all<{
        job_id: number
        message: string | null
        ms: number | null
        run_at: number
        node_id: string | null
        agent_version: string | null
      }>(),
    c.env.DB.prepare(
      `SELECT id, type, payload, cron, enabled, status, attempts, next_run_at, last_run_at
       FROM job WHERE id IN (SELECT job_id FROM job_run WHERE ok = 0 AND run_at > ?)`,
    )
      .bind(since)
      .all<{
        id: number
        type: string
        payload: string | null
        cron: string | null
        enabled: number
        status: string
        attempts: number
        next_run_at: number | null
        last_run_at: number | null
      }>(),
  ])

  const failures = runs.results ?? []
  return ok({
    exportedAt: now,
    windowFrom: since,
    limit: EXPORT_LIMIT,
    truncated: failures.length === EXPORT_LIMIT,
    failures,
    jobs: (jobs.results ?? []).map((job) => ({ ...job, payload: redactPayload(job.payload) })),
  })
})

/** 参数中心（D1 app_config，决策 #23）：列表 / 保存 / 随机重置；明文只给已登录管理员 */
admin.get('/config', async (c) => ok({ fields: await listConfig(c.env) }))

admin.post('/config', async (c) => {
  const body = await readBody<{ key?: string; value?: string }>(c)
  const field = findField(String(body.key ?? ''))
  if (!field) return fail(400, 400, 'unknown config key')
  const value = String(body.value ?? '')
  const err = validateConfig(field, value)
  if (err) return fail(400, 400, err)
  return ok(await setConfig(c.env, field.key, value))
})

admin.post('/config/:key/rotate', async (c) => {
  const field = findField(c.req.param('key'))
  if (!field?.generate) return fail(400, 400, 'not rotatable')
  return ok(await resetConfig(c.env, field.key))
})

/** 发一封测试邮件（只读参数 + 一次出站连接）：后台改完账号授权码可立即验证 */
admin.post('/mail/test', async (c) => {
  try {
    await sendMail(c.env, {
      subject: '【个人工作台】测试邮件',
      html: '<p>收到这封邮件，说明邮件提醒配置已生效。</p>',
    })
  } catch (err) {
    return fail(400, 400, err instanceof Error ? err.message : String(err))
  }
  return ok({ sent: true })
})

/** 后台改密：校验旧密码 → 写 D1 → 撤销全部旧会话（前端跳回登录页） */
admin.post('/password', changePassword)

/** 手动撤销全部登录会话（不动密码） */
admin.post('/rotate-session', async (c) => {
  await c.env.DB
    .prepare('UPDATE auth_state SET password_changed_at = ? WHERE id = 1')
    .bind(revocationBaseline())
    .run()
  return ok({ rotated: true })
})

// ---------- 节点登记（D1 node_registry，v4.13：后台生成密钥 + 一键接入） ----------

/**
 * 添加节点：直接写入 node_registry（列表立刻出现一条离线记录），接入命令长期有效。
 * 现场环境不一定能马上接入，所以不再有 20 分钟「待认领」窗口；接入方式可随时从该行取回。
 */
admin.post('/nodes', async (c) => {
  const body = await readBody<{ name?: string }>(c)
  const nodeId = String(body.name ?? '').trim()
  if (!isValidNodeName(nodeId)) {
    return fail(400, 400, `节点名称需 1~${MAX_NODE_NAME_LEN} 位字母/数字/汉字，或 . _ -`)
  }

  try {
    const nodeKey = randomNodeKey()
    if (!(await addNode(c.env, nodeId, nodeKey))) {
      return fail(409, 409, '节点名称已存在：用该行「查看接入方式」重新部署，或先注销再添加')
    }
    return ok({
      nodeId,
      nodes: await nodesPayload(c.env),
      install: buildInstall(requestOrigin(c), { node_id: nodeId, node_key: nodeKey }),
    })
  } catch (err) {
    console.error('register node failed:', String(err))
    return fail(500, 500, 'node_registry 表不存在：先跑 wrangler d1 migrations apply')
  }
})

/** 接入方式：只要节点仍登记着就长期可用（重置密钥会换掉 URL） */
admin.get('/nodes/:name/install', async (c) => {
  const nodeId = c.req.param('name')
  try {
    const registered = await getRegisteredNode(c.env, nodeId)
    if (!registered) return fail(404, 404, '节点不存在（可能已注销，请重新添加）')
    return ok({ install: buildInstall(requestOrigin(c), registered) })
  } catch (err) {
    console.error('build install command failed:', String(err))
    return fail(500, 500, 'node_registry 表不存在：先跑 wrangler d1 migrations apply')
  }
})

/** 重置节点密钥：旧密钥立即失效；列表不返回密钥，新值只能经「接入方式」弹窗取回 */
admin.post('/nodes/:name/rotate-key', async (c) => {
  const nodeId = c.req.param('name')
  try {
    const nodeKey = await rotateNodeKey(c.env, nodeId)
    if (!nodeKey) return fail(404, 404, '节点不存在（可能已注销）')
  } catch (err) {
    console.error('rotate node key failed:', String(err))
    return fail(500, 500, 'node_registry 表不存在：先跑 wrangler d1 migrations apply')
  }
  return ok({ rotated: nodeId, nodes: await nodesPayload(c.env) })
})

/** 注销节点：删除登记与心跳行（任务历史保留）；agent 仍在线会一直 401 直到重新登记 */
admin.delete('/nodes/:name', async (c) => {
  const nodeId = c.req.param('name')
  try {
    await unregisterNode(c.env, nodeId)
  } catch (err) {
    console.error('unregister node failed:', String(err))
    return fail(500, 500, 'node_registry 表不存在：先跑 wrangler d1 migrations apply')
  }
  return ok({ removed: nodeId, nodes: await nodesPayload(c.env) })
})
