# 项目约定（jt_workbench）

个人工作台的 Cloudflare 免费版重写：Worker（控制面 + 存储面）+ 局域网计算节点 agent。
使用 / 部署说明见 `README.md`；本文件是开发约定。

## 布局

- `worker/`：Cloudflare Worker（Hono + D1 + R2），静态页 + API + 节点协议
- Cloudflare 资源统一 `jt` 前缀，避免与另一项目混淆：Worker `jt-workbench`、D1 `jt_workbench`、R2 `jt-workbench`（`zll-*` 属于另一个项目，勿混用）
- `agent/`：局域网计算节点（Node 22 + TypeScript + esbuild 单文件，容器化部署）
- **两棵依赖树各自独立**：`worker/package-lock.json` 与 `agent/package-lock.json` 各自提交，禁止顺手改对方的依赖版本
- 参考旧项目：`D:\ws\workbench`（只读——Java 源码 / `application.yml` 业务参数 / `WorkbenchDataInitializer.java` 的 seed cron）

## Git

- 所有功能性修改和文档修改均通过独立分支 + Pull Request 进入 `main`；禁止直接在 `main` 开发或推送。
- PR 合并后由仓库自动打 tag 并触发发布；合并后必须检查 GitHub Actions 的 CI/发布工作流结果。未经用户明确授权，不合并 PR。

## 生产环境（红线）

- **禁止直接操作生产环境**：本地 / 终端不对线上执行任何写操作——`wrangler deploy`、`wrangler d1 execute|migrations apply --remote`、R2 写入、生产 API 的写请求、`wrangler rollback` 一律不做
- **线上变更唯一入口 = Git tag 发布工作流**（`.github/workflows/release.yml`）；普通分支 push 不部署，PR 合并后由 `.github/workflows/auto-tag.yml` 自动打版本 tag
- 本地只允许 `wrangler dev`（local 模式）、`npm run check`、`npm run deploy:dry`（只打包预检）；`npm run deploy` 由 `worker/scripts/guard-deploy.mjs` 拦截（要求 `CI=true`），不要绕过
- 只读排查可以做，但不触发写；需要动生产数据时，把动作写进迁移或让用户走发布流程
- **线上调试凭据放 `online-token.txt`**（项目根目录，已被 .gitignore，禁止提交/外传）：管理员 `wb_token` cookie + 用法示例；用户让看线上页面时用它；token 过期或被撤销后让用户重新提供并更新该文件

## Worker 代码分层

- `worker/core/` 是唯一能碰 env / D1 / R2 底层的框架层；`modules/` 业务模块只能经由 core 访问
- API 统一返回自定义 JSON 信封 `{code, data, message}`；`onError` 统一兜底
- D1：时间统一 epoch 毫秒 `INTEGER`；布尔 `0/1`；JSON 列 `TEXT`；多语句写入用 `batch()`（自带事务）；索引单独 `CREATE INDEX`，不写进 CREATE TABLE；建表走 `wrangler d1 migrations`
- **参数/密钥一律存 D1，Worker 不使用 `wrangler secret`**：
  `app_config`（参数中心，注册表在 `core/config.ts` 的 `CONFIG_FIELDS`，缺失时可自动随机生成）+ `node_registry`（节点登记，添加即入库、密钥长期有效）+ `auth_state`（管理员凭据）。`Bindings` 只保留 `DB` / `R2`；新增参数只加 `CONFIG_FIELDS` 条目，**不要再新增 secret/var**（`node_claim` 已废弃，表保留待后续清理）
- 分工红线（决策 #14）：**Worker 只做简单计算与展示**——循环 / 批量 / 抓取 / 解析类逻辑一律放 agent；浏览器承担展示类计算（DOMPurify / music-metadata / JSZip / lunar）
- **上传一律支持分片**：Cloudflare 单请求体上限 100MB（免费 / Pro 平台硬限制，超了必 413）。`public/upload.js` 对 >80MB 的文件自动切 32MB 分片，走 R2 原生 multipart（`core/files.ts` 的 `startMultipart / uploadPart / completeMultipart / abortMultipart`）；上传端点用 `action=init|part|complete|abort`，单文件上限 2GB。新增上传入口照 `book` / `music` / `note` 的写法接这四个 action，不要再只留整文件单请求
- 前端 = **零构建 SPA（hash 路由）**：`public/index.html` 只是 shell（侧栏/播放条/弹窗），
  `app.js` 管路由，`views/*.js` 是视图（ES module，各自导出 `render(main, params)` / `destroy()`）；
  `lib.js` 提供 api / 图标 / 弹窗 / 转义 / 脚本懒加载 / 常驻播放器。无框架、无前端构建、无 TS
- 视图生命周期红线：切页前 router 先关弹窗再调 `destroy()`——Chart 实例、epub book、定时器、事件监听必须在 `destroy()` 里释放
- 播放统一走 `lib.js` 的 `player`（队列 / 顺序·列表·单曲·随机 / 播放列表面板 / localStorage 记忆），视图不要直接操作 `<audio>`；音乐元数据编辑走 `PATCH /api/music/:id`，时长由上传时浏览器 `music-metadata` 解析后随 query 提交
- 旧素材引用（`/news.html` 等）由 `index.ts` 的 `LEGACY_PAGES` 301 到 `/#/news`；新增视图记得同步路由表与旧链接映射
- 样式 = 自写 `public/app.css`（design tokens + dark 主题 + 移动端抽屉，无 bootstrap）；弹窗用原生 `<dialog>`（`lib.js` 的 `showDialog/closeModal`），窄屏表格由 `setupTableScroll` 自动包 `.table-scroll`
- **低频配置收进弹窗**：页面只留高频操作（浏览 / 立即执行），token、订阅源、屏蔽词、星球勾选这类设置项一律折叠为「配置」按钮 → `showDialog()` 打开（参考 `views/zsxq.js` 的「同步配置」、`views/news.js` 的订阅源/屏蔽词），避免每次进页都先看到一堆设置
- **删除类按钮收进「更多」下拉**：删除 / 清空 / 移除这类不可逆操作不做成页面或列表行里常驻的按钮（行内一排小图标最易误点），统一放右上角「更多」下拉的最后一项，用 `.more-item.danger` + `icon('trash')`，点击后再 `confirm()` 二次确认；下拉直接用 `lib.js` 的 `moreMenu(id, items, opts)` 拼 HTML + `setupMoreMenus(root)` 接线（点外部 / Esc / 滚动关闭，fixed 定位不被 `.table-scroll` 裁切），视图 `destroy()` 里调 `closeMoreMenu()`（参考 `views/note.js` 编辑器、`views/music.js` 行内操作）。浏览、播放、打开这类高频只读操作仍留在页面上
- 第三方库来源：**npmmirror CDN**（`registry.npmmirror.com/<pkg>/<ver>/files/...`，国内快）；仅 music-metadata / epub.js 无 CDN 产物，自托管于 `public/vendor/`（esbuild 从 agent 依赖打包），视图里用 `loadScriptOnce()` 按需加载；**禁用 jsdelivr（国内慢）与 bootcdn/staticfile（2024 投毒事件）**
- **右上角全局操作区**：`index.html` 的 `#top-actions`（桌面端固定浮在内容右上角、手机端排在顶栏右侧）只放全站通用的**次要**操作——音乐快捷播放（`lib.js` 的 `setupQuickMusic()`）、主题开关（`setupTheme()`）这类图标按钮，不要往里塞页面操作；页面自己的主操作（「播放全部」「上传」等）仍留在 `.page-head .page-actions`，桌面端 `.page-head` / `.reader-bar` 已预留 92px 内边距避免被浮动区压住
- **编码红线：改 public/ 下的 HTML/JS/CSS 一律用编辑工具或 Node 脚本（readFileSync/writeFileSync utf8）；严禁 PowerShell Get-Content/Set-Content**——中文 Windows 默认 GBK 会把 UTF-8 中文写成乱码（已踩坑并污染过一次提交）

## agent 约定

- **永久单 Agent**：正式环境只运行一个 Agent；不实现多 Agent 竞争、备用节点自动接管或调度选举。故障由人工恢复。
- **远程脚本运行时**：业务脚本以原生 JavaScript 远程发布，由 Agent 同步后动态执行；脚本不是编译进 Agent 镜像的静态 handler。源码按不可变版本位于 `worker/agent-scripts/<id>/<version>.mjs`，经 PR 审查后由 Worker release 生成静态 Assets manifest/版本化内容；脚本头部 JSON metadata 声明 `id/name/version/description/schedule/enabled/timeout/reliability`。发布脚本是公开静态资源，不得包含任何凭据。
- **脚本是可信代码**：第一版不做沙箱，脚本在 Agent Node.js 进程内执行，拥有宿主进程权限。只能执行经过仓库 PR 审查和可信发布链路发布的脚本；SHA-256 只校验内容一致性，不证明发布者身份。任务 payload 只能包含数据，绝不能携带代码、表达式或可执行模块。
- **脚本同步先于执行**：Agent 请求 `POST /node/agent/next` 时上报本地脚本清单（id/version/SHA-256）；Worker 返回更新/删除清单。Agent 验证 SHA-256/metadata 后写临时文件并原子 rename，再请求同一接口二次对账；每轮旧任务领取前先同步，未通过对账不得领取或执行任务。
- **不动态安装依赖**：Agent 镜像预装脚本所需第三方依赖；远程脚本不得运行时 npm install。远程 ES Module 对镜像内依赖的解析方式必须有自动化验证。
- **可靠性由脚本声明**：`best_effort` 适用于新闻 RSS 等可丢失任务，错过触发丢弃、失败不强制重试；`reliable` 适用于知识星球等重要同步，支持失败重试、启动补偿、业务游标和断点续跑。第一版不实现 strict。
- **调度约定**：Agent 本地执行 6 字段 Cron，固定 `Asia/Shanghai`。同一脚本不并发；普通 Cron 触发遇到正在执行的同脚本时跳过，不排队。reliable 的恢复/补偿是已有逻辑执行的恢复，不机械回放每个错过的 Cron 时间槽。
- **执行语义**：脚本必须幂等；系统按至少一次语义设计，不承诺 exactly-once。重试沿用同一个 `execution_id` 和创建时固定的脚本版本。Agent 崩溃后无法确认副作用结果时记录为 interrupted/unknown，再按业务幂等策略恢复。
- **职责边界**：Agent 负责脚本同步、Cron 触发、执行和结果回传；Worker/D1 是脚本发布清单、执行许可、执行记录、租约和结果状态的权威。Worker 不负责业务脚本 Cron 计算；Worker 内部清理、邮件扫描等基础设施 tick 仍可保留。
- **统一 context**：远程模块导出 `async run(ctx, payload)`，返回 `{items, summary}`；context 提供 logger/config/受控 fetch/signal/executionId/scriptId/scriptVersion/scheduledAt。timeout 是 AbortSignal 协作式超时，不是硬 CPU 隔离；同进程脚本仍可绕过 context 访问宿主权限，不能把 context 误认为安全沙箱。
- **节点身份与凭据**：节点密钥仍由后台生成，通过 compose 的 `NODE_KEY` 注入；第三方 token / API Key 存 D1 参数中心，按任务/脚本需要注入。节点密钥不能写入脚本缓存、脚本 metadata、日志或结果。
- 出站 fetch 一律挂取消/超时信号并遵守 SSRF 守卫；默认拒绝内网/环回地址。

## 发布（CI）

- **普通 push 不部署**：线上发布由 Git tag 驱动（`.github/workflows/release.yml`）
- PR 合并到 `main` 后，`.github/workflows/auto-tag.yml` 自动对最新稳定 `vX.Y.Z` 递增 patch，将 tag 指向 PR merge commit，再通过 `workflow_dispatch` 显式触发 release workflow
- 手动 push `vX.Y.Z` tag 也直接触发 release workflow；tag 必须指向 `main` 上的提交
- release workflow 执行：类型检查 + `deploy:dry` → D1 `migrations apply --remote` → `wrangler deploy` → 仅 `agent/` 有 diff 时构建镜像
- 发布成功后自动创建 GitHub Release（生成 release notes）；已有 release 时幂等跳过
- 默认 `GITHUB_TOKEN` 创建的 tag 不会触发另一个 push workflow，因此 auto-tag workflow 显式调用 release workflow 的 `workflow_dispatch`
- auto-tag workflow 需要 `contents: write`、`actions: write`；release workflow 需要 `contents: write`、`packages: write`
- agent 镜像标签：发布 tag + `v<sha>` + `:latest`；仅 agent 有变化时推镜像并回写 D1 `agent_latest_version`
- 纯 Worker 发布不重推 `:latest`；D1 迁移必须向后兼容（expand/contract）
- 具体发布与回滚见 `README.md`「发布到线上」
