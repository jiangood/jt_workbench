/** 共享层：图标 / 信封 API / 原生弹窗 / 转义 / 脚本懒加载 / 常驻播放器 / 布局辅助 */

/* 图标集：24×24 线性图标，继承 currentColor，无外部字体依赖 */
const ICONS = {
  dashboard:
    '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  news: '<path d="M4 5h10a2 2 0 0 1 2 2v12H6a2 2 0 0 1-2-2V5Z"/><path d="M16 8h2a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-2"/><path d="M7 8h6M7 11h6M7 14h4"/>',
  stock: '<path d="m3 17 6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
  bell: '<path d="M6 9a6 6 0 1 1 12 0c0 3.5 1.2 4.8 1.8 5.7.2.3 0 .8-.4.8H4.6c-.4 0-.6-.5-.4-.8C4.8 13.8 6 12.5 6 9Z"/><path d="M10 19a2 2 0 0 0 4 0"/>',
  note: '<path d="M6 3h9a2 2 0 0 1 2 2v14H8a2 2 0 0 1-2-2V3Z"/><path d="M6 3v16"/><path d="M10 8h4M10 12h4"/>',
  music: '<path d="M9 18V6l10-2v12"/><circle cx="6" cy="18" r="3"/><circle cx="16" cy="18" r="2.5"/>',
  book: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v14H6.5A2.5 2.5 0 0 0 4 19.5V5.5Z"/><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20v4H6.5"/>',
  star: '<circle cx="12" cy="12" r="9"/><path d="m12 7.5 1.5 3 3 1.5-3 1.5-1.5 3-1.5-3-3-1.5 3-1.5 1.5-3Z"/>',
  gear: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v2.6M12 18.9v2.6M2.5 12h2.6M18.9 12h2.6M5.3 5.3l1.9 1.9M16.8 16.8l1.9 1.9M18.7 5.3l-1.9 1.9M7.2 16.8l-1.9 1.9"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  close: '<path d="M6 6 18 18M18 6 6 18"/>',
  upload: '<path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4.5V11h-6.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  trash: '<path d="M4 7h16"/><path d="M9.5 7V4.5h5V7"/><path d="m6.5 7 1 13h9l1-13"/>',
  alert: '<path d="M12 4 2.7 20h18.6L12 4Z"/><path d="M12 10v4"/><path d="M12 17.3v.2"/>',
  online: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  offline: '<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  moon: '<path d="M20.5 14.3A8.5 8.5 0 1 1 9.7 3.5a7 7 0 0 0 10.8 10.8Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.4 5.4l1.4 1.4M17.2 17.2l1.4 1.4M18.6 5.4l-1.4 1.4M6.8 17.2l-1.4 1.4"/>',
  paperclip: '<path d="m20.5 11.6-8.2 8.2a4.7 4.7 0 0 1-6.6-6.6l8.5-8.5a3.1 3.1 0 0 1 4.4 4.4l-8.5 8.5a1.6 1.6 0 0 1-2.2-2.2l7.7-7.7"/>',
}

/** icon('news', 16) → 内联 SVG 字符串（装饰性，aria-hidden） */
export function icon(name, size = 16, cls = '') {
  const body = ICONS[name]
  if (!body) return ''
  return `<svg class="ico ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`
}

/** 信封 API 调用：401 → 跳登录；非 0 code → 抛错（message 为服务端文案） */
export async function api(path, options = {}) {
  const res = await fetch(path, {
    cache: 'no-store',
    headers: { 'content-type': 'application/json' },
    ...options,
  })
  if (res.status === 401) {
    location.href = '/login'
    throw new Error('未登录')
  }
  const env = await res.json().catch(() => ({ code: res.status, data: null, message: res.statusText }))
  if (env.code !== 0) throw new Error(env.message || `HTTP ${res.status}`)
  return env.data
}

export const fmtTime = (ts) => (ts ? new Date(ts).toLocaleString() : '—')

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

/** HTML 转义：拼进 innerHTML / 属性值的动态内容一律过一遍 */
export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ESC_MAP[c])
}

/* ---------------- 反馈：toast / 按钮 loading ---------------- */

let toastEl = null
let toastTimer = 0

/** 短暂提示：3.2s 自动消失（失败 5s）。弹窗打开时挂进 dialog，否则会被遮罩盖住 */
export function toast(message, bad = false) {
  if (!toastEl) {
    toastEl = document.createElement('div')
    toastEl.className = 'toast'
    toastEl.setAttribute('role', 'status')
    toastEl.setAttribute('aria-live', 'polite')
  }
  const dlg = document.getElementById('dlg')
  const host = dlg?.open ? dlg : document.body
  if (toastEl.parentElement !== host) host.append(toastEl)
  toastEl.textContent = message
  toastEl.classList.toggle('is-bad', bad)
  toastEl.dataset.show = '1'
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toastEl.dataset.show = '' }, bad ? 5000 : 3200)
}

/**
 * 视图内重绘：路由只兜首次 render，视图自己调的 render()/refreshList() 失败会变成
 * unhandled rejection。统一走 toast 兜底。
 */
export function rerender(renderFn, main) {
  return Promise.resolve()
    .then(() => renderFn(main))
    .catch((err) => toast(err?.message || '刷新失败', true))
}

/**
 * 包一层异步动作：按钮进 loading（不变宽、不丢图标）+ 失败统一 toast。
 * 返回 { ok: true, data } 或 { ok: false, error }，调用方用 `if (!res.ok) return` 收尾。
 */
export async function run(btn, fn) {
  const el = btn instanceof Element ? btn : null
  const wasDisabled = el && 'disabled' in el ? el.disabled : false
  if (el) {
    el.classList.add('is-busy')
    el.setAttribute('aria-busy', 'true')
    if ('disabled' in el) el.disabled = true
  }
  try {
    return { ok: true, data: await fn() }
  } catch (err) {
    toast(err?.message || '操作失败', true)
    return { ok: false, error: err }
  } finally {
    if (el) {
      el.classList.remove('is-busy')
      el.removeAttribute('aria-busy')
      if ('disabled' in el) el.disabled = wasDisabled
    }
  }
}

/**
 * 原生 <dialog> 弹窗：showDialog(html, { xl, label })。
 * html 为空时保留 #dlg-body 现有内容。
 * 可访问名称优先取正文第一个标题，无标题时退回 opts.label（原生 dialog 不会自动命名）。
 */
export function showDialog(html, opts = {}) {
  const dlg = document.getElementById('dlg')
  dlg.className = opts.xl ? 'xl' : ''
  const body = document.getElementById('dlg-body')
  if (typeof html === 'string' && html.trim()) body.innerHTML = html

  const heading = body.querySelector('h2, h3, h4, h5')
  if (heading) {
    if (!heading.id) heading.id = 'dlg-title'
    dlg.setAttribute('aria-labelledby', heading.id)
    dlg.removeAttribute('aria-label')
  } else {
    dlg.removeAttribute('aria-labelledby')
    if (opts.label) dlg.setAttribute('aria-label', opts.label)
    else dlg.removeAttribute('aria-label')
  }

  if (!dlg.open) dlg.showModal()
  return { close: () => dlg.close(), body }
}

export function closeModal() {
  const dlg = document.getElementById('dlg')
  dlg.className = ''
  if (dlg.open) dlg.close()
}

const scripts = new Map()

/** 第三方库按需加载（同一地址只加载一次），返回 Promise */
export function loadScriptOnce(src) {
  if (!scripts.has(src)) {
    scripts.set(
      src,
      new Promise((resolve, reject) => {
        const el = document.createElement('script')
        el.src = src
        el.onload = () => resolve()
        el.onerror = () => {
          scripts.delete(src)
          reject(new Error(`脚本加载失败：${src}`))
        }
        document.head.appendChild(el)
      }),
    )
  }
  return scripts.get(src)
}

const modules = new Map()

/** ESM 产物按需 import（如 music-metadata 的 vendor 包），返回模块命名空间 */
export function loadModuleOnce(src) {
  if (!modules.has(src)) {
    modules.set(
      src,
      import(src).catch((err) => {
        modules.delete(src)
        throw err
      }),
    )
  }
  return modules.get(src)
}

/** 回到内容顶部：桌面滚 .mainwrap，窄屏 .mainwrap 放开 overflow 时滚 window */
export function scrollToTop() {
  document.getElementById('mainwrap')?.scrollTo({ top: 0 })
  window.scrollTo({ top: 0 })
}

/** 窄屏抽屉导航：汉堡开合 + 遮罩/Esc/跳转关闭；打开时主内容 inert，焦点留在导航内 */
export function setupDrawer() {
  const toggle = document.getElementById('nav-toggle')
  const scrim = document.getElementById('nav-scrim')
  const sidebar = document.getElementById('sidebar')
  if (!toggle || !scrim || !sidebar) return
  const content = document.getElementById('mainwrap')
  const isOpen = () => document.body.classList.contains('nav-open')

  const open = () => {
    document.body.classList.add('nav-open')
    toggle.setAttribute('aria-expanded', 'true')
    toggle.setAttribute('aria-label', '关闭导航')
    if (content) content.inert = true
    sidebar.querySelector('.navlink')?.focus()
  }

  // restoreFocus=false 用于「跳转」和「断点回到桌面」：焦点该交给新视图，不该抢回汉堡键
  const close = (restoreFocus = true) => {
    if (!isOpen()) return
    document.body.classList.remove('nav-open')
    toggle.setAttribute('aria-expanded', 'false')
    toggle.setAttribute('aria-label', '打开导航')
    if (content) content.inert = false
    if (restoreFocus) toggle.focus()
  }

  toggle.addEventListener('click', () => (isOpen() ? close() : open()))
  scrim.addEventListener('click', () => close())
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen()) close()
  })
  document.querySelectorAll('.navlink').forEach((a) => a.addEventListener('click', () => close(false)))
  window.matchMedia('(min-width: 769px)').addEventListener('change', (e) => {
    if (e.matches) close(false)
  })

  const skip = document.querySelector('.skip')
  skip?.addEventListener('click', (e) => {
    e.preventDefault()
    document.getElementById('main')?.focus()
  })
}

/** 主题开关：首屏脚本已定 data-theme，这里只负责按钮、持久化与跟随系统 */
export function setupTheme() {
  const root = document.documentElement
  const sidebar = document.getElementById('sidebar')
  if (!sidebar) return

  sidebar.insertAdjacentHTML(
    'beforeend',
    '<button class="theme-toggle" id="theme-toggle" type="button" aria-pressed="false" aria-label="深色模式"><span class="theme-icon"></span><span>深色模式</span></button>',
  )
  const btn = document.getElementById('theme-toggle')
  const iconSlot = btn.querySelector('.theme-icon')
  const KEY = 'wb-theme'

  const stored = () => {
    try {
      return localStorage.getItem(KEY)
    } catch {
      return null
    }
  }

  const apply = (theme) => {
    const dark = theme === 'dark'
    root.dataset.theme = dark ? 'dark' : 'light'
    btn.setAttribute('aria-pressed', String(dark))
    iconSlot.innerHTML = icon(dark ? 'sun' : 'moon', 18)
  }

  apply(root.dataset.theme === 'dark' ? 'dark' : 'light')

  btn.addEventListener('click', () => {
    const next = root.dataset.theme === 'dark' ? 'light' : 'dark'
    apply(next)
    try {
      localStorage.setItem(KEY, next)
    } catch {
      /* 隐私模式下忽略 */
    }
  })

  // 没显式选过主题时跟随系统切换
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    if (stored()) return
    apply(e.matches ? 'dark' : 'light')
  })
}

/** 弹窗：点遮罩关闭 + 打开时回到顶部 */
export function setupDialog() {
  const dlg = document.getElementById('dlg')
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) dlg.close()
  })
  dlg.addEventListener('close', () => {
    dlg.scrollTop = 0
  })
}

/** 视图内表格套一层滚动容器（窄屏横向滚动），返回停止观察的函数 */
export function setupTableScroll(root) {
  const wrap = () => {
    root.querySelectorAll('table').forEach((t) => {
      if (t.parentElement?.classList.contains('table-scroll')) return
      const box = document.createElement('div')
      box.className = 'table-scroll'
      t.before(box)
      box.append(t)
    })
  }
  const observer = new MutationObserver(wrap)
  observer.observe(root, { childList: true, subtree: true })
  wrap()
  return () => observer.disconnect()
}

const playerListeners = new Set()

function notifyPlayer() {
  playerListeners.forEach((fn) => {
    try {
      fn()
    } catch {
      /* 单个订阅者出错不影响其他 */
    }
  })
}

/** 常驻播放器：audio 与播放条在 shell 里，跨视图不断播 */
export const player = {
  get currentId() {
    const id = document.getElementById('player')?.dataset.id
    return id ? Number(id) : null
  },

  play(id, title) {
    const audio = document.getElementById('player')
    audio.src = `/api/music/play/${id}`
    audio.dataset.id = String(id)
    document.getElementById('np-title').textContent = title || ''
    document.getElementById('player-bar').hidden = false
    audio.play().catch(() => {})
    notifyPlayer()
  },

  stop() {
    const audio = document.getElementById('player')
    if (!audio) return
    audio.pause()
    audio.removeAttribute('src')
    audio.load()
    delete audio.dataset.id
    document.getElementById('player-bar').hidden = true
    document.getElementById('np-title').textContent = ''
    notifyPlayer()
  },

  /** 订阅播放状态变化（切歌/停止），返回取消订阅函数 */
  onChange(fn) {
    playerListeners.add(fn)
    return () => playerListeners.delete(fn)
  },
}
