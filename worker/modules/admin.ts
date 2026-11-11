/** 系统管理：Dashboard 汇总 / 节点状态 / 参数诊断 / 会话轮换 */

import { Hono } from 'hono'
import type { Context } from 'hono'
import { fail, ok, type Env } from '../core/envelope'
import { changePassword, revocationBaseline } from '../core/auth'
import {
  getClaimByName,
  getRegisteredNode,
  isValidNodeName,
  listRegisteredNodes,
  MAX_NODE_NAME_LEN,
  randomNodeKey,
  unregisterNode,
  upsertClaim,
} from '../core/nodekey'
import { buildInstall, requestOrigin } from '../core/install'
import { findField, getConfigs, listConfig, resetConfig, setConfig, validateConfig } from '../core/config'

const ONLINE_MS = 30 * 60_000 // 3× poll 间隔容错（v4.6）

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
      node_key: r.node_key,
      created_at: r.created_at,
      updated_at: r.updated_at,
      agent_version: st?.agent_version ?? '',
      last_seen_at: st?.last_seen_at ?? null,
      online: !!st && now - st.last_seen_at < ONLINE_MS,
      heldJobs: heldMap.get(r.node_id) ?? 0,
    }
  })
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
          `SELECT id, title, remind_at AS remindAt, repeat FROM reminder
           WHERE enabled = 1 ORDER BY remind_at LIMIT 4`,
        )
        .all(),
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
    reminders: { due: reminderDue?.n ?? 0, upcoming: upcoming.results ?? [] },
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
      `SELECT r.job_id, r.ok, r.message, r.ms, r.run_at, r.node_id, r.agent_version
       FROM job_run r WHERE r.run_at > ? ORDER BY r.run_at DESC LIMIT 50`,
    )
      .bind(now - 7 * 86400_000)
      .all(),
  ])
  return ok({ nodes, recentRuns: runs.results ?? [] })
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

// ---------- 节点登记（D1 node_registry / node_claim，v4.12：后台生成密钥 + 一键安装） ----------

/**
 * 添加节点：只写 10 分钟待认领凭据（列表不显示），agent 首次 poll 时才写入 node_registry。
 * 页面拿到 nodeId 后轮询 /nodes，看到记录即为安装成功；同名重发 = 刷新安装命令。
 */
admin.post('/nodes', async (c) => {
  const body = await readBody<{ name?: string }>(c)
  const nodeId = String(body.name ?? '').trim()
  if (!isValidNodeName(nodeId)) {
    return fail(400, 400, `节点名称需 1~${MAX_NODE_NAME_LEN} 位字母/数字/汉字，或 . _ -`)
  }

  try {
    if (await getRegisteredNode(c.env, nodeId)) {
      return fail(409, 409, '节点名称已存在：用该行「安装命令」重装，或先注销再添加')
    }
    const nodeKey = randomNodeKey()
    const expiresAt = await upsertClaim(c.env, nodeId, nodeKey)
    return ok({
      nodeId,
      nodes: await nodesPayload(c.env),
      install: buildInstall(requestOrigin(c), { node_id: nodeId, node_key: nodeKey }, {
        pending: true,
        expiresAt,
      }),
    })
  } catch (err) {
    console.error('create node claim failed:', String(err))
    return fail(500, 500, 'node_claim 表不存在：先跑 wrangler d1 migrations apply')
  }
})

/** 安装命令：已登记节点可随时重新取回（长期有效）；待认领节点返回剩余 10 分钟内的命令 */
admin.get('/nodes/:name/install', async (c) => {
  const nodeId = c.req.param('name')
  try {
    const registered = await getRegisteredNode(c.env, nodeId)
    if (registered) {
      return ok({
        install: buildInstall(requestOrigin(c), registered, { pending: false, expiresAt: null }),
      })
    }
    const claim = await getClaimByName(c.env, nodeId)
    if (claim) {
      return ok({
        install: buildInstall(requestOrigin(c), claim, { pending: true, expiresAt: claim.expires_at }),
      })
    }
    return fail(404, 404, '节点不存在（安装命令可能已过期，请重新添加同名节点）')
  } catch (err) {
    console.error('build install command failed:', String(err))
    return fail(500, 500, 'node_registry / node_claim 表不存在：先跑 wrangler d1 migrations apply')
  }
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
