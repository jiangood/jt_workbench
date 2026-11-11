# workbench-cf

个人工作台的 Cloudflare 免费版重写：**Worker（Hono + D1 + R2）+ 局域网执行节点 agent**。

- 方案文档（唯一事实源）：`C:\Users\water\.opencode\plan\cloudflare-migration.md`
- 旧系统参考（只读）：`D:\ws\workbench`（并行运行期间保持在线，切流稳定后归档）

## 结构

| 目录 | 说明 |
|------|------|
| `worker/` | Cloudflare Worker：静态页 + API + `/node/*` 节点协议（core/modules 分层） |
| `agent/` | 局域网执行节点：Node 22 + TS + esbuild 单文件，docker compose 双容器（agent + watchtower fork） |

## 开发

```bash
cd worker && npm ci && npm run dev     # wrangler dev
cd agent && npm ci && npm run dev      # build + node dist/agent.mjs
```

## 部署执行节点（agent）

agent 是局域网里的哑执行节点：poll 领任务 → 执行 → 回传，无状态、无本地队列；升级交给 Watchtower，不手工重建。

### 1. Worker 侧前置

- Worker 已部署（生产：`https://jt.410518072.xyz`），且设置了节点密钥：

  ```bash
  cd worker && npx wrangler secret put NODE_KEY
  ```

- agent 的 `NODE_KEY` 必须与 Worker 上的值完全一致，否则 `/node/*` 一律 401，agent 打 `node key rejected` 后 `exit 1`。
- 节点**无需预先注册**：第一次 poll 自动写入 `node_state`，随后出现在后台 `/#/admin` 的「执行节点」表格（`NODE_ID` / 版本 / 在线状态 / 最后心跳）。
- 管理员密码存 D1，**不再需要 `wrangler secret put ADMIN_PWD_*`**：
  - 首次部署：`cd worker && npx wrangler d1 migrations apply workbench --remote`（`0009` 给 `auth_state` 加 `username` / `pwd_hash` / `pwd_salt`），然后打开站点 → 登录页自动切到「初始化管理员」→ 设置账号密码（≥8 位）。
  - 日常改密：`/#/admin` → 「账号安全」→ 输入当前密码和新密码；改完所有旧会话立即失效，需重新登录。
  - 兼容老部署：若之前设过 `ADMIN_USER` / `ADMIN_PWD_SALT` / `ADMIN_PWD_HASH`，首次用旧密码登录成功后会自动写入 D1，之后在后台改密即可（secret 可删）。`node scripts/gen-password.mjs` 仍可用于生成引导值。

### 2. 镜像从哪来

`.github/workflows/agent-image.yml`：main 上 `agent/**` 有变更 → 构建并推送双标签到 ghcr：

| 标签 | 用途 |
|------|------|
| `ghcr.io/jiangood/workbench-agent:latest` | Watchtower 轮询目标（滚动升级） |
| `ghcr.io/jiangood/workbench-agent:v<short-sha>` | 不可变回滚锚点（commit 前 8 位，如 `vaa834fc`） |

### 3. 宿主机部署

```bash
# 1) 起目录并写 compose
# 仓库是 private，raw.githubusercontent.com 匿名访问一律 404，所以这里直接内联生成；
# 内容与 agent/docker-compose.yml 一致，用自己仓库的镜像时把 image 里的 jiangood 换成自己的用户名
mkdir -p ~/workbench-agent && cd ~/workbench-agent
cat > docker-compose.yml <<'EOF'
# 部署双容器：agent + watchtower fork（v4.4：原版已归档，fork 语法兼容）
# 密钥走 .env（不入库）；NODE_ID 多节点部署时必须各不相同
services:
  workbench-agent:
    image: ghcr.io/jiangood/workbench-agent:latest
    restart: unless-stopped
    environment:
      - WORKER_URL=${WORKER_URL}
      - NODE_ID=${NODE_ID}
      - NODE_KEY=${NODE_KEY}
      # - POLL_INTERVAL=600
    labels:
      - com.centurylinklabs.watchtower.enable=true

  watchtower:
    image: nicholas-fedor/watchtower
    restart: unless-stopped
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ~/.docker/config.json:/config.json:ro
    environment:
      - WATCHTOWER_LABEL_ENABLE=true # 只更新带标签容器，不碰宿主机其他容器
      - WATCHTOWER_POLL_INTERVAL=900 # 15 分钟短轮询
      - WATCHTOWER_CLEANUP=true
EOF

# 2) 密钥走 .env（不入库，需与 compose 同目录）
cat > .env <<'EOF'
WORKER_URL=https://jt.410518072.xyz
NODE_ID=nas-01          # 多节点部署时必须各不相同（建议用主机名）
NODE_KEY=与 Worker secret 相同的值
# POLL_INTERVAL=600     # 默认 600s（10min），实际 sleep 带 ±60~90s 抖动
EOF

# 3) 私有镜像先登录一次；镜像设为 public 可跳过
docker login ghcr.io -u jiangood

# 4) 起双容器（agent + watchtower）
docker compose up -d
```

注意：watchtower 挂载了 `~/.docker/config.json` 用于拉私有镜像；若镜像已公开、宿主机上又没有该文件，把 compose 里那一行 `- ~/.docker/config.json:/config.json:ro` 删掉，否则 Docker 会把不存在的挂载点建成目录。

### 4. 验证

```bash
docker compose logs -f workbench-agent
```

| 日志 / 现象 | 含义 |
|-------------|------|
| `agent starting` + `pollIntervalMs:600000` | 正常，之后约每 10min 一轮 poll |
| `fatal, exiting` / `node key rejected` | `NODE_KEY` 与 Worker secret 不一致 |
| `missing env: ...` | `.env` 没被读取（必须在 compose 同目录） |

后台 `/#/admin` 看到该 `NODE_ID` 在线，且「最近任务运行」里出现带 `agent_version` 的记录，即部署成功。

### 5. 升级与回滚

- **日常升级全自动**：push 到 main → CI 门禁（check 全绿）→ 推 `:latest` → Watchtower 每 15min 轮询，inspect 旧容器并原样复制 env / 挂载 / 网络 / 重启策略重建。
- **配置变更**（新增 env、换镜像等）Watchtower 不负责，手动 `docker compose up -d`。
- **回滚**：把 `image:` 钉到 `ghcr.io/jiangood/workbench-agent:v<short-sha>`（对应提交的前 8 位）再 `up -d`；钉住后该容器不再跟随 `:latest`，相当于冻结此节点升级，确认稳定后再改回 `:latest`。
- **退路**：若 `nicholas-fedor/watchtower` 失维护，删掉该容器，宿主机 crontab 两行等效：

  ```cron
  */15 * * * * cd ~/workbench-agent && docker compose pull && docker compose up -d
  ```

### 6. 本地直接跑（不用 Docker）

```bash
cd agent && npm ci && npm run build
WORKER_URL=https://jt.410518072.xyz NODE_ID=dev NODE_KEY=... node dist/agent.mjs
```
