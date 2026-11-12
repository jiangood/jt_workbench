import { Hono } from 'hono'
import { node } from './core/node'
import { authMiddleware, authStatus, login, logout, setup } from './core/auth'
import { onError, ok, notFound, type Env } from './core/envelope'
import { cacheGet, cacheSet } from './core/cache'
import { news } from './modules/news'
import { stock } from './modules/stock'
import { reminder } from './modules/reminder'
import { note } from './modules/note'
import { music } from './modules/music'
import { book } from './modules/book'
import { zsxq } from './modules/zsxq'
import { admin } from './modules/admin'
import { serveInstallScript } from './core/install'

const app = new Hono<Env>()

app.onError((err) => onError(err))
app.notFound(notFound)

// ---------- 安全响应头（issue #21）----------
// 静态页走 assets 层，由 public/_headers 下发同一份策略；改这里要同步改那边。
//
// 策略依据（public/ 全量外链核查结果）：
// - script / style / 库全部自托管（/vendor），没有任何 CDN；内联只有 index.html / login.html 首屏定主题那两段
//   <script>，以及各视图里的 style="…" 属性 —— 零构建不引入脚本哈希，故 script-src / style-src 放 'unsafe-inline'
// - img：news 正文是 RSS 原文经 DOMPurify 消毒后注入，可能带原文站的 <img>（https）；epub 内嵌图片是 blob:
// - font：epub.js 把书内资源转成 blob URL；media：音乐走 /api/music/play/:id（self）
// - connect：所有请求都是同源 /api/*；epub.js 内部资源也可能 fetch(blob:)
// - 没有 web worker，worker-src 只是给 blob 兜底
// - 书籍只有 EPUB：阅读器用 fetch() 取整本，不再把 /api/book/read/:id 嵌进 iframe，故 object-src / frame-ancestors 一律关死
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self' blob:",
  "frame-src 'self' blob: data:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ')

// 注册在旧链接重定向之前：301 响应也要带安全头
app.use('*', async (c, next) => {
  await next()
  c.header('content-security-policy', CSP)
  // 不加 includeSubDomains / preload：同一 zone 下还有另一个项目，避免把 HSTS 强加到它的子域
  c.header('strict-transport-security', 'max-age=31536000')
  c.header('x-content-type-options', 'nosniff')
  c.header('referrer-policy', 'same-origin')
  c.header('x-frame-options', 'DENY')
})

// 旧的多页链接 → SPA hash 路由（页面文件已删，请求落到 Worker）
const LEGACY_PAGES: Record<string, string> = {
  '/index.html': '/',
  '/news.html': '/#/news',
  '/stock.html': '/#/stock',
  '/reminder.html': '/#/reminder',
  '/note.html': '/#/note',
  '/music.html': '/#/music',
  '/book.html': '/#/book',
  '/zsxq.html': '/#/zsxq',
  '/admin.html': '/#/admin',
}

app.use('*', async (c, next) => {
  const target = LEGACY_PAGES[c.req.path]
  if (target) return c.redirect(target, 301)
  await next()
})

app.route('/node', node)

// 节点一键接入脚本（公开：URL 里的 key 即 node_registry 的节点密钥，不依赖登录态）
app.get('/install/:file', serveInstallScript)

// ---------- 认证 ----------

// 公开端点：必须注册在 authMiddleware 之前（登录页拿初始化状态 / 首访建凭据）
app.get('/api/auth/status', authStatus)
app.post('/api/setup', setup)
app.post('/api/login', login)
app.post('/api/logout', logout)

app.get('/api/health', async (c) => {
  let uptime = await cacheGet(c.env.DB, 'health:ts')
  if (!uptime) {
    uptime = String(Date.now())
    await cacheSet(c.env.DB, 'health:ts', uptime, 60_000) // 60s TTL
  }
  return ok({ ok: true, bootedAt: Number(uptime) })
})

app.use('/api/*', authMiddleware)

app.route('/api/news', news)
app.route('/api/stock', stock)
app.route('/api/reminder', reminder)
app.route('/api/note', note)
app.route('/api/music', music)
app.route('/api/book', book)
app.route('/api/zsxq', zsxq)
app.route('/api/admin', admin)

app.get('/api/me', (c) => ok({ username: c.get('user') }))

export default app
