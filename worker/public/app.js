/** SPA 入口：hash 路由 + 侧栏渲染 + 视图生命周期（render / destroy） */
import {
  closeModal,
  esc,
  icon,
  scrollToTop,
  setupDialog,
  setupDrawer,
  setupTableScroll,
  setupTheme,
} from './lib.js'

const ROUTES = [
  { path: '/', title: 'Dashboard', icon: 'dashboard', load: () => import('./views/dashboard.js') },
  { path: '/news', title: '资讯', icon: 'news', load: () => import('./views/news.js') },
  // wide: true → 容器放宽到 --container-max-wide（多栏 / 表格 / 图表 / 网格页）；
  // 阅读类页面（首页、资讯、系统）保持 1200px 的舒适行宽
  { path: '/stock', title: '股票', icon: 'stock', wide: true, load: () => import('./views/stock.js') },
  { path: '/reminder', title: '提醒', icon: 'bell', wide: true, load: () => import('./views/reminder.js') },
  { path: '/note', title: '笔记', icon: 'note', wide: true, load: () => import('./views/note.js') },
  { path: '/music', title: '音乐', icon: 'music', wide: true, load: () => import('./views/music.js') },
  { path: '/book', title: '书架', icon: 'book', wide: true, load: () => import('./views/book.js') },
  // 阅读页：独立路由不进侧栏，入口是书架卡片的「阅读」；activePath 让侧栏继续高亮「书架」
  {
    path: '/reader',
    title: '阅读',
    icon: 'book',
    wide: true,
    hidden: true,
    activePath: '/book',
    load: () => import('./views/reader.js'),
  },
  { path: '/zsxq', title: '知识星球', icon: 'star', wide: true, load: () => import('./views/zsxq.js') },
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
    ROUTES.filter((r) => !r.hidden)
      .map((r) => `<a class="navlink" data-path="${r.path}" href="#${r.path}">${icon(r.icon)}<span>${r.title}</span></a>`)
      .join(''),
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

let isFirstRender = true

async function render() {
  const seq = ++ticket
  const initial = isFirstRender
  isFirstRender = false
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
  // 路由级宽度：只有标记 wide 的页面放宽，其余保持阅读宽度
  host.classList.toggle('container-wide', route.wide === true)
  host.innerHTML = '<main id="main" tabindex="-1"><div class="muted">加载中…</div></main>'
  const main = host.querySelector('#main')
  stopTableScroll = setupTableScroll(main)
  scrollToTop()
  setActive(route.activePath || route.path)
  document.title = `${route.title} · 个人工作台`

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

  // 路由切换后把焦点交给主内容：键盘用户不必从头 Tab，抽屉跳转也靠这里收尾
  // 首次渲染（刷新/首次打开）不抢焦点：脚本聚焦会让 #main 在 Chrome 命中原生 :focus-visible，
  // 整页内容区出现一圈焦点框，直到点击空白处失焦才消失
  if (seq === ticket && !initial) main.focus({ preventScroll: true })
}

renderNav()
setupDrawer()
setupTheme()
setupDialog()
window.addEventListener('hashchange', render)
render()
