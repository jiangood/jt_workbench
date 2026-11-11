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
