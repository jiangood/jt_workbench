# jt_workbench

个人工作台的 Cloudflare 免费版重写：**Worker（Hono + D1 + R2）+ 局域网计算节点 agent**。

- 开发 / 贡献约定：`AGENTS.md`
- 旧系统参考（只读）：`D:\ws\workbench`（并行运行期间保持在线，切流稳定后归档）

## 结构

| 目录 | 说明 |
|------|------|
| `worker/` | Cloudflare Worker：静态页 + API + `/node/*` 节点协议（core/modules 分层） |
| `agent/` | 局域网计算节点：Node 22 + TS + esbuild 单文件，docker compose 双容器（agent + watchtower fork） |

## 开发

```bash
cd worker && npm ci && npm run dev     # wrangler dev
cd agent && npm ci && npm run dev      # build + node dist/agent.mjs（需 NODE_KEY）
```

**本地不碰线上**：`wrangler dev` 默认 local 模式（本地 D1 / R2）；`npm run deploy` 被 `guard-deploy.mjs` 拦截（要求 `CI=true`），本地只能用 `npm run deploy:dry` 打包预检。红线细节见 `AGENTS.md`。

## 发布到线上

线上由 **Git tag** 驱动，普通分支 push 不部署：

- **PR 合并到 main**：`.github/workflows/auto-tag.yml` 自动按最新正式版本递增 patch（如 `v0.13.28 → v0.13.29`），tag 指向 PR 合并提交，并显式触发发布工作流。
- **手动发布**：在 main 上创建并 push `vX.Y.Z` tag（如 `git tag -a v0.13.30 -m "Release v0.13.30" && git push origin v0.13.30`），自动执行发布。
- `release.yml` 校验 tag 位于 `main` → 类型检查 + Worker dry-run → D1 迁移 → Worker 部署 → 仅当 `agent/` 有改动时构建镜像并回写版本。
- 发布成功后自动创建 GitHub Release 并生成说明，不再需要手动点击 Publish release。

只发布有变化的半边：纯 Worker 发布不会重推 agent `latest`。失败在 Actions 里 **Re-run jobs** 即可；自动打 tag 工作流重跑会复用同一合并提交已创建的 tag。

- **D1 迁移必须向后兼容**（expand/contract）：先加列/表 → 改代码 → 再删旧结构；D1 不会随 Worker 回滚。
- **回滚**：不要覆盖已有 tag；创建新的回滚提交和版本 tag，或用 `v<sha>` 镜像回滚 agent。不要在本地直接 `wrangler rollback`。
- 仓库 Secrets 需要 `CLOUDFLARE_API_TOKEN`；工作流使用默认 `GITHUB_TOKEN`。
- 迁移 / 首次 seed / 镜像标签与版本回写约定见 `AGENTS.md`「发布（CI）」。

### Cloudflare API Token

在 Cloudflare Dashboard → My Profile → API Tokens 创建（模板 **Edit Cloudflare Workers** 基本够用），权限至少：

| 范围 | 权限 | 用途 |
|------|------|------|
| Account | Workers Scripts : Edit | 部署 Worker / 静态资源 |
| Account | D1 : Edit | 发布时执行迁移 |
| Account | Workers R2 Storage : Edit | R2 绑定与写入 |
| Account | Account Settings : Read | wrangler 解析 account |
| Zone `410518072.xyz` | Workers Routes : Edit | 自定义域 `jt.410518072.xyz` |
| Zone `410518072.xyz` | Zone : Read | 解析域名对应 zone |

- Account resources 选自己的账户，Zone resources 选 `410518072.xyz`（不要 All zones）
- 创建后 token 只显示一次，直接存进 GitHub 仓库 **Settings → Secrets and variables → Actions**，名称 `CLOUDFLARE_API_TOKEN`
- **token 只放 GitHub Secrets**：不进本地 `.dev.vars`、不写进 `wrangler.jsonc`、不落到仓库
- 若日志报 `Failed to automatically retrieve account IDs`：补一个 `CLOUDFLARE_ACCOUNT_ID` secret（Dashboard 账户首页右侧可复制），并在 `release.yml` 的 `env` 里加同名变量
- 首次绑定自定义域若报 DNS 权限错误，再给 token 加 `Zone : DNS : Edit`
- 轮换：新建 token 更新 secret 后，在 Cloudflare 撤销旧 token；泄露时立即撤销

## 部署计算节点（agent）

agent 是局域网里的哑计算节点：poll 领任务 → 执行 → 回传，无状态、无本地队列；升级交给 Watchtower，不手工重建。

**部署只有两步：后台点「添加节点」→ 之后在该行点「接入」拿命令 → 在目标机器粘贴执行。** 宿主机不需要 `.env`，节点密钥由安装脚本直接写进 `docker-compose.yml`。

### 1. Worker 侧前置（一次性）

无需本地操作：建表与默认数据随 release 自动迁移（见「发布到线上」），只需在仓库 Secrets 配好 `CLOUDFLARE_API_TOKEN`。站点起来后：

- 首次部署：打开登录页会自动切到「初始化管理员」→ 设置账号密码（≥8 位）。
- 日常改密：`/#/admin` →「账号安全」→ 输入当前密码和新密码；改完所有旧会话立即失效，需重新登录。
- 其他参数（JWT 密钥 / 邮件提醒 / agent 版本）都在 `/#/admin` →「参数与密钥」里维护，**不需要 `wrangler secret`**。邮件提醒收在一张卡片里：选服务商模板（QQ / 163 / 126 / Gmail / Outlook / 新浪 / 阿里云）+ 填邮箱账号和授权码即可，SMTP 主机 / 端口 / 加密方式自动配好，卡片里还能直接发一封测试邮件。

### 2. 后台添加节点

登录 `/#/admin` →「计算节点」→ **添加节点** → 输入名称（建议主机名，如 `nas-01`）。

添加后立刻在列表里登记（接入前显示离线）；点击该行 **接入**，弹窗里有接入命令（节点密钥只写进生成的 compose，**页面不展示**）：

```bash
curl -fsSL 'https://jt.410518072.xyz/install/<key>.sh' | WORKBENCH_AGENT_FORCE=1 sh
```

**命令长期有效**——现场机器不能马上接入（网络、命令不熟等）也没关系，之后随时回到该行点「接入」取回；弹窗开着时节点首次上线会自动提示「已接入（在线）」，关掉页面只是看不到即时提示。
重置密钥后旧命令立即失效，需要从该行重新取回新命令。

> 节点记录在添加时就写入 `node_registry`，接入前一直显示离线；注销节点会连同记录一起删除。

弹窗里还有「手动方案」：同样的 compose 内容 + 三行命令，适合不想 `curl | sh` 的情况。

### 3. 在目标 Linux 机器执行

在**任意当前目录**执行上面的命令。脚本会：

1. 创建 `./workbench-agent/docker-compose.yml`（**仅此一个文件**，无 `.env`、无卷）；
2. 启动 `workbench-agent` + `watchtower` 两个容器。

脚本默认非 root 执行；报「无法访问 Docker」时先确认 Docker 服务已启动，权限问题按提示 `sudo usermod -aG docker $USER` 后重新登录。

目录固定为 `workbench-agent`，默认**一台机器一个节点**。同一台机器要跑多个节点时，复制目录并改名（compose 项目名取自目录名），再手动换 compose 里的 `NODE_KEY`（点该节点「重置密钥」后用新接入命令在第二个目录部署）；watchtower 建议只保留一个。

接入命令统一带 `WORKBENCH_AGENT_FORCE=1`，重装/换机会直接覆盖已有 compose；手工执行时写成：

```bash
curl -fsSL 'https://.../install/<key>.sh' | WORKBENCH_AGENT_FORCE=1 sh
```

镜像已公开，watchtower 无需挂载 Docker 登录配置。若改用私有镜像，需先 `docker login ghcr.io -u jiangood` 并按需给 watchtower 挂载凭据。

> watchtower 镜像用 `ghcr.io/nicholas-fedor/watchtower`。两点原因：Docker Hub 的正确仓库名是 `nickfedor/watchtower`（`nicholas-fedor/watchtower` 在 hub 上不存在，拉取会报 repository does not exist），且国内直连 hub 基本拉不动；ghcr 与 hub 由同一发布流水线推送，内容一致。

### 4. 验证

页面弹窗会自动变成「节点已接入（在线）」；之后在 `/#/admin` 的「计算节点」表格里能看到该节点在线。

也可以在宿主机看日志：

```bash
cd workbench-agent && docker compose logs -f workbench-agent
```

| 日志 / 现象 | 含义 |
|-------------|------|
| `agent starting` + `pollIntervalMs:600000` | 正常，之后约每 10min 一轮 poll |
| `节点未登记或密钥已失效` | 密钥被重置 / 节点被注销 / 记录被删：回后台该行「接入」取新命令重装（或重新添加节点） |
| `缺少 NODE_KEY` | compose 里没有密钥（手动方案漏了），或用了旧的 agent 镜像 |
| `poll failed` + `fetch failed` | Worker 地址不可达（域名 / 网络 / 证书问题） |
| Watchtower 拉取并重建容器 | 正常升级：Watchtower 轮询发现新 `:latest` 镜像后自动更新 |
| `job failed` + `fetch <url> failed: … [ENOTFOUND]` | 某个任务的外网源抓不动：方括号里是 cause 的错误码（DNS / TLS / 连接被重置），message 里带完整 URL；周期任务会在下个 cron 自动重试，不用重装 |

### 5. 升级、回滚、重装

- **日常升级**：发布 release（见「发布到线上」）→ 推 `:latest` + 回写 D1 `agent_latest_version`；Watchtower 按 `WATCHTOWER_POLL_INTERVAL`（默认 15 分钟）轮询拉取新镜像并重建容器。重建时原样复制 env / 挂载 / 网络 / 重启策略。
- **配置变更**（换镜像、改 Worker 地址等）Watchtower 不负责，手动改 `workbench-agent/docker-compose.yml` 后 `docker compose up -d`。
- **回滚**：把 `image:` 钉到 `ghcr.io/jiangood/workbench-agent:v<short-sha>`（对应提交的短 sha，也可用发布 tag）再 `up -d`；钉住后 Watchtower 不会把它拉回 `latest`，确认稳定后再改回 `:latest`。
- **重装 / 换机**：在节点行点「接入」取回长期有效的命令（命令自带 `WORKBENCH_AGENT_FORCE=1`，已登记节点不设过期）。
- **重置密钥**：节点行「重置密钥」→ 旧密钥立即失效（该 agent 持续 401，列表立刻显示离线），再用该行「接入」取回新命令重新部署；列表里不展示密钥本身。
- **注销节点**：列表行「注销」→ 密钥立即失效（agent 持续 401），重新添加同名节点会生成新密钥和新接入命令。
- **退路**：若 `nicholas-fedor/watchtower` 失维护，删掉该容器，宿主机 crontab 两行等效：

  ```cron
  */15 * * * * cd ~/workbench-agent && docker compose pull && docker compose up -d
  ```

### 6. 本地直接跑（不用 Docker）

```bash
cd agent && npm ci && npm run build
NODE_KEY=<compose 里的节点密钥> SERVER_URL=https://jt.410518072.xyz node dist/agent.mjs
```

本地调试不需要走安装脚本：先在后台添加节点，从弹窗的手动方案里复制 `NODE_KEY` 即可。
