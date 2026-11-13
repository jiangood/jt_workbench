/**
 * 一键安装（v4.13）：节点在后台直接登记，安装链接长期有效
 *
 *   curl -fsSL 'https://<worker>/install/<key>.sh' | sh
 *
 * - URL 里的 key 就是 node_registry.node_key：脚本内联为 `NODE_KEY`，agent 首次 poll 即通过鉴权
 * - 脚本在目标机**当前目录**创建 `workbench-agent/docker-compose.yml`（仅此一个文件）并启动
 * - 链接不需要登录态（安装端没有账号），密钥泄露时点「重置密钥」即可让旧链接立即失效
 */

import type { Context } from 'hono'
import type { Env } from './envelope'
import { getNodeByKey } from './nodekey'

const AGENT_IMAGE = 'ghcr.io/jiangood/workbench-agent:latest'
const AGENT_DIR = 'workbench-agent'

export interface InstallPayload {
  nodeId: string
  scriptUrl: string
  command: string
  compose: string
}

/**
 * 对外 origin：生产直接用请求 URL（Cloudflare 给的就是自定义域名 / workers.dev）。
 * 注意 wrangler dev 会把请求 URL 映射成配置里的 route 域名，本地验证脚本时请手动请求 127.0.0.1。
 */
export function requestOrigin(c: Context<Env>): string {
  return new URL(c.req.url).origin
}

function buildCompose(workerUrl: string, nodeKey: string): string {
  return `# 由 workbench 后台生成 · 已内联节点密钥，请勿提交仓库或外传
services:
  workbench-agent:
    image: ${AGENT_IMAGE}
    restart: unless-stopped
    environment:
      - NODE_KEY=${nodeKey}
      - WORKER_URL=${workerUrl}
    labels:
      - com.centurylinklabs.watchtower.enable=true

  watchtower:
    image: ghcr.io/nicholas-fedor/watchtower:latest
    restart: unless-stopped
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    environment:
      - WATCHTOWER_LABEL_ENABLE=true # 只更新带标签容器
      - WATCHTOWER_POLL_INTERVAL=900 # 15 分钟轮询
      - WATCHTOWER_CLEANUP=true
`
}

/** POSIX sh：当前目录创建 workbench-agent/，写 compose，起容器；不依赖 .env / 卷 */
function buildScript(origin: string, nodeId: string, nodeKey: string): string {
  return `#!/bin/sh
# workbench agent 一键安装 · 节点 ${nodeId}
# 在任意目录执行：会创建 ${AGENT_DIR}/docker-compose.yml（仅此一个文件）并启动
set -eu

DIR="${AGENT_DIR}"
COMPOSE="$DIR/docker-compose.yml"

if [ -f "$COMPOSE" ] && [ "\${WORKBENCH_AGENT_FORCE:-0}" != "1" ]; then
  echo "已存在 $COMPOSE；确认要覆盖请加 WORKBENCH_AGENT_FORCE=1 重新执行" >&2
  exit 1
fi

command -v docker >/dev/null 2>&1 || {
  echo "未找到 docker：请先安装 Docker Engine（含 compose 插件）" >&2
  exit 1
}

if ! docker info >/dev/null 2>&1; then
  echo "无法访问 Docker：确认服务已启动；若为权限问题，执行 sudo usermod -aG docker $USER 后重新登录" >&2
  exit 1
fi

umask 077
mkdir -p "$DIR"
cat > "$COMPOSE" <<'YAML'
${buildCompose(origin, nodeKey)}YAML

if docker compose version >/dev/null 2>&1; then
  DC="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  DC="docker-compose"
else
  echo "未找到 docker compose（v2 插件或独立 docker-compose）" >&2
  exit 1
fi

$DC up -d

echo
echo "已启动：$(pwd)/$COMPOSE"
echo "查看日志：$DC logs -f workbench-agent"
echo "节点会在下一次 poll 上线（通常 1 分钟内，兜底 10 分钟）。"
`
}

function scriptError(message: string): Response {
  // 404 也返回合法 shell：即使没带 curl -f，也不会把错误 JSON 当命令执行
  return new Response(`#!/bin/sh\necho "${message}" >&2\nexit 1\n`, {
    status: 404,
    headers: { 'content-type': 'text/x-shellscript; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/**
 * 后台响应：接入命令 + 手动方案（compose 原文）。
 * 命令统一带 WORKBENCH_AGENT_FORCE=1：首次执行无影响，重装/换机时直接覆盖旧 compose。
 */
export function buildInstall(origin: string, node: { node_id: string; node_key: string }): InstallPayload {
  const scriptUrl = `${origin}/install/${node.node_key}.sh`
  return {
    nodeId: node.node_id,
    scriptUrl,
    command: `curl -fsSL '${scriptUrl}' | WORKBENCH_AGENT_FORCE=1 sh`,
    compose: buildCompose(origin, node.node_key),
  }
}

/** 公共端点：GET /install/<key>.sh（只认 node_registry 里现存的密钥） */
export async function serveInstallScript(c: Context<Env>): Promise<Response> {
  const file = c.req.param('file') ?? ''
  const key = file.endsWith('.sh') ? file.slice(0, -3) : file

  let nodeId: string | null = null
  try {
    nodeId = (await getNodeByKey(c.env, key))?.node_id ?? null
  } catch (err) {
    console.error('resolve install script failed:', String(err))
  }
  if (!nodeId) {
    return scriptError('接入链接无效：节点可能已注销或重置过密钥，请回后台「计算节点」重新查看接入方式')
  }

  return new Response(buildScript(requestOrigin(c), nodeId, key), {
    headers: {
      'content-type': 'text/x-shellscript; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  })
}
