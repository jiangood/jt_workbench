/**
 * 节点登记（决策 #22，v4.13）：后台直接写 node_registry，密钥随记录长期有效
 *
 * - 点「添加节点」立即写入 node_registry（列表里是一条离线记录），不再有「待认领」中间态
 *   ——现场环境不一定能马上接入（网络 / 命令不熟），20 分钟凭据会过期，改为长期可用的登记记录
 * - 密钥由后台生成，只经「接入方式」弹窗里的安装命令下发；页面列表不返回密钥
 * - 鉴权 = 用 x-node-key 反查 node_registry.node_id（等值查询走唯一索引）
 * - 重置密钥 / 注销立即生效（agent 会一直 401 直到用新命令重新部署）
 *
 * node_claim（0011）已废弃：表保留但不再读写，等后续 release 走 expand/contract 再删
 */

import type { Bindings } from './envelope'

export const MAX_NODE_NAME_LEN = 32

export interface NodeRow {
  node_id: string
  node_key: string
  created_at: number
  updated_at: number
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

/**
 * 直接登记节点：返回 false 表示名称已被占用（并发下 INSERT OR IGNORE 不报错）。
 * 首次接入前列表显示离线，接入方式随时可从该行取回。
 */
export async function addNode(env: Bindings, nodeId: string, key: string): Promise<boolean> {
  const now = Date.now()
  const res = await env.DB
    .prepare(
      'INSERT OR IGNORE INTO node_registry (node_id, node_key, created_at, updated_at) VALUES (?, ?, ?, ?)',
    )
    .bind(nodeId, key, now, now)
    .run()
  return res.meta.changes > 0
}

/**
 * 重置已登记节点的密钥：旧密钥立即失效（页面不展示密钥，重装/换机只能从「接入方式」取新值）。
 * 同时删掉心跳行，列表立刻显示离线，避免旧 agent 401 期间还显示在线。
 */
export async function rotateNodeKey(env: Bindings, nodeId: string): Promise<string | null> {
  const node = await getRegisteredNode(env, nodeId)
  if (!node) return null

  const key = randomNodeKey()
  await env.DB.batch([
    env.DB
      .prepare('UPDATE node_registry SET node_key = ?, updated_at = ? WHERE node_id = ?')
      .bind(key, Date.now(), nodeId),
    env.DB.prepare('DELETE FROM node_state WHERE node_id = ?').bind(nodeId),
  ])
  return key
}

/** 注销：同时清掉心跳行；job_run 历史保留（node_id 只是文本） */
export async function unregisterNode(env: Bindings, nodeId: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM node_registry WHERE node_id = ?').bind(nodeId),
    env.DB.prepare('DELETE FROM node_state WHERE node_id = ?').bind(nodeId),
  ])
}

/** /node/* 鉴权：已登记 → 返回 node_id；未登记 / 表缺失一律 null（调用方按 401 处理） */
export async function resolveNodeId(env: Bindings, key: string | undefined): Promise<string | null> {
  if (!key) return null
  try {
    const registered = await getNodeByKey(env, key)
    return registered?.node_id ?? null
  } catch (err) {
    // 0010 未迁移：一律 401（agent 会打「未登记」提示），页面侧另有明确报错
    console.error('resolve node key failed:', String(err))
    return null
  }
}
