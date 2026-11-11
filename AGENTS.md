# 项目约定（workbench-cf）

个人工作台的 Cloudflare 免费版重写：Worker（控制面 + 存储面）+ 局域网执行节点 agent。
方案文档（唯一事实源）：`C:\Users\water\.opencode\plan\cloudflare-migration.md`。

## 布局

- `worker/`：Cloudflare Worker（Hono + D1 + R2），静态页 + API + 节点协议
- `agent/`：局域网执行节点（Node 22 + TypeScript + esbuild 单文件，容器化部署）
- **两棵依赖树各自独立**：`worker/package-lock.json` 与 `agent/package-lock.json` 各自提交，禁止顺手改对方的依赖版本
- 参考旧项目：`D:\ws\workbench`（只读——Java 源码 / `application.yml` 业务参数 / `WorkbenchDataInitializer.java` 的 seed cron）

## Git

- 一切在 `main` 分支直接开发，不新建分支

## Worker 代码分层

- `worker/core/` 是唯一能碰 env / D1 / R2 底层的框架层；`modules/` 业务模块只能经由 core 访问
- API 统一返回自定义 JSON 信封 `{code, data, message}`；`onError` 统一兜底
- D1：时间统一 epoch 毫秒 `INTEGER`；布尔 `0/1`；JSON 列 `TEXT`；多语句写入用 `batch()`（自带事务）；索引单独 `CREATE INDEX`，不写进 CREATE TABLE；建表走 `wrangler d1 migrations`
- 分工红线（决策 #14）：**Worker 只做简单计算与展示**——循环 / 批量 / 抓取 / 解析类逻辑一律放 agent；浏览器承担展示类计算（DOMPurify / music-metadata / JSZip / lunar）
- 前端 = **零构建 SPA（hash 路由）**：`public/index.html` 只是 shell（侧栏/播放条/弹窗），
  `app.js` 管路由，`views/*.js` 是视图（ES module，各自导出 `render(main, params)` / `destroy()`）；
  `lib.js` 提供 api / 图标 / 弹窗 / 转义 / 脚本懒加载 / 常驻播放器。无框架、无前端构建、无 TS
- 视图生命周期红线：切页前 router 先关弹窗再调 `destroy()`——Chart 实例、epub book、定时器、事件监听必须在 `destroy()` 里释放
- 旧素材引用（`/news.html` 等）由 `index.ts` 的 `LEGACY_PAGES` 301 到 `/#/news`；新增视图记得同步路由表与旧链接映射
- 样式 = 自写 `public/app.css`（design tokens + dark 主题 + 移动端抽屉，无 bootstrap）；弹窗用原生 `<dialog>`（`lib.js` 的 `showDialog/closeModal`），窄屏表格由 `setupTableScroll` 自动包 `.table-scroll`
- 第三方库来源：**npmmirror CDN**（`registry.npmmirror.com/<pkg>/<ver>/files/...`，国内快）；仅 music-metadata / epub.js 无 CDN 产物，自托管于 `public/vendor/`（esbuild 从 agent 依赖打包），视图里用 `loadScriptOnce()` 按需加载；**禁用 jsdelivr（国内慢）与 bootcdn/staticfile（2024 投毒事件）**
- **编码红线：改 public/ 下的 HTML/JS/CSS 一律用编辑工具或 Node 脚本（readFileSync/writeFileSync utf8）；严禁 PowerShell Get-Content/Set-Content**——中文 Windows 默认 GBK 会把 UTF-8 中文写成乱码（已踩坑并污染过一次提交）

## agent 约定

- 哑执行器：**任务 = 数据不是代码**（type 只是查表键，不执行任何来自网络的代码）
- 不动态安装依赖；工具箱（cheerio / music-metadata / jszip 等）编译期预装进镜像
- env 仅 4 个：`WORKER_URL`、`NODE_ID`、`NODE_KEY` 必填，`POLL_INTERVAL=600` 可选
- 出站 fetch 一律挂 `AbortSignal.timeout(30s)`；SSRF 守卫默认拒绝内网/环回地址
- 一次只持一个任务；本地队列已删除（v4.9 领 1 + 捎带下发）

## CI

- `deploy.yml` / `agent-image.yml` 均带 `paths` 过滤：不碰对方目录不触发
- agent 镜像双标签（`v<sha>` 不可变 + `:latest`），自动升级的安全性由 CI 门禁保证
