/** 系统管理：Dashboard 汇总 / 节点状态 / 参数诊断 / 会话轮换 */

import { Hono } from 'hono'
import { ok, type Env } from '../core/envelope'
import { changePassword, readCredential, revocationBaseline } from '../core/auth'

const ONLINE_MS = 30 * 60_000 // 3× poll 间隔容错（v4.6）

export const admin = new Hono<Env>()

/** Dashboard 汇总：各模块计数 + 节点在线态 */
admin.get('/summary', async (c) => {
  const db = c.env.DB
  const now = Date.now()
  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)

  const [newsToday, reminderDue, counts, nodes, heldJobs] = await Promise.all([
    db.prepare('SELECT count(*) AS n FROM news_item WHERE fetched_at >= ?').bind(todayStart.getTime()).first<{ n: number }>(),
    db.prepare('SELECT count(*) AS n FROM reminder WHERE enabled = 1 AND remind_at <= ?').bind(now).first<{ n: number }>(),
    db.batch([
      db.prepare('SELECT count(*) AS n FROM stock_watch WHERE enabled = 1'),
      db.prepare('SELECT count(*) AS n FROM music'),
      db.prepare('SELECT count(*) AS n FROM book'),
      db.prepare('SELECT count(*) AS n FROM note'),
    ]),
    db.prepare('SELECT node_id, agent_version, last_seen_at FROM node_state').all(),
    db.prepare(`SELECT node_id, count(*) AS n FROM job WHERE status = 'leased' GROUP BY node_id`).all(),
  ])

  const held = Object.fromEntries((heldJobs.results ?? []).map((r: Record<string, unknown>) => [r.node_id, r.n]))
  const latest = c.env.AGENT_LATEST_VERSION

  return ok({
    cards: {
      newsToday: newsToday?.n ?? 0,
      reminderDue: reminderDue?.n ?? 0,
      stockWatch: (counts[0].results[0] as { n: number }).n,
      music: (counts[1].results[0] as { n: number }).n,
      book: (counts[2].results[0] as { n: number }).n,
      note: (counts[3].results[0] as { n: number }).n,
    },
    nodes: (nodes.results ?? []).map((n: Record<string, unknown>) => ({
      ...n,
      online: now - (n.last_seen_at as number) < ONLINE_MS,
      heldJobs: held[n.node_id as string] ?? 0,
      outdated: latest ? n.agent_version !== latest : false,
    })),
  })
})

/** 节点状态页：node_state + 最近 job_run（版本漂移可见） */
admin.get('/nodes', async (c) => {
  const db = c.env.DB
  const now = Date.now()
  const [nodes, runs] = await Promise.all([
    db.prepare('SELECT node_id, agent_version, last_seen_at FROM node_state ORDER BY node_id').all(),
    db.prepare(
      `SELECT r.job_id, r.ok, r.message, r.ms, r.run_at, r.node_id, r.agent_version
       FROM job_run r WHERE r.run_at > ? ORDER BY r.run_at DESC LIMIT 50`,
    ).bind(now - 7 * 86400_000).all(),
  ])
  return ok({
    nodes: (nodes.results ?? []).map((n: Record<string, unknown>) => ({
      ...n,
      online: now - (n.last_seen_at as number) < ONLINE_MS,
    })),
    recentRuns: runs.results ?? [],
  })
})

/** 参数诊断（只读；token 类只显示是否已配置） */
admin.get('/params', async (c) => {
  const cred = await readCredential(c.env)
  const pwdInDb = !!cred?.pwd_hash
  return ok({
    params: [
      { key: 'NODE_KEY', label: '节点密钥', configured: !!c.env.NODE_KEY, where: 'worker secret' },
      { key: 'JWT_SECRET', label: 'JWT 密钥', configured: !!c.env.JWT_SECRET, where: 'worker secret' },
      {
        key: 'ADMIN_PWD',
        label: '管理员密码',
        configured: pwdInDb || !!c.env.ADMIN_PWD_HASH,
        where: pwdInDb ? 'D1 auth_state（后台可改）' : 'wrangler secret 引导（首次登录后转入 D1）',
      },
      { key: 'RESEND_API_KEY', label: 'Resend 发信', configured: !!c.env.RESEND_API_KEY, where: 'worker secret' },
      { key: 'REMINDER_FROM', label: '提醒发件人', configured: !!c.env.REMINDER_FROM, value: c.env.REMINDER_FROM, where: 'worker secret/var' },
      { key: 'AGENT_LATEST_VERSION', label: 'agent 最新版本（版本落后黄条）', configured: !!c.env.AGENT_LATEST_VERSION, value: c.env.AGENT_LATEST_VERSION, where: 'worker var' },
      { key: 'ZSXQ_TOKEN', label: '知识星球 token', configured: false, where: 'agent env（宿主机 compose）' },
    ],
  })
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
