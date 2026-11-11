/**
 * 即时升级（v5.1）：poll 带回的 agentLatestVersion 落后于自身、且当前空闲时，
 * 直接 POST Watchtower HTTP API 触发一次更新——把「发布 → 节点就位」从 15min 轮询压到秒级。
 *
 * 安全边界（方案文档决策 #16 的可选增强）：
 * - 只走 compose 内网 `http://watchtower:8080`，端口不 publish，宿主机外部不可达
 * - 令牌由安装脚本随机生成、同时写进 agent 与 watchtower 两个容器；老 compose 没有 → 自动退回轮询
 * - Watchtower 拉的仍是 CI 门禁产出的 `:latest`，爆炸半径封闭（不执行任何网络下发的代码）
 * - `async=true`：立刻拿 202，不占着连接等自己被重启
 * - 同一版本 30min 内只重试一次，避免 registry 抖动时反复触发
 */

import pino from 'pino'
import { getConfig } from './config.js'
import { describeError } from './describe-error.js'
import { AGENT_VERSION } from './version.js'

const log = pino()
const RETRY_MS = 30 * 60_000
const TIMEOUT_MS = 30_000

let attemptedVersion: string | null = null
let attemptedAt = 0

/** 空闲时调用（poll 没领到任务）：版本落后 → 请 Watchtower 立刻更新自己 */
export async function maybeRequestUpdate(latest: string | undefined): Promise<void> {
  if (!latest || latest === AGENT_VERSION) return
  if (AGENT_VERSION === 'dev') return // 本地构建：版本无意义，别去骚扰 Watchtower

  const { watchtowerUrl, watchtowerToken } = getConfig()
  if (!watchtowerUrl || !watchtowerToken) return // 旧 compose（未开 HTTP API）：靠 15min 轮询

  const now = Date.now()
  if (attemptedVersion === latest && now - attemptedAt < RETRY_MS) return
  attemptedVersion = latest
  attemptedAt = now

  try {
    const res = await fetch(`${watchtowerUrl}/v1/update?async=true`, {
      method: 'POST',
      headers: { authorization: `Bearer ${watchtowerToken}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (res.ok) {
      log.info({ current: AGENT_VERSION, latest }, 'watchtower update requested')
    } else {
      // 401 = 令牌不一致（重装 compose 后才会同步）；429 = 已有更新在跑
      log.warn({ current: AGENT_VERSION, latest, status: res.status }, 'watchtower update rejected')
    }
  } catch (e) {
    log.warn({ err: describeError(e) }, 'watchtower unreachable (fallback: 15min poll)')
  }
}
