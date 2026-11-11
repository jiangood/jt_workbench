/**
 * 节点登记（决策 #22，v4.12）：后台生成密钥 → 10 分钟“待认领”凭据 → agent 首次 poll 自动入库
 *
 * - 点「添加节点」只写 node_claim（节点列表不显示），避免没装成也留一条离线记录
 * - agent 第一次带 x-node-key 访问：凭据有效 → 写入 node_registry（此时才算节点记录）+ 删除凭据
 * - 鉴权 = 用 x-node-key 反查 node_registry.node_id（等值查询走唯一索引）
 * - 注销节点 = 删除登记 + 心跳行；密钥立即失效
 */

import type { Bindings } from './envelope'

export const MAX_NODE_NAME_LEN = 32
/** 待认领凭据有效期：与安装命令的 10 分钟一致 */
export const CLAIM_TTL_MS = 10 * 60_000

export interface NodeRow {
  node_id: string
  node_key: string
  created_at: number
  updated_at: number
}

export interface NodeClaim {
  node_key: string
  node_id: string
  created_at: number
  expires_at: number
}

/** 节点名称：字母/数字/汉字 + . _ -，1~32 位（会直接出现在任务历史与页面里） */
export function isValidNodeName(value: string): boolean {
  return /^[\p{L}\p{N}._-]{1,32}$/u.test(value)
}

/** 16 字节随机 → 32 位 hex（复制 / YAML / 环境变量都无转义问题） */
export function randomNodeKey(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// ---------- 已登记节点（node_registry） ----------

export async function getRegisteredNode(env: Bindings, nodeId: string): Promise<NodeRow | null> {
  return env.DB
    .prepare('SELECT node_id, node_key, created_at, updated_at FROM node_registry WHERE node_id = ?')
    .bind(nodeId)
    .first<NodeRow>()
}

export async function getNodeByKey(env: Bindings, key: string): Promise<NodeRow | null> {
  return env.DB
    .prepare('SELECT node_id, node_key, created_at, updated_at FROM node_registry WHERE node_key = ?')
    .bind(key)
    .first<NodeRow>()
}

export async function listRegisteredNodes(env: Bindings): Promise<NodeRow[]> {
  const res = await env.DB
    .prepare('SELECT node_id, node_key, created_at, updated_at FROM node_registry ORDER BY node_id')
    .all<NodeRow>()
  return res.results ?? []
}

/** 注销：同时清掉心跳行与可能残留的待认领凭据；job_run 历史保留（node_id 只是文本） */
export async function unregisterNode(env: Bindings, nodeId: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM node_registry WHERE node_id = ?').bind(nodeId),
    env.DB.prepare('DELETE FROM node_state WHERE node_id = ?').bind(nodeId),
    env.DB.prepare('DELETE FROM node_claim WHERE node_id = ?').bind(nodeId),
  ])
}

// ---------- 待认领凭据（node_claim） ----------

export async function getClaimByName(env: Bindings, nodeId: string): Promise<NodeClaim | null> {
  return env.DB
    .prepare('SELECT node_key, node_id, created_at, expires_at FROM node_claim WHERE node_id = ? AND expires_at > ?')
    .bind(nodeId, Date.now())
    .first<NodeClaim>()
}

export async function getClaimByKey(env: Bindings, key: string): Promise<NodeClaim | null> {
  return env.DB
    .prepare('SELECT node_key, node_id, created_at, expires_at FROM node_claim WHERE node_key = ? AND expires_at > ?')
    .bind(key, Date.now())
    .first<NodeClaim>()
}

/** 登记待认领凭据：同名重发 = 换新密钥（旧安装命令立即失效）；顺带全局清理过期行 */
export async function upsertClaim(env: Bindings, nodeId: string, key: string): Promise<number> {
  const now = Date.now()
  const expiresAt = now + CLAIM_TTL_MS
  await env.DB.batch([
    env.DB.prepare('DELETE FROM node_claim WHERE expires_at <= ? OR node_id = ?').bind(now, nodeId),
    env.DB.prepare('INSERT INTO node_claim (node_key, node_id, created_at, expires_at) VALUES (?, ?, ?, ?)').bind(
      key,
      nodeId,
      now,
      expiresAt,
    ),
  ])
  return expiresAt
}

/**
 * 首次接触：凭据有效 → 写入 node_registry 并消费凭据。
 * 名称若已被别的密钥占用（极端竞态/手工操作），返回 null，调用方按 401 处理。
 */
export async function promoteClaim(env: Bindings, key: string): Promise<string | null> {
  const claim = await getClaimByKey(env, key)
  if (!claim) return null

  const now = Date.now()
  await env.DB.batch([
    env.DB.prepare(
      'INSERT OR IGNORE INTO node_registry (node_id, node_key, created_at, updated_at) VALUES (?, ?, ?, ?)',
    ).bind(claim.node_id, key, now, now),
    env.DB.prepare('DELETE FROM node_claim WHERE node_key = ?').bind(key),
  ])

  const row = await env.DB.prepare('SELECT node_id FROM node_registry WHERE node_key = ?').bind(key).first<{
    node_id: string
  }>()
  return row?.node_id ?? null
}

/** /node/* 鉴权：已登记 → 直接返回；否则尝试消费待认领凭据（首次 poll 自动入库） */
export async function resolveNodeId(env: Bindings, key: string | undefined): Promise<string | null> {
  if (!key) return null
  try {
    const registered = await getNodeByKey(env, key)
    if (registered) return registered.node_id
    return await promoteClaim(env, key)
  } catch (err) {
    // 0010/0011 未迁移：一律 401（agent 会打「未登记」提示），页面侧另有明确报错
    console.error('resolve node key failed:', String(err))
    return null
  }
}
