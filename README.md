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
cd agent && npm ci && npm run dev      # build + node dist/agent.mjs（需 NODE_KEY）
```

**本地不碰线上**：`wrangler dev` 默认 local 模式（本地 D1 / R2）；`npm run deploy` 被 `scripts/guard-deploy.mjs` 拦截，只能 `npm run deploy:dry`（只打包）。任何 `--remote` 命令、R2 写入、生产 API 写请求都不要在本地执行。

## 发布到线上

线上只通过 **GitHub Release** 变更，push 不部署：

1. 在 `main` 上开发完，本地 `npm run check` 全绿；
2. GitHub → Releases → **Draft a new release** → 新建 tag（如 `v0.2.0`）→ **Publish release**；
3. `release.yml` 自动执行：校验 tag 在 `main` 上 → worker / agent 类型检查 + worker dry-run → D1 迁移 → 部署 Worker → 仅当 `agent/` 有改动时构建镜像（发布 tag + `v<sha>` + `latest`）。

只发布有变化的半边：纯 Worker 发布不会重推 agent `latest`，节点不会白白重启。失败在 Actions 里 **Re-run jobs** 即可，不会重复建 release。

- **D1 迁移必须向后兼容**（expand/contract）：先加列/表 → 改代码 → 再删旧结构；D1 不会随 Worker 回滚。
- **回滚**：把旧 tag 重新发布一次 release（走同一流程、有记录），或用 `v<sha>` 镜像重建 agent。不要在本地直接 `wrangler rollback`。
- **首次初始化**（订阅源 / 抓取任务 / 屏蔽词）在 `migrations/0013_seed_news.sql` 里，随发布自动执行一次，无需手工 `d1 execute`。
- 仓库 Secrets 需要 `CLOUDFLARE_API_TOKEN`；建议给 `production` environment 配 required reviewer，让发布先等人工批准。

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

## 部署执行节点（agent）

agent 是局域网里的哑执行节点：poll 领任务 → 执行 → 回传，无状态、无本地队列；升级交给 Watchtower，不手工重建。

**部署只有两步：后台点「添加节点」拿一条命令 → 在目标机器粘贴执行。** 宿主机不需要 `.env`，节点密钥由安装脚本直接写进 `docker-compose.yml`。

### 1. Worker 侧前置（一次性）

无需本地操作：发布 release 时 `release.yml` 会自动 `wrangler d1 migrations apply jt_workbench --remote`，建表和默认数据（`0013_seed_news.sql`）都在迁移里。只需在仓库 Secrets 配好 `CLOUDFLARE_API_TOKEN`。

- 节点登记用 `node_registry`（已认领）+ `node_claim`（10 分钟待认领凭据，`0010` / `0011`）。
- 管理员密码存 D1，**不需要 `wrangler secret`**：
  - 首次部署：发布完成后打开站点 → 登录页自动切到「初始化管理员」→ 设置账号密码（≥8 位）。
  - 日常改密：`/#/admin` →「账号安全」→ 输入当前密码和新密码；改完所有旧会话立即失效，需重新登录。
- 其他参数（JWT 密钥 / 邮件服务商与 SMTP / 发件人 / agent 版本）都在 `/#/admin` →「参数与密钥」里维护；邮件服务商内置 QQ / 163 / 126 / Gmail / Outlook / 新浪 / 阿里云模板，选中即自动填好 SMTP 主机 / 端口 / 加密方式。

### 2. 后台添加节点

登录 `/#/admin` →「执行节点」→ **添加节点** → 输入名称（建议主机名，如 `nas-01`）。

后台会生成节点密钥和一条安装命令：

```bash
curl -fsSL 'https://jt.410518072.xyz/install/<key>.sh' | sh
```

**安装命令 10 分钟内有效，请尽快执行；生成后保持页面打开**——节点首次连接成功后页面会自动提示「安装成功」，并把节点加进列表。关闭页面也不影响安装，只是看不到这个即时提示。

> 此刻数据库里还没有节点记录，只有一条 10 分钟待认领凭据（列表不显示）。agent 第一次 poll 时才写入 `node_registry`，因此不会留下「装了一半的离线节点」。

弹窗里还有「手动方案」：同样的 compose 内容 + 三行命令，适合不想 `curl | sh` 的情况。

### 3. 在目标 Linux 机器执行

在**任意当前目录**执行上面的命令。脚本会：

1. 创建 `./workbench-agent/docker-compose.yml`（**仅此一个文件**，无 `.env`、无卷）；
2. 启动 `workbench-agent` + `watchtower` 两个容器。

脚本默认非 root 执行；报「无法访问 Docker」时先确认 Docker 服务已启动，权限问题按提示 `sudo usermod -aG docker $USER` 后重新登录。

目录固定为 `workbench-agent`，默认**一台机器一个节点**。同一台机器要跑多个节点时，复制目录并改名（compose 项目名取自目录名），再手动换 compose 里的 `NODE_KEY`；watchtower 建议只保留一个。

已存在 `workbench-agent/docker-compose.yml` 时脚本会拒绝覆盖；确认要重写请：

```bash
WORKBENCH_AGENT_FORCE=1 sh ...
```

私有镜像需要先登录一次：

```bash
docker login ghcr.io -u jiangood
```

（镜像公开的话可以删掉 compose 里 watchtower 的 `~/.docker/config.json` 挂载，否则 Docker 会把不存在的挂载点建成目录。）

### 4. 验证

页面弹窗会自动变成「节点已上线，安装成功」；之后在 `/#/admin` 的「执行节点」表格里能看到该节点在线。

也可以在宿主机看日志：

```bash
cd workbench-agent && docker compose logs -f workbench-agent
```

| 日志 / 现象 | 含义 |
|-------------|------|
| `agent starting` + `pollIntervalMs:600000` | 正常，之后约每 10min 一轮 poll |
| `节点未登记或密钥已失效` | 密钥被注销 / 后台记录被删，回后台重新添加节点并重装 |
| `缺少 NODE_KEY` | compose 里没有密钥（手动方案漏了），或用了旧的 agent 镜像 |
| `poll failed` + `fetch failed` | Worker 地址不可达（域名 / 网络 / 证书问题） |

### 5. 升级、回滚、重装

- **日常升级**：发布 release（见「发布到线上」）→ 推 `:latest` → Watchtower 每 15min 轮询，inspect 旧容器并原样复制 command / env / 挂载 / 网络 / 重启策略重建。
- **配置变更**（换镜像、改 Worker 地址等）Watchtower 不负责，手动改 `workbench-agent/docker-compose.yml` 后 `docker compose up -d`。
- **回滚**：把 `image:` 钉到 `ghcr.io/jiangood/workbench-agent:v<short-sha>`（对应提交的短 sha，也可用发布 tag）再 `up -d`；确认稳定后再改回 `:latest`。
- **重装 / 换机**：在节点行点「安装命令」取回长期有效的 compose 命令（已登记节点不设过期），按提示覆盖即可。
- **注销节点**：列表行「注销」→ 密钥立即失效（agent 持续 401），重新添加同名节点会生成新密钥和新的 10 分钟安装命令。
- **退路**：若 `nicholas-fedor/watchtower` 失维护，删掉该容器，宿主机 crontab 两行等效：

  ```cron
  */15 * * * * cd ~/workbench-agent && docker compose pull && docker compose up -d
  ```

### 6. 本地直接跑（不用 Docker）

```bash
cd agent && npm ci && npm run build
NODE_KEY=<后台节点密钥> node dist/agent.mjs https://jt.410518072.xyz
# 或：NODE_KEY=... WORKER_URL=https://jt.410518072.xyz node dist/agent.mjs
```

本地调试不需要走安装脚本：先在后台添加节点，从弹窗的手动方案里复制 `NODE_KEY` 即可。
