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

- 一切在 `main` 分支直接开发，不新建分支

## 生产环境（红线）

- **禁止直接操作生产环境**：本地 / 终端不对线上执行任何写操作——`wrangler deploy`、`wrangler d1 execute|migrations apply --remote`、R2 写入、生产 API 的写请求、`wrangler rollback` 一律不做
- **线上变更唯一入口 = GitHub 发布 Release**（`.github/workflows/release.yml`）；push 不部署，也没有手动触发
- 本地只允许 `wrangler dev`（local 模式）、`npm run check`、`npm run deploy:dry`（只打包预检）；`npm run deploy` 由 `worker/scripts/guard-deploy.mjs` 拦截（要求 `CI=true`），不要绕过
- 只读排查可以做，但不触发写；需要动生产数据时，把动作写进迁移或让用户走发布流程

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

- 哑执行器：**任务 = 数据不是代码**（type 只是查表键，不执行任何来自网络的代码）
- 不动态安装依赖；工具箱（cheerio / music-metadata / jszip 等）编译期预装进镜像
- **节点身份不靠 ID，密钥由后台生成**：Worker 地址走启动参数（compose 的 `command`）；后台「添加节点」直接把记录写进 `node_registry`（接入前显示离线）并生成 `curl | sh` 接入命令（`GET /install/<key>.sh`，长期有效；现场不能马上接入也没关系），脚本在当前目录创建 `workbench-agent/docker-compose.yml` 并把密钥写进 `NODE_KEY`；`POLL_INTERVAL=600` 仅调试可选
- **密钥不在页面展示**：`/api/admin/nodes` 不返回 `node_key`，取密钥只能从该行「查看接入方式」弹窗的 compose 里拿；换密钥点「重置密钥」（`POST /api/admin/nodes/:name/rotate-key`）——旧密钥立即失效、心跳行删除（立刻显示离线），随后用新接入命令重装（命令自带 `WORKBENCH_AGENT_FORCE=1`）
- **密钥一律不进 agent 环境变量**（例外只有两个，均由安装脚本写进 compose：节点自身的 `NODE_KEY`，以及同机 Watchtower 的 `WATCHTOWER_TOKEN`——随机生成、只走 compose 内网做即时升级，不落 D1）：与 Worker 同一条红线——第三方 token / API Key 存 D1（`app_config` + `CONFIG_FIELDS`），Worker 下发任务时注入 payload，agent 只读 `payload` 里的值（例：`zsxq_sync` 的 token）
- 出站 fetch 一律挂 `AbortSignal.timeout(30s)`；SSRF 守卫默认拒绝内网/环回地址
- 一次只持一个任务（领 1 + 捎带下发）；本地队列已删除

## 发布（CI）

- **push 不部署**：`main` 上直接开发，push 只进版本库；线上只由 `release.yml` 在 GitHub Release 发布时变更
- `release.yml` 流程：校验 release tag 在 `main` 上 → `check` + `deploy:dry` → `wrangler d1 migrations apply --remote` → `wrangler deploy` → 仅 `agent/` 有 diff 时构建镜像
- agent 镜像打三个标签：发布 tag（可追溯）+ `v<sha>`（不可变回滚锚点）+ `:latest`（Watchtower 轮询目标）；agent 有变更时把发布 tag（去前缀 `v`）烧进镜像并回写 D1 `agent_latest_version`，节点空闲即触发 Watchtower 即时升级，15min 轮询保留兜底
- 纯 Worker 发布不重推 `latest`，避免所有节点无意义重启
- 迁移必须向后兼容（expand/contract）：D1 只能向前，Worker 回滚不会回滚 schema
- 首次初始化（订阅源 / 抓取任务 / 屏蔽词）在 `0013_seed_news.sql` 迁移里，不手工执行
- 具体步骤、token 配置与回滚见 `README.md`「发布到线上」
