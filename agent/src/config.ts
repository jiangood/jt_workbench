/**
 * agent 启动配置（v4.12）：节点密钥由后台生成，安装脚本写进 compose 的 `NODE_KEY`
 *
 * - Worker 地址：启动参数（compose 的 command），本地调试可用 WORKER_URL
 * - 节点密钥：NODE_KEY 环境变量（后台「添加节点」→ 一键安装脚本自动写入）
 * - 节点名称由 Worker 用密钥反查，agent 不需要也不上报 nodeId
 * - Watchtower 地址 / 令牌：compose 同网络内网（v5.1 即时升级），由安装脚本一并写入；
 *   老 compose 没有这两项 → 留空，自动退回 15min 轮询
 * - POLL_INTERVAL 仅作可选调试旋钮，默认 600s
 */

const MIN_KEY_LEN = 16
const MAX_KEY_LEN = 128

export interface AgentConfig {
  workerUrl: string
  nodeKey: string
  pollIntervalMs: number
  /** Watchtower HTTP API 基地址（如 http://watchtower:8080）；空 = 不做即时升级 */
  watchtowerUrl: string
  /** HTTP API 令牌：安装脚本随机生成并同时写进两个容器；空 = 不做即时升级 */
  watchtowerToken: string
}

/** 启动参数优先（compose command），本地调试退回 WORKER_URL；末尾斜杠容错 */
function loadWorkerUrl(): string {
  const raw = process.argv[2]?.trim() || process.env.WORKER_URL?.trim()
  if (!raw) {
    throw new Error('缺少 Worker 地址：用后台生成的安装脚本部署，或启动参数传 https://你的-worker')
  }
  return raw.replace(/\/+$/, '')
}

function loadNodeKey(): string {
  const key = process.env.NODE_KEY?.trim()
  if (!key) {
    throw new Error('缺少 NODE_KEY：请用后台 /#/admin →「计算节点」→「添加节点」生成的安装脚本部署')
  }
  if (key.length < MIN_KEY_LEN || key.length > MAX_KEY_LEN || !/^[!-~]+$/.test(key)) {
    throw new Error('NODE_KEY 格式不正确（需 16~128 位可见 ASCII 字符）')
  }
  return key
}

let cached: AgentConfig | null = null

/** 首次调用加载（缺配置时抛错 → main 的 catch 打 fatal 并 exit 1） */
export function getConfig(): AgentConfig {
  if (cached) return cached
  cached = {
    workerUrl: loadWorkerUrl(),
    nodeKey: loadNodeKey(),
    pollIntervalMs: Number(process.env.POLL_INTERVAL ?? 600) * 1000,
    watchtowerUrl: (process.env.WATCHTOWER_URL?.trim() || '').replace(/\/+$/, ''),
    watchtowerToken: process.env.WATCHTOWER_TOKEN?.trim() || '',
  }
  return cached
}
