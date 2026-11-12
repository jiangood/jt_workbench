/** 共享层：图标 / 信封 API / 原生弹窗 / 转义 / 脚本懒加载 / 常驻播放器 / 布局辅助 */

/* 图标集：24×24 线性图标，继承 currentColor，无外部字体依赖 */
const ICONS = {
  dashboard:
    '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  news: '<path d="M4 5h10a2 2 0 0 1 2 2v12H6a2 2 0 0 1-2-2V5Z"/><path d="M16 8h2a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-2"/><path d="M7 8h6M7 11h6M7 14h4"/>',
  stock: '<path d="m3 17 6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
  bell: '<path d="M6 9a6 6 0 1 1 12 0c0 3.5 1.2 4.8 1.8 5.7.2.3 0 .8-.4.8H4.6c-.4 0-.6-.5-.4-.8C4.8 13.8 6 12.5 6 9Z"/><path d="M10 19a2 2 0 0 0 4 0"/>',
  note: '<path d="M6 3h9a2 2 0 0 1 2 2v14H8a2 2 0 0 1-2-2V3Z"/><path d="M6 3v16"/><path d="M10 8h4M10 12h4"/>',
  folder: '<path d="M3 6.5A2.5 2.5 0 0 1 5.5 4h3.6a2 2 0 0 1 1.6.8l.9 1.2h7A2.5 2.5 0 0 1 21 8.5v9a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5v-11Z"/><path d="M3 9h18"/>',
  music: '<path d="M9 18V6l10-2v12"/><circle cx="6" cy="18" r="3"/><circle cx="16" cy="18" r="2.5"/>',
  book: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v14H6.5A2.5 2.5 0 0 0 4 19.5V5.5Z"/><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20v4H6.5"/>',
  bookmark: '<path d="M6 3.5A1.5 1.5 0 0 1 7.5 2h9A1.5 1.5 0 0 1 18 3.5V21l-6-4.5L6 21V3.5Z"/>',
  volume: '<path d="M11 5 6 9H3v6h3l5 4V5Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/>',
  star: '<circle cx="12" cy="12" r="9"/><path d="m12 7.5 1.5 3 3 1.5-3 1.5-1.5 3-1.5-3-3-1.5 3-1.5 1.5-3Z"/>',
  gear: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v2.6M12 18.9v2.6M2.5 12h2.6M18.9 12h2.6M5.3 5.3l1.9 1.9M16.8 16.8l1.9 1.9M18.7 5.3l-1.9 1.9M7.2 16.8l-1.9 1.9"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  close: '<path d="M6 6 18 18M18 6 6 18"/>',
  upload: '<path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4.5V11h-6.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  edit: '<path d="M4 20h4l10-10a2.8 2.8 0 0 0-4-4L4 16v4Z"/><path d="m13.5 6.5 4 4"/>',
  external: '<path d="M14 4h6v6"/><path d="M20 4 11 13"/><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/>',
  trash: '<path d="M4 7h16"/><path d="M9.5 7V4.5h5V7"/><path d="m6.5 7 1 13h9l1-13"/>',
  alert: '<path d="M12 4 2.7 20h18.6L12 4Z"/><path d="M12 10v4"/><path d="M12 17.3v.2"/>',
  online: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  offline: '<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 10h18"/>',
  moon: '<path d="M20.5 14.3A8.5 8.5 0 1 1 9.7 3.5a7 7 0 0 0 10.8 10.8Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.4 5.4l1.4 1.4M17.2 17.2l1.4 1.4M18.6 5.4l-1.4 1.4M6.8 17.2l-1.4 1.4"/>',
  paperclip: '<path d="m20.5 11.6-8.2 8.2a4.7 4.7 0 0 1-6.6-6.6l8.5-8.5a3.1 3.1 0 0 1 4.4 4.4l-8.5 8.5a1.6 1.6 0 0 1-2.2-2.2l7.7-7.7"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  more: '<circle cx="12" cy="5" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="12" cy="19" r="1.3"/>',
  download: '<path d="M12 4v12"/><path d="m7 11 5 5 5-5"/><path d="M4 20h16"/>',
  play: '<path d="M7 4.5v15l12-7.5-12-7.5Z"/>',
  pause:
    '<rect x="8" y="5" width="3" height="14" rx="1" fill="currentColor" stroke="none"/><rect x="13" y="5" width="3" height="14" rx="1" fill="currentColor" stroke="none"/>',
  prev: '<path d="M18 5v14L8 12l10-7Z"/><path d="M6 5v14"/>',
  next: '<path d="M6 5v14l10-7L6 5Z"/><path d="M18 5v14"/>',
  order: '<path d="M4 6h11M4 12h11M4 18h7"/><path d="M18 9v9"/><path d="m15 15 3 3 3-3"/>',
  repeat: '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
  repeatOne: '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/><path d="M11.5 10.5h1V14"/>',
  shuffle: '<path d="M16 3h5v5"/><path d="M4 20 21 3"/><path d="M21 16v5h-5"/><path d="m15 15 6 6"/><path d="m4 4 5 5"/>',
  queue: '<path d="M9 6h12M9 12h12M9 18h12"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>',
}

/** icon('news', 16) → 内联 SVG 字符串（装饰性，aria-hidden） */
export function icon(name, size = 16, cls = '') {
  const body = ICONS[name]
  if (!body) return ''
  return `<svg class="ico ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`
}

/** 默认超时：网络挂起时宁可报错给「重试」，也不要永久停在「加载中」 */
const API_TIMEOUT = 30_000

/**
 * 信封 API 调用：401 → 跳登录；非 0 code → 抛错（message 为服务端文案）。
 * 默认 30s 超时，可用 { timeout: ms } 单独放宽（如豆瓣同步这类慢接口）。
 */
export async function api(path, options = {}) {
  const { timeout = API_TIMEOUT, signal, ...rest } = options
  let res
  try {
    res = await fetch(path, {
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      ...rest,
      signal: signal ?? AbortSignal.timeout(timeout),
    })
  } catch (err) {
    if (err?.name === 'TimeoutError') throw new Error(`请求超时（${Math.round(timeout / 1000)}s），请稍后重试`)
    throw err
  }
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
 * 重绘后把焦点还给同一个元素（用 data-focus-key 标记）：
 * 筛选 / 翻页这类「原地换数据」的交互，焦点不该掉回 <body>。
 */
export function rerenderKeepingFocus(renderFn, main) {
  const key = document.activeElement?.closest?.('[data-focus-key]')?.getAttribute('data-focus-key')
  return rerender(renderFn, main).then(() => {
    if (!key) return
    const next = [...main.querySelectorAll('[data-focus-key]')].find((el) => el.dataset.focusKey === key)
    next?.focus({ preventScroll: true })
  })
}

/**
 * 包一层异步动作：按钮进 loading（不变宽、不丢图标）+ 失败统一 toast。
 * opts.silent：失败不 toast（调用方自己用行内提示，避免重复报错）。
 * 返回 { ok: true, data } 或 { ok: false, error }，调用方用 `if (!res.ok) return` 收尾。
 */
export async function run(btn, fn, opts = {}) {
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
    if (!opts.silent) toast(err?.message || '操作失败', true)
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

/** 触发浏览器下载内存中的文本（Markdown / CSV / JSON 等导出） */
export function downloadText(filename, text, mime = 'text/plain;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([text], { type: mime }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.rel = 'noopener'
  a.style.display = 'none'
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

/* ---------------- 本地阅读统计（issue #23） ---------------- */

/**
 * 每本书在本机的累计阅读时长（毫秒）。只存 localStorage，不上报、不做跨设备合并：
 * 统计口径是「EPUB 阅读页可见且有交互」的净时长，切后台 / 闲置不计。
 */
const BOOK_STATS_PREFIX = 'book:stats:'

export function readBookStats(id) {
  try {
    const raw = JSON.parse(localStorage.getItem(BOOK_STATS_PREFIX + id) || 'null')
    return raw && typeof raw === 'object'
      ? { ms: Math.max(0, Number(raw.ms) || 0), last: Math.max(0, Number(raw.last) || 0) }
      : { ms: 0, last: 0 }
  } catch {
    return { ms: 0, last: 0 }
  }
}

/** 累加阅读时长（不足 1 秒不写，避免频繁触发 localStorage 写入）；返回最新统计 */
export function addBookReadTime(id, ms) {
  const add = Math.round(Number(ms) || 0)
  if (add < 1000) return readBookStats(id)
  const next = { ms: readBookStats(id).ms + add, last: Date.now() }
  try {
    localStorage.setItem(BOOK_STATS_PREFIX + id, JSON.stringify(next))
  } catch {
    /* 隐私模式 / 配额满：统计失败不影响阅读 */
  }
  return next
}

/** 阅读时长文案：< 1 分钟不显示，< 1 小时按分钟，超过按小时（1 位小数） */
export function fmtReadTime(ms) {
  const min = Math.floor((Number(ms) || 0) / 60_000)
  if (min < 1) return ''
  if (min < 60) return `${min} 分钟`
  const hours = min / 60
  return hours < 10 ? `${hours.toFixed(1)} 小时` : `${Math.round(hours)} 小时`
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

/* ---------------- 主导航：窄屏抽屉 + 宽屏收起 ---------------- */

const NAV_COLLAPSED_KEY = 'wb-nav:collapsed'

/** 用户偏好：桌面导航是否收起（阅读页的自动收起不写这里） */
let navCollapsed = false
/** 本次是否由阅读页自动收起（临时状态，路由离开时还原） */
let navAutoCollapsed = false
let paintNavCollapsed = () => {}

function readNavCollapsed() {
  try {
    return localStorage.getItem(NAV_COLLAPSED_KEY) === '1'
  } catch {
    return false
  }
}

function saveNavCollapsed(on) {
  try {
    localStorage.setItem(NAV_COLLAPSED_KEY, on ? '1' : '0')
  } catch {
    /* 隐私模式 / 配额满：只影响下次打开时的默认状态 */
  }
}

/**
 * 阅读页自动收起主导航：临时状态，不写 localStorage。
 * 用户本来就收起的保持收起；在阅读页里手动切换过，则以手动为准。
 */
export function autoCollapseNav(on) {
  if (on) {
    if (navAutoCollapsed || navCollapsed) return
    navAutoCollapsed = true
    paintNavCollapsed(true)
  } else if (navAutoCollapsed) {
    navAutoCollapsed = false
    paintNavCollapsed(navCollapsed)
  }
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

  // 宽屏收起 / 展开：底部一个折叠按钮（窄屏由 CSS 隐藏，仍走抽屉）
  const foot = document.createElement('div')
  foot.className = 'sidebar-foot'
  foot.innerHTML = `<button class="nav-collapse" type="button" aria-expanded="true" aria-label="收起导航" title="收起导航">${icon('chevron', 14)}<span>收起导航</span></button>`
  sidebar.append(foot)

  const collapseBtn = foot.querySelector('.nav-collapse')
  paintNavCollapsed = (on) => {
    document.body.classList.toggle('nav-collapsed', on)
    collapseBtn.setAttribute('aria-expanded', String(!on))
    collapseBtn.setAttribute('aria-label', on ? '展开导航' : '收起导航')
    collapseBtn.title = on ? '展开导航' : '收起导航'
    const label = collapseBtn.querySelector('span')
    if (label) label.textContent = on ? '展开导航' : '收起导航'
  }

  navCollapsed = readNavCollapsed()
  paintNavCollapsed(navCollapsed)

  collapseBtn.addEventListener('click', () => {
    // 以实际状态为准：阅读页自动收起时 navCollapsed 仍是偏好值，直接取反会点不动
    navCollapsed = !document.body.classList.contains('nav-collapsed')
    navAutoCollapsed = false
    paintNavCollapsed(navCollapsed)
    saveNavCollapsed(navCollapsed)
  })

  const skip = document.querySelector('.skip')
  skip?.addEventListener('click', (e) => {
    e.preventDefault()
    document.getElementById('main')?.focus()
  })
}

/** 主题开关：按钮挂在全站右上角操作区；首屏脚本已定 data-theme，这里只负责图标、持久化与跟随系统 */
export function setupTheme() {
  const root = document.documentElement
  const host = document.getElementById('top-actions')
  if (!host) return

  host.insertAdjacentHTML(
    'beforeend',
    '<button class="theme-toggle" id="theme-toggle" type="button" aria-pressed="false" aria-label="切换到深色模式"><span class="theme-icon"></span></button>',
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
    const label = dark ? '切换到浅色模式' : '切换到深色模式'
    btn.setAttribute('aria-label', label)
    btn.title = label
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

/**
 * 右上角音乐快捷按钮：一键播放 / 暂停，不用先进「音乐」页。
 * - 有队列且在播 → 暂停；队列里停在某首 → 继续播；
 * - 队列为空（首次打开 / 清空过）→ 拉一次列表，从第一首开始播；
 * - 列表也空 → toast 说明，不留「点了没反应」。
 */
export function setupQuickMusic() {
  const host = document.getElementById('top-actions')
  if (!host) return

  host.insertAdjacentHTML(
    'afterbegin',
    '<button class="quick-music" id="quick-music" type="button" aria-label="播放音乐" title="播放音乐"><span class="quick-music-icon"></span></button>',
  )
  const btn = document.getElementById('quick-music')
  const slot = btn.querySelector('.quick-music-icon')
  const audio = audioEl()
  let fetching = false

  const paint = () => {
    const playing = player.isPlaying
    slot.innerHTML = icon(playing ? 'pause' : 'play', 18)
    // 有当前曲目但没在播时，点的是「继续播放」，提示要跟着状态变
    const label = playing ? '暂停音乐' : player.currentId != null ? '继续播放音乐' : '播放音乐'
    btn.setAttribute('aria-label', label)
    btn.title = label
    btn.classList.toggle('is-playing', playing)
  }
  paint()
  player.onChange(paint)
  audio?.addEventListener('play', paint)
  audio?.addEventListener('pause', paint)

  btn.addEventListener('click', async () => {
    if (fetching) return
    if (player.isPlaying) return player.pause()
    if (player.currentId != null) return player.resume()

    // 队列空：按需拉列表（不预取，避免每个页面进来都多一次请求）
    fetching = true
    btn.disabled = true
    btn.setAttribute('aria-busy', 'true')
    try {
      const data = await api('/api/music/list')
      const tracks = (data?.tracks || []).filter((t) => t && t.id != null)
      if (!tracks.length) {
        toast('音乐列表还是空的，先到「音乐」页上传', true)
        return
      }
      player.playQueue(tracks, 0)
    } catch (err) {
      toast(err?.message || '读取音乐列表失败', true)
    } finally {
      fetching = false
      btn.disabled = false
      btn.removeAttribute('aria-busy')
      paint()
    }
  })
}

/** 弹窗：关闭后回到顶部（点遮罩 / 点外部不关闭，只能按 Esc 或显式关闭） */
export function setupDialog() {
  const dlg = document.getElementById('dlg')
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

/* ---------------- 「更多」下拉：删除类操作收进菜单，避免误点 ---------------- */

/** 当前打开的下拉（同一时间只开一个） */
let activeMore = null

/** 关闭当前「更多」下拉：切页 / 重绘 / 滚动时调用，顺手摘掉 document 监听 */
export function closeMoreMenu() {
  if (!activeMore) return
  const { btn, menu, onPointer, onKey, onMove } = activeMore
  activeMore = null
  menu.hidden = true
  menu.classList.remove('is-fixed')
  menu.removeAttribute('style')
  btn.setAttribute('aria-expanded', 'false')
  document.removeEventListener('pointerdown', onPointer, true)
  document.removeEventListener('keydown', onKey)
  window.removeEventListener('scroll', onMove, true)
  window.removeEventListener('resize', onMove)
}

/**
 * 「更多」下拉的 HTML：图标触发按钮 + 菜单容器。
 * items: [{ label, icon, danger, disabled, href, attrs }]，删除 / 清空 / 移除放最后一项并标 danger；
 * 带 href 的项渲染成 <a>（下载这类不需要 JS 的动作）。
 * opts: { label: 按钮可访问名, triggerClass: 触发按钮 class（默认 icon-btn）, iconSize }
 */
export function moreMenu(id, items, opts = {}) {
  const key = esc(id)
  const trigger = opts.triggerClass || 'icon-btn'
  const body = items
    .map((it) => {
      const attrs = Object.entries(it.attrs || {})
        .map(([k, v]) => ` ${k}="${esc(v)}"`)
        .join('')
      const cls = `more-item${it.danger ? ' danger' : ''}`
      const inner = `${it.icon ? icon(it.icon, 14) : ''}${esc(it.label)}`
      if (it.href)
        return `<a class="${cls}" href="${esc(it.href)}" role="menuitem"${
          it.disabled ? ' aria-disabled="true" tabindex="-1"' : ''
        }${attrs}>${inner}</a>`
      return `<button class="${cls}" type="button" role="menuitem"${
        it.disabled ? ' disabled' : ''
      }${attrs}>${inner}</button>`
    })
    .join('')
  return `<span class="more">
    <button class="${trigger}" type="button" data-more="${key}" aria-haspopup="menu" aria-expanded="false"
            aria-label="${esc(opts.label || '更多操作')}">${icon('more', opts.iconSize || 16)}</button>
    <div class="more-menu" id="more-${key}" role="menu" hidden>${body}</div>
  </span>`
}

/** fixed 定位：表格在窄屏是滚动容器，绝对定位的菜单会被裁掉 */
function placeMoreMenu(btn, menu) {
  menu.hidden = false
  menu.classList.add('is-fixed')
  const r = btn.getBoundingClientRect()
  const gap = 4
  const mw = menu.offsetWidth
  const mh = menu.offsetHeight
  const below = r.bottom + gap
  const top = below + mh <= window.innerHeight - 8 ? below : Math.max(8, r.top - gap - mh)
  const left = Math.min(Math.max(8, r.right - mw), window.innerWidth - mw - 8)
  menu.style.top = `${Math.round(top)}px`
  menu.style.left = `${Math.round(left)}px`
}

/**
 * 接线 root 内所有「更多」按钮：点按钮开合，点外部 / Esc / 滚动 / 尺寸变化关闭。
 * 每次重绘后调用一次即可（会先关掉上一个，避免旧节点的监听残留）；
 * 菜单项点击在捕获阶段先关菜单，confirm 取消或报错时不会留下浮层。
 */
export function setupMoreMenus(root) {
  closeMoreMenu()
  root.querySelectorAll('[data-more]').forEach((btn) => {
    const menu = btn.parentElement?.querySelector('.more-menu')
    if (!menu) return
    btn.addEventListener('click', () => {
      if (activeMore?.btn === btn) return closeMoreMenu()
      closeMoreMenu()
      const onPointer = (e) => {
        if (!menu.contains(e.target) && !btn.contains(e.target)) closeMoreMenu()
      }
      const onKey = (e) => {
        if (e.key !== 'Escape') return
        e.stopPropagation()
        closeMoreMenu()
        btn.focus()
      }
      const onMove = () => closeMoreMenu()
      activeMore = { btn, menu, onPointer, onKey, onMove }
      placeMoreMenu(btn, menu)
      btn.setAttribute('aria-expanded', 'true')
      document.addEventListener('pointerdown', onPointer, true)
      document.addEventListener('keydown', onKey)
      window.addEventListener('scroll', onMove, true)
      window.addEventListener('resize', onMove)
      menu.querySelector('.more-item:not([disabled])')?.focus()
    })
    menu.addEventListener(
      'click',
      (e) => {
        if (e.target.closest('.more-item')) closeMoreMenu()
      },
      true,
    )
  })
}

/* ---------------- 常驻播放器：队列 / 播放模式 / 播放列表 ---------------- */

/** localStorage：队列 + 模式跨刷新保留（参考主流音乐平台的「上次队列」） */
const QUEUE_KEY = 'wb-player'

/** 播放模式：顺序（播完即停）→ 列表循环 → 单曲循环 → 随机 */
const PLAY_MODES = [
  { key: 'order', label: '顺序播放', icon: 'order' },
  { key: 'list', label: '列表循环', icon: 'repeat' },
  { key: 'one', label: '单曲循环', icon: 'repeatOne' },
  { key: 'shuffle', label: '随机播放', icon: 'shuffle' },
]

const playerListeners = new Set()
/** 播放队列：[{ id, title, artist, duration }] */
let queue = []
let index = -1
let modeKey = 'order'
let playerReady = false

const audioEl = () => document.getElementById('player')
const modeDef = (key = modeKey) => PLAY_MODES.find((m) => m.key === key) ?? PLAY_MODES[0]

/** 秒 → m:ss；无效值留给调用方显示占位符 */
export function fmtDuration(seconds) {
  const s = Math.round(Number(seconds))
  if (!Number.isFinite(s) || s <= 0) return ''
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function notifyPlayer() {
  playerListeners.forEach((fn) => {
    try {
      fn()
    } catch {
      /* 单个订阅者出错不影响其他 */
    }
  })
}

function persist() {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify({ mode: modeKey, index, queue }))
  } catch {
    /* 隐私模式 / 配额满：缓存失败不影响播放 */
  }
}

function readPersisted() {
  try {
    return JSON.parse(localStorage.getItem(QUEUE_KEY) || 'null')
  } catch {
    return null
  }
}

/** 统一队列条目结构：接口与缓存都可能是旧字段（filename / 缺 duration / 旧版本无 version） */
function normalizeTrack(t) {
  const id = Number(t?.id)
  if (!Number.isFinite(id)) return null
  const duration = Number(t.duration)
  return {
    id,
    title: String(t.title || t.filename || '未命名曲目'),
    artist: String(t.artist || ''),
    duration: Number.isFinite(duration) && duration > 0 ? Math.round(duration) : null,
    /** 文件版本（r2_key 里的 uuid）：换文件必换 v，播放地址才敢长缓存 */
    version: String(t.version || t.fileVersion || ''),
  }
}

/** 播放地址：带 ?v= 后响应是 immutable 长缓存，重播 / 往回拖都不必重新回源 */
function playUrl(t) {
  return `/api/music/play/${t.id}${t.version ? `?v=${encodeURIComponent(t.version)}` : ''}`
}


function setNowPlaying(t) {
  const title = document.getElementById('np-title')
  const sub = document.getElementById('np-sub')
  if (title) title.textContent = t?.title || ''
  if (sub) sub.textContent = t?.artist || ''
}

function syncModeButton() {
  const btn = document.getElementById('np-mode')
  if (!btn) return
  const def = modeDef()
  btn.innerHTML = icon(def.icon, 18)
  btn.title = def.label
  btn.setAttribute('aria-label', `播放模式：${def.label}`)
}

function renderQueue() {
  const list = document.getElementById('pl-items')
  const panel = document.getElementById('playlist')
  if (!list) return
  const count = document.getElementById('pl-count')
  if (count) count.textContent = queue.length ? `共 ${queue.length} 首` : ''
  const badge = document.getElementById('np-count')
  if (badge) {
    badge.textContent = queue.length ? String(Math.min(queue.length, 99)) : ''
    badge.hidden = !queue.length
  }

  if (!queue.length) {
    list.innerHTML = '<li class="pl-empty small muted">播放列表是空的</li>'
    return
  }
  list.innerHTML = queue
    .map(
      (t, i) => `
      <li class="pl-item${i === index ? ' active' : ''}">
        <button class="pl-pick" type="button" data-pl="${i}" title="${esc(t.title)}">
          <span class="pl-no">${i + 1}</span>
          <span class="pl-meta">
            <span class="pl-title truncate">${esc(t.title)}</span>
            ${t.artist ? `<span class="pl-sub small truncate">${esc(t.artist)}</span>` : ''}
          </span>
          <span class="pl-dur small muted">${fmtDuration(t.duration)}</span>
        </button>
        ${moreMenu(
          `pl-${i}`,
          [{ label: '移出播放列表', icon: 'trash', danger: true, attrs: { 'data-pl-remove': i } }],
          { label: `更多操作 ${t.title}` },
        )}
      </li>`,
    )
    .join('')
  // 行是整段重建的，菜单按钮每次都要重新接线（会先关掉上一个浮层）
  setupMoreMenus(list)

  // 面板开着时跟着当前曲目滚动，但不要打断用户手动浏览
  if (panel && !panel.hidden) list.querySelector('.pl-item.active')?.scrollIntoView({ block: 'nearest' })
}

function playIndex(i, { autoplay = true } = {}) {
  if (i < 0 || i >= queue.length) return
  const audio = audioEl()
  if (!audio) return
  index = i
  const t = queue[i]
  audio.src = playUrl(t)
  audio.dataset.id = String(t.id)
  const bar = document.getElementById('player-bar')
  if (bar) bar.hidden = false
  setNowPlaying(t)
  if (autoplay) audio.play().catch(() => {})
  persist()
  renderQueue()
  notifyPlayer()
}

/** 下一首：auto=true 表示自然播完（单曲循环重放；顺序播放到末尾停在最后一首） */
function nextTrack(auto = false) {
  if (!queue.length) return
  if (modeKey === 'one' && auto) return playIndex(index)
  if (modeKey === 'shuffle') {
    if (queue.length === 1) return playIndex(0)
    let n = index
    while (n === index) n = Math.floor(Math.random() * queue.length)
    return playIndex(n)
  }
  if (index + 1 < queue.length) return playIndex(index + 1)
  if (modeKey === 'list' || !auto) return playIndex(0)
  // 顺序播放放完最后一首：停在末尾，队列和播放条保留，便于用户重听
}

/** 上一首：播过 3 秒先回到本曲开头（主流播放器习惯） */
function prevTrack() {
  if (!queue.length) return
  const audio = audioEl()
  if (audio && audio.currentTime > 3) {
    audio.currentTime = 0
    if (audio.paused) audio.play().catch(() => {})
    return
  }
  if (index > 0) playIndex(index - 1)
  else playIndex(modeKey === 'list' ? queue.length - 1 : 0)
}

function stopPlayback() {
  const audio = audioEl()
  if (audio) {
    audio.pause()
    audio.removeAttribute('src')
    audio.load()
    delete audio.dataset.id
  }
  const bar = document.getElementById('player-bar')
  if (bar) bar.hidden = true
  setNowPlaying(null)
  queue = []
  index = -1
  closeQueuePanel()
  persist()
  renderQueue()
  notifyPlayer()
}

/** 移出队列：删的是当前曲目就顺势播放下一首 */
function removeAt(i) {
  if (i < 0 || i >= queue.length) return
  const wasCurrent = i === index
  queue.splice(i, 1)
  if (!queue.length) return stopPlayback()
  if (i < index) index--
  else if (wasCurrent) index = Math.min(index, queue.length - 1)
  persist()
  renderQueue()
  notifyPlayer()
  if (wasCurrent) playIndex(index)
}

/** 追加到播放列表；队列空时直接开始播放。返回 'added' | 'exists' | 'playing' */
function enqueue(track) {
  const t = normalizeTrack(track)
  if (!t) return 'invalid'
  if (queue.some((x) => x.id === t.id)) return 'exists'
  if (index < 0) {
    queue = [t]
    playIndex(0)
    return 'playing'
  }
  queue.push(t)
  persist()
  renderQueue()
  notifyPlayer()
  return 'added'
}

/** 整体替换队列并开始播放（播放全部 / 随机播放） */
function playQueue(tracks, startAt = 0, opts = {}) {
  const list = (tracks || []).map(normalizeTrack).filter(Boolean)
  if (!list.length) return
  if (opts.mode && PLAY_MODES.some((m) => m.key === opts.mode)) {
    modeKey = opts.mode
    syncModeButton()
  }
  queue = list
  const start = opts.random ? Math.floor(Math.random() * list.length) : startAt
  playIndex(Math.min(Math.max(start, 0), list.length - 1))
}

function setMode(key) {
  if (!PLAY_MODES.some((m) => m.key === key)) return
  modeKey = key
  syncModeButton()
  persist()
  notifyPlayer()
  toast(`播放模式：${modeDef().label}`)
}

function cycleMode() {
  const i = PLAY_MODES.findIndex((m) => m.key === modeKey)
  setMode(PLAY_MODES[(i + 1) % PLAY_MODES.length].key)
}

function updateTrack(id, patch) {
  const target = Number(id)
  let changed = false
  queue = queue.map((t) => {
    if (t.id !== target) return t
    changed = true
    return normalizeTrack({ ...t, ...patch }) ?? t
  })
  if (!changed) return
  if (queue[index]?.id === target) setNowPlaying(queue[index])
  persist()
  renderQueue()
  notifyPlayer()
}

/**
 * 列表刷新后给队列补元数据（文件版本 / 时长）：队列存在 localStorage，
 * 旧版本的记录没有 version，补上之后再次播放才能命中 ?v= 长缓存。标题 / 艺术家不覆盖（用户可能手动改过）。
 */
function syncQueueMeta(list) {
  const fresh = new Map()
  for (const t of list || []) {
    const n = normalizeTrack(t)
    if (n) fresh.set(n.id, n)
  }
  if (!fresh.size || !queue.length) return
  let changed = false
  queue = queue.map((t) => {
    const f = fresh.get(t.id)
    if (!f) return t
    const version = f.version
    const duration = f.duration ?? t.duration
    if (version === t.version && duration === t.duration) return t
    changed = true
    return { ...t, version, duration }
  })
  if (!changed) return
  persist()
  renderQueue()
  notifyPlayer()
}

function queuePanelOpen() {
  const panel = document.getElementById('playlist')
  return !!panel && !panel.hidden
}

function openQueuePanel() {
  const panel = document.getElementById('playlist')
  const btn = document.getElementById('np-queue')
  if (!panel) return
  panel.hidden = false
  btn?.setAttribute('aria-expanded', 'true')
  renderQueue()
}

function closeQueuePanel() {
  const panel = document.getElementById('playlist')
  const btn = document.getElementById('np-queue')
  if (!panel) return
  closeMoreMenu()
  panel.hidden = true
  btn?.setAttribute('aria-expanded', 'false')
}

function toggleQueuePanel() {
  if (queuePanelOpen()) closeQueuePanel()
  else openQueuePanel()
}

/**
 * 播放器初始化（在 shell 上调用一次）：绑定控件 + 恢复上次队列。
 * 视图层只通过下面的 player 对象操作，不直接碰 audio。
 */
export function initPlayer() {
  if (playerReady) return
  playerReady = true
  const audio = audioEl()
  const prevBtn = document.getElementById('np-prev')
  const nextBtn = document.getElementById('np-next')
  const queueBtn = document.getElementById('np-queue')
  const items = document.getElementById('pl-items')
  if (!audio || !prevBtn || !nextBtn || !queueBtn || !items) return

  prevBtn.innerHTML = icon('prev', 18)
  nextBtn.innerHTML = icon('next', 18)
  queueBtn.innerHTML = `${icon('queue', 18)}<span class="np-count" id="np-count" hidden></span>`
  syncModeButton()

  prevBtn.onclick = () => prevTrack()
  nextBtn.onclick = () => nextTrack(false)
  document.getElementById('np-mode').onclick = () => cycleMode()
  queueBtn.onclick = () => toggleQueuePanel()
  document.getElementById('pl-close').onclick = () => closeQueuePanel()
  // 清空是不可逆操作：收进表头「更多」，与页面其它删除类入口一致
  const moreSlot = document.getElementById('pl-more')
  if (moreSlot) {
    moreSlot.innerHTML = moreMenu(
      'pl',
      [{ label: '清空播放列表', icon: 'trash', danger: true, attrs: { id: 'pl-clear' } }],
      { label: '播放列表更多操作' },
    )
  }
  document.getElementById('pl-clear').onclick = () => {
    if (queue.length && confirm('清空播放列表并停止播放？')) stopPlayback()
  }
  setupMoreMenus(document.getElementById('playlist'))

  items.onclick = (e) => {
    const rm = e.target.closest('[data-pl-remove]')
    if (rm) return removeAt(Number(rm.dataset.plRemove))
    const pick = e.target.closest('[data-pl]')
    if (pick) playIndex(Number(pick.dataset.pl))
  }

  // 播完自动下一首（顺序播放到末尾即停）
  audio.addEventListener('ended', () => nextTrack(true))
  audio.addEventListener('error', () => {
    if (audio.dataset.id) toast('无法播放该曲目，文件可能已被删除', true)
  })

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && queuePanelOpen()) closeQueuePanel()
  })

  // 恢复上次队列：只摆好播放条与进度，不自动播放（浏览器也禁止无声自动播放）
  const saved = readPersisted()
  if (saved && Array.isArray(saved.queue) && saved.queue.length) {
    queue = saved.queue.map(normalizeTrack).filter(Boolean)
    if (PLAY_MODES.some((m) => m.key === saved.mode)) modeKey = saved.mode
    index =
      Number.isInteger(saved.index) && saved.index >= 0 && saved.index < queue.length ? saved.index : 0
    syncModeButton()
    const t = queue[index]
    audio.src = playUrl(t)
    audio.dataset.id = String(t.id)
    setNowPlaying(t)
    const bar = document.getElementById('player-bar')
    if (bar) bar.hidden = false
  }
  renderQueue()
  notifyPlayer()
}

/** 常驻播放器：audio 与播放条在 shell 里，跨视图不断播；队列存 localStorage */
export const player = {
  get currentId() {
    const id = document.getElementById('player')?.dataset.id
    return id ? Number(id) : null
  },
  get queue() {
    return queue.slice()
  },
  get mode() {
    return modeKey
  },
  /** 当前是否真的在出声（无曲目 / 暂停 / 播完都算否） */
  get isPlaying() {
    const audio = audioEl()
    return !!audio && !!audio.dataset.id && !audio.paused && !audio.ended
  },

  /** 继续播放当前曲目（快捷按钮从暂停恢复）；play 事件会把按钮图标刷回来 */
  resume() {
    const audio = audioEl()
    if (!audio || !audio.dataset.id) return
    audio.play().catch(() => toast('浏览器阻止了自动播放，请再点一下', true))
  },
  pause() {
    audioEl()?.pause()
  },

  /** 单曲播放：已在队列里就跳过去，否则用单曲队列替换（兼容旧调用） */
  play(id, title) {
    const pos = queue.findIndex((t) => t.id === Number(id))
    if (pos >= 0) return playIndex(pos)
    const t = normalizeTrack({ id, title })
    if (!t) return
    queue = [t]
    playIndex(0)
  },
  playQueue,
  enqueue,
  next() {
    nextTrack(false)
  },
  prev: prevTrack,
  setMode,
  cycleMode,
  removeAt,
  updateTrack,
  syncMeta: syncQueueMeta,
  stop: stopPlayback,

  /** 订阅播放状态变化（切歌/队列变化/停止），返回取消订阅函数 */
  onChange(fn) {
    playerListeners.add(fn)
    return () => playerListeners.delete(fn)
  },
}
