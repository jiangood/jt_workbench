/**
 * agent 启动配置（v4.12）：节点密钥由后台生成，安装脚本写进 compose 的 `NODE_KEY`
 *
 * - Worker 地址：WORKER_URL 环境变量（安装脚本写进 compose）
 * - 节点密钥：NODE_KEY 环境变量（后台「添加节点」→ 一键安装脚本自动写入）
 * - 节点名称由 Worker 用密钥反查，agent 不需要也不上报 nodeId
 * - POLL_INTERVAL 仅作可选调试旋钮，默认 600s
 */

const MIN_KEY_LEN = 16
const MAX_KEY_LEN = 128

export interface AgentConfig {
  workerUrl: string
  nodeKey: string
  pollIntervalMs: number
}

/** Worker 地址走 WORKER_URL 环境变量；末尾斜杠容错 */
function loadWorkerUrl(): string {
  const raw = process.env.WORKER_URL?.trim()
  if (!raw) {
    throw new Error('缺少 WORKER_URL：用后台生成的安装脚本部署，或在环境变量传入 https://你的-worker')
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
  }
  return cached
}
