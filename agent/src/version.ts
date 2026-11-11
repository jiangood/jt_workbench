/**
 * agent 版本（v5.1）：镜像构建时注入（Dockerfile 的 AGENT_VERSION → esbuild define）
 *
 * - 取值 = 发布 tag 去掉前缀 v（release.yml 传 `v4.15` → `4.15`），与 D1 `agent_latest_version` 同一口径
 * - 本地 `npm run build` / dev 未注入时回退 `dev`：只用于展示，不参与升级判断
 * - 用途：每次请求注入 agentVersion 上报给 Worker；poll 响应带回 agentLatestVersion 供即时升级比对
 */

declare const __AGENT_VERSION__: string

export const AGENT_VERSION: string = typeof __AGENT_VERSION__ === 'string' ? __AGENT_VERSION__ : 'dev'
