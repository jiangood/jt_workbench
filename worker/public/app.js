/** SPA 入口：hash 路由 + 侧栏渲染 + 视图生命周期（render / destroy） */
import {
  closeModal,
  esc,
  icon,
  setupDialog,
  setupDrawer,
  setupTableScroll,
  setupTheme,
} from './lib.js'

const ROUTES = [
  { path: '/', title: 'Dashboard', icon: 'dashboard', load: () => import('./views/dashboard.js') },
  { path: '/news', title: 'IT 资讯', icon: 'news', load: () => import('./views/news.js') },
  { path: '/stock', title: '股票', icon: 'stock', load: () => import('./views/stock.js') },
  { path: '/reminder', title: '提醒', icon: 'bell', load: () => import('./views/reminder.js') },
  { path: '/note', title: '笔记', icon: 'note', load: () => import('./views/note.js') },
  { path: '/music', title: '音乐', icon: 'music', load: () => import('./views/music.js') },
  { path: '/book', title: '读书', icon: 'book', load: () => import('./views/book.js') },
  { path: '/zsxq', title: '知识星球', icon: 'star', load: () => import('./views/zsxq.js') },
  { path: '/admin', title: '系统', icon: 'gear', load: () => import('./views/admin.js') },
]

let currentView = null
let ticket = 0
let stopTableScroll = null

function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/'
  const [path, query = ''] = raw.split('?')
  return { path: path || '/', params: Object.fromEntries(new URLSearchParams(query)) }
}

function renderNav() {
  document.getElementById('sidebar').insertAdjacentHTML(
    'beforeend',
    ROUTES.map(
      (r) =>
        `<a class="navlink" data-path="${r.path}" href="#${r.path}">${icon(r.icon)}<span>${r.title}</span></a>`,
    ).join(''),
  )
}

function setActive(path) {
  document.querySelectorAll('.navlink').forEach((a) => {
    const active = a.dataset.path === path
    a.classList.toggle('active', active)
    if (active) a.setAttribute('aria-current', 'page')
    else a.removeAttribute('aria-current')
  })
}

async function render() {
  const seq = ++ticket
  const { path, params } = parseHash()
  const route = ROUTES.find((r) => r.path === path) || ROUTES[0]
  if (route.path !== path) history.replaceState(null, '', `#${route.path}`)

  // 先关弹窗（触发视图的 close 监听），再销毁上一个视图
  closeModal()
  try {
    await currentView?.destroy?.()
  } catch (err) {
    console.error('[view destroy]', err)
  }
  stopTableScroll?.()
  stopTableScroll = null
  currentView = null

  // 每次换一个全新的 <main>：已销毁视图的异步回调写到游离节点上，不会污染新视图
  const host = document.getElementById('view-host')
  host.innerHTML = '<main id="main" tabindex="-1"><div class="muted">加载中…</div></main>'
  const main = host.querySelector('#main')
  stopTableScroll = setupTableScroll(main)
  document.getElementById('mainwrap').scrollTop = 0
  setActive(route.path)
  document.title = `${route.title} · Workbench`

  try {
    const mod = await route.load()
    if (seq !== ticket) return
    currentView = mod.default ?? mod
    main.innerHTML = ''
    await currentView.render(main, params)
  } catch (err) {
    if (seq !== ticket) return
    main.innerHTML = `<div class="alert danger">${icon('alert')}<span>${esc(err?.message || String(err))}</span></div>`
  }
}

renderNav()
setupDrawer()
setupTheme()
setupDialog()
window.addEventListener('hashchange', render)
render()
