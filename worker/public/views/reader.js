/**
 * 阅读页（独立路由 #/reader?id=）：epub / pdf / txt 都在整页里读，不再塞进弹窗。
 *
 * 跨境链路只有 ~84KB/s（实测），所以「打开一本书」的成本主要在传输，三层处理：
 * - 所有文件 URL 带 ?v=<updatedAt>：换文件必然换版本，服务端据此回 immutable 长缓存（core/files.ts），
 *   第二次打开不再重新下载
 * - txt：整本下载（显示下载大小 / 百分比）→ 解码 → 分章；页脚进度按「当前章节在全书中的
 *   字符位置 + 章内滚动比例」计算，跳章 / 翻页后仍是全书总进度；目录随时可在目录栏 / 弹窗里
 *   手动重新生成（只重扫本地全文，不再重新下载）
 * - txt 右键菜单：选中文字后可「复制」，或「批量删除广告」——读整本 → 删掉所有选中文字
 *   （命中后整行变空的一并去行）→ 以新文件重传（新 uuid = 新版本号，缓存自然失效）→ 重开
 * - epub：库不支持 Range，仍是整本 ArrayBuffer，但脚本与文件并行下载 + 显示进度
 *   （/api/book/read/:id 没有 .epub 后缀，交给库按 URL 找目录会 404）
 * - pdf：浏览器原生查看器（Worker 透传 Range，渐进加载）
 *
 * 版式：微信读书式沉浸页——body.reading 时全局侧栏 / 顶栏隐藏（app.js 挂类），阅读页
 * 自带顶栏（书名 + 右上角「首页 / 我的书架」），正文栏宽 800px，翻页 / 进度下沉页脚，
 * 目录 / 字号 / 背景（白·米黄·护眼·夜间）收进右侧悬浮工具栏，字号与位置存 localStorage。
 * 位置 / 字号只影响记忆，不影响阅读；销毁时释放 epub 实例与定时器。
 */
import { api, esc, icon, loadScriptOnce, showDialog, toast } from '../lib.js'
import { loadingBlock } from '../ui.js'
import { enqueue } from '../upload.js'

const TXT_FONT_KEY = 'book:txt:font'
const TXT_LINE_KEY = 'book:txt:line'
const EPUB_FONT_KEY = 'book:epub:font'
const txtPosKey = (id) => `book:txt:pos:${id}`
const epubPosKey = (id) => `book:epub:pos:${id}`

/* ---------------- 阅读设置：背景 / 字号 / 行距 ---------------- */

/** 背景主题（微信读书四色系）：夜间底色对齐 rgb(28,28,29)，米黄 / 护眼为常用护眼色 */
const READER_THEME_KEY = 'book:theme'
const READER_THEMES = [
  { id: 'paper', label: '白', bg: '#ffffff' },
  { id: 'sepia', label: '米黄', bg: '#f6f0e0' },
  { id: 'green', label: '护眼', bg: '#dfe9da' },
  { id: 'dark', label: '夜间', bg: '#1c1c1d' },
]

/** 行距三档（微信读书「紧凑 / 标准 / 宽松」的对应值），只作用于 TXT；epub 跟随原书 */
const LINE_OPTIONS = [
  { value: 1.4, label: '紧凑' },
  { value: 1.5, label: '标准' },
  { value: 1.7, label: '宽松' },
]

/** 没存过时跟随应用主题：应用是深色就默认夜间阅读，浅色默认白纸 */
function readTheme() {
  const saved = readStorage(READER_THEME_KEY)
  if (saved && READER_THEMES.some((t) => t.id === saved)) return saved
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'paper'
}

/** 换背景：.reader-root 的 data 属性驱动 CSS 设计令牌（顶栏 / 正文 / 页脚 / 目录一起变色），并记住偏好 */
function setReaderTheme(root, theme) {
  if (!READER_THEMES.some((t) => t.id === theme)) return
  root.dataset.readerTheme = theme
  writeStorage(READER_THEME_KEY, theme)
  const fab = root.querySelector('[data-fab-theme]')
  if (fab) fab.innerHTML = icon(theme === 'dark' ? 'moon' : 'sun', 16)
}

/** 循环切换背景（悬浮工具栏第三个钮），返回新主题 id */
function cycleTheme(root) {
  const order = READER_THEMES.map((t) => t.id)
  const next = order[(order.indexOf(root.dataset.readerTheme || 'paper') + 1) % order.length]
  setReaderTheme(root, next)
  toast(`背景：${READER_THEMES.find((t) => t.id === next)?.label ?? next}`)
  return next
}

/** 右侧悬浮工具栏（微信读书式圆钮）：目录 / 阅读设置 / 背景循环；接线由各阅读器完成 */
function fabHtml() {
  return `<div class="reader-fabs" role="toolbar" aria-label="阅读工具">
      <button class="reader-fab" type="button" data-fab-toc aria-label="目录" title="目录">${icon('queue', 16)}</button>
      <button class="reader-fab" type="button" data-fab-set aria-label="阅读设置" title="阅读设置">Aa</button>
      <button class="reader-fab" type="button" data-fab-theme aria-label="切换背景" title="切换背景"></button>
    </div>`
}

/**
 * 阅读设置弹窗：字号 / 行距（txt）/ 背景，改动即时生效、无需保存。
 * font = { value, min, max, onFont }；line = { value, onLine }（epub 行距跟随原书，不传）；
 * onTheme(id) 由调用方接到背景切换（txt 只换令牌，epub 还要刷 iframe 主题）。
 */
function openReaderSettings({ theme, onTheme, font = null, line = null } = {}) {
  const fontBlock = font
    ? `<div class="reader-setting"><span class="reader-setting-label">字号</span>
         <button class="btn sm" type="button" data-fs="-1" aria-label="缩小字号">A−</button>
         <span class="reader-setting-value" data-fs-value>${font.value}</span>
         <button class="btn sm" type="button" data-fs="1" aria-label="放大字号">A+</button>
       </div>`
    : ''
  const lineBlock = line
    ? `<div class="reader-setting"><span class="reader-setting-label">行距</span>
         <div class="reader-seg" role="group" aria-label="行距">${line.options
           .map(
             (o) =>
               `<button class="reader-seg-btn" type="button" data-line="${o.value}" aria-pressed="${o.value === line.value}">${esc(o.label)}</button>`,
           )
           .join('')}</div>
       </div>`
    : ''
  const swatchBlock = `<div class="reader-setting"><span class="reader-setting-label">背景</span>
      <div class="reader-swatches">${READER_THEMES.map(
        (t) =>
          `<button class="reader-swatch" type="button" data-swatch="${t.id}" title="${esc(t.label)}" aria-label="${esc(t.label)}" aria-pressed="${t.id === theme}" style="background:${t.bg}"></button>`,
      ).join('')}</div>
    </div>`

  const dlg = showDialog(`<h2>阅读设置</h2>${fontBlock}${lineBlock}${swatchBlock}`, { label: '阅读设置' })
  if (font) {
    dlg.body.querySelectorAll('[data-fs]').forEach((b) => {
      b.onclick = () => {
        const next = Math.max(font.min, Math.min(font.max, font.value + Number(b.dataset.fs)))
        if (next === font.value) return
        font.value = next
        font.onFont(next)
        const out = dlg.body.querySelector('[data-fs-value]')
        if (out) out.textContent = String(next)
      }
    })
  }
  if (line) {
    dlg.body.querySelectorAll('[data-line]').forEach((b) => {
      b.onclick = () => {
        line.value = Number(b.dataset.line)
        line.onLine(line.value)
        dlg.body
          .querySelectorAll('[data-line]')
          .forEach((x) => x.setAttribute('aria-pressed', String(Number(x.dataset.line) === line.value)))
      }
    })
  }
  dlg.body.querySelectorAll('[data-swatch]').forEach((b) => {
    b.onclick = () => {
      const id = b.dataset.swatch
      onTheme(id)
      dlg.body
        .querySelectorAll('[data-swatch]')
        .forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.swatch === id)))
    }
  })
  return dlg
}

/** 一屏约 1–2KB，12000 字足够翻好几屏；没有章节标题的书按这个长度分节 */
const SECTION_CHARS = 12000

/** 数字：半角 / 全角 / 汉字（含「〇」），不少 TXT 用「第１２３章」 */
const TXT_NUM = '[0-9０-９零〇一二三四五六七八九十百千万两]'
/** 章节单位：章 / 节 / 回 / 卷 / 部 / 篇 / 集 / 幕 / 折 / 话 */
const TXT_UNIT = '[章节回卷部篇集幕折话]'
/** 章节标题：行首「第X章/卷/回…」、常见卷首语、英文 Chapter，或 markdown 标题
 *  （「正文 / 尾声」这类词只认独立成行，放在 TXT_STANDALONE，避免「正文内容如下…」被当成标题） */
const TXT_HEADING = new RegExp(
  `^(?:第\\s*${TXT_NUM}+\\s*${TXT_UNIT}` +
    `|卷\\s*${TXT_NUM}+` +
    `|[上中下续终前后]\\s*[卷部篇集]` +
    `|(?:序章|序言|楔子|引子|引言|前言|后记|附录|附记|终章|番外|完本感言|上架感言|作者的话)` +
    `|#{1,3}\\s)`,
)
/** 独立成行的卷首语（不带「第X」编号） */
const TXT_STANDALONE = /^(?:序|自序|小引|引言|序幕|尾声|后记|附录|附记|终章|番外|正文|完本感言|上架感言|作者的话)$/
/** 章节号后紧跟空格 / 冒号 / 顿号等分隔符：最可靠的标题样式 */
const TXT_HEADING_SEP = new RegExp(`^第\\s*${TXT_NUM}+\\s*${TXT_UNIT}(?:\\s|$|[:：、·—\\-])`)
/** 独立序号标题：1 / 01 / 1. / 一、 / （一） */
const TXT_NUM_ONLY = new RegExp(`^(?:${TXT_NUM}{1,4}\\s*[.、．]?|[（(]\\s*${TXT_NUM}{1,4}\\s*[）)])$`)
/** 英文常见章节标题 */
const TXT_HEADING_EN = /^(?:(?:chapter|part|book)\s+(?:\d+|[ivxlcdm]+)|prologue|epilogue|interlude)\b/i
/** 正文式开头：避免把「第三章讲的是…」这种引用当成标题 */
const TXT_PROSE_REF = new RegExp(`^第\\s*${TXT_NUM}+\\s*${TXT_UNIT}(?:讲|说|写|的|是|有|就|又|还|要|把|给|被|让|合|课)`)
/** 「第一章里 / 第一章中」这类弱信号：短标题仍可能是真标题，长句才判为正文 */
const TXT_PROSE_WEAK = new RegExp(`^第\\s*${TXT_NUM}+\\s*${TXT_UNIT}(?:里|中)`)

let epubBook = null
let txtReader = null
/** epub 的键盘 / 滚轮监听与存位定时器，切页时必须释放（iframe 会被 epub.js 一起销毁） */
let epubDispose = null

export async function render(main, params) {
  const id = Number(params.id)
  if (!Number.isInteger(id) || id <= 0) {
    main.innerHTML = message('链接里缺少图书 id')
    return
  }

  let book
  try {
    const data = await api(`/api/book/${id}`)
    book = data.book
  } catch (err) {
    main.innerHTML = message(err?.message || '图书加载失败')
    return
  }

  const title = book.title || book.filename || '未命名'
  const meta = [book.author || '未知作者', book.category, book.pubYear, (book.fmt || '').toUpperCase()]
    .filter(Boolean)
    .join(' · ')
  // 版本号 = 文件自身的 uuid（换文件才变；改书名 / 阅读状态不影响缓存）
  const version = String(book.fileVersion ?? book.updatedAt ?? 0)
  const fileUrl = `/api/book/read/${id}?v=${encodeURIComponent(version)}`

  main.innerHTML = `
    <div class="reader-root" data-reader-theme="${readTheme()}">
      <header class="reader-top">
        <div class="reader-title">
          <h1 class="page-title" title="${esc(title)}">${esc(title)}</h1>
          <p class="page-sub">
            <span class="reader-chapter" data-chapter hidden></span>
            <span data-meta>${esc(meta)}</span>
          </p>
        </div>
        <nav class="reader-top-links" aria-label="返回导航">
          <a href="#/">首页</a>
          <a href="#/book">我的书架</a>
        </nav>
      </header>
      <div class="reader-stage" id="reader-stage"></div>
    </div>`

  // 当前章：顶栏副标题与浏览器标签页同步（切章时由各阅读器回调）
  const chapterEl = main.querySelector('[data-chapter]')
  const setChapter = (label) => {
    // 异步下载 / epub relocated 可能在切页后才回调：页面已经换掉就别再改标题
    if (!chapterEl.isConnected) return
    const text = String(label || '').replace(/\s+/g, ' ').trim()
    chapterEl.textContent = text
    chapterEl.hidden = !text
    document.title = text ? `${text} · ${title}` : `${title} · 个人工作台`
  }

  const stage = main.querySelector('#reader-stage')
  const root = main.querySelector('.reader-root')
  if (!book.hasFile) {
    stage.innerHTML = '<div class="empty">这本书还没有上传文件，回书架点「上传文件」。</div>'
    return
  }

  // 打开即记一次「最近阅读」：书架默认排序按它倒序置顶；待读 → 阅读中，失败静默不挡阅读
  api(`/api/book/${id}/reading`, { method: 'POST' }).catch(() => {})

  // 进度回写书架卡片：epub / txt 阅读器翻页 / 滚动时调用（pdf 是浏览器原生查看器，拿不到页码）
  reportProgress = progressReporter(id)

  if (book.fmt === 'pdf') {
    // PDF 交给浏览器原生查看器：自带缩放 / 页码 / 目录，不再叠加一层页脚
    stage.innerHTML = `<iframe class="reader-frame" src="${esc(fileUrl)}" title="${esc(title)}"></iframe>`
    return
  }
  if (book.fmt === 'txt') {
    openTxtReader(id, title, version, fileUrl, book.size, stage, setChapter, book.filename)
    return
  }
  await openEpubReader(id, version, fileUrl, stage, setChapter)
}

function message(text) {
  return `<div class="alert danger">${icon('alert')}<span>${esc(text)}</span></div>
    <p class="mt-3"><a class="btn sm" href="#/book">返回书架</a></p>`
}

/* ---------------- 通用：页脚 / 进度 / 目录 ---------------- */

/** 页脚控制条：上一章/页 …… 进度 …… 字号 / 目录 / 下一章/页 */
function footerHtml({ prev = '上一页', next = '下一页', font = false, stat = false } = {}) {
  return `<footer class="reader-controls">
    <div class="reader-controls-inner">
      <button class="btn sm reader-nav" type="button" data-prev aria-label="${esc(prev)}">
        ${icon('chevron', 14, 'flip')}<span>${esc(prev)}</span>
      </button>
      <div class="reader-progress" data-progress role="progressbar" aria-label="阅读进度"
           aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
        <span class="reader-track"><i data-bar></i></span>
        <span class="reader-progress-text" data-progress-text>0%</span>
        ${stat ? '<span class="reader-stat small muted" data-stat></span>' : ''}
      </div>
      <div class="reader-foot-acts">
        ${
          font
            ? `<button class="btn sm" type="button" data-font="-1" aria-label="缩小字号" title="缩小字号">A−</button>
        <button class="btn sm" type="button" data-font="1" aria-label="放大字号" title="放大字号">A+</button>`
            : ''
        }
        <button class="btn sm" type="button" data-toc aria-haspopup="dialog" aria-label="目录" title="目录">
          ${icon('queue', 14)}<span>目录</span>
        </button>
        <button class="btn sm reader-nav" type="button" data-next aria-label="${esc(next)}">
          <span>${esc(next)}</span>${icon('chevron', 14)}
        </button>
      </div>
    </div>
  </footer>`
}

/** 进度条 / 百分比统一入口（ratio 0–1；text 缺省时显示百分比） */
function setProgress(root, ratio, text, valuetext = '') {
  const safe = Number.isFinite(ratio) ? Math.max(0, Math.min(1, ratio)) : 0
  const pct = Math.round(safe * 100)
  const bar = root.querySelector('[data-bar]')
  const box = root.querySelector('[data-progress]')
  const label = root.querySelector('[data-progress-text]')
  if (bar) bar.style.width = `${pct}%`
  if (box) {
    box.setAttribute('aria-valuenow', String(pct))
    if (valuetext) box.setAttribute('aria-valuetext', `${valuetext} ${pct}%`)
  }
  if (label) label.textContent = text ?? `${pct}%`
}

/**
 * 阅读进度回写书架卡片：同一百分比不重复发，翻页很快时攒 2 秒再发，离页时 flush。
 * 失败静默（只影响书架上的进度条，不影响阅读）；pdf 走浏览器原生查看器拿不到页码，不接。
 */
function progressReporter(id) {
  let last = -1
  let pending = null
  let timer = 0
  const flush = () => {
    clearTimeout(timer)
    timer = 0
    if (pending == null) return
    const pct = pending
    pending = null
    if (pct === last) return
    last = pct
    api(`/api/book/${id}/progress`, { method: 'POST', body: JSON.stringify({ progress: pct }) }).catch(() => {})
  }
  return {
    report(ratio) {
      if (!Number.isFinite(ratio)) return
      const pct = Math.max(0, Math.min(100, Math.round(ratio * 100)))
      if (pct === last || pct === pending) return
      pending = pct
      if (!timer) timer = setTimeout(flush, 2000)
    },
    flush,
  }
}

/** 当前阅读器的进度上报器（切页 destroy 时 flush 掉最后一格） */
let reportProgress = null

/** 目录行 DOM：弹窗与右侧栏共用，避免两套结构走偏 */
function tocRowsHtml(rows, current) {
  return rows
    .map(
      (row, i) => `<li class="reader-toc-item" data-depth="${Math.min(row.depth ?? 0, 3)}">
            <button class="reader-toc-btn" type="button" data-toc-i="${i}"${
              i === current ? ' aria-current="true"' : ''
            }>${row.no ? `<span class="reader-toc-no">${esc(row.no)}</span>` : ''}${esc(row.label)}</button>
          </li>`,
    )
    .join('')
}

/** 目录弹窗：rows = [{ label, depth?, no? }]，点击回调由调用方接在 data-toc-i 上 */
function openTocDialog(rows, { empty = '这本书没有目录信息。', hint = '', current = -1, onRegenerate = null } = {}) {
  const regen = onRegenerate
    ? `<div class="reader-toc-tools">
         <span class="small muted">识别不准或算法更新后，可重新扫描目录</span>
         <button class="btn sm" type="button" data-toc-regen>${icon('refresh', 14)}重新生成目录</button>
       </div>`
    : ''

  if (!rows.length) {
    const dlg = showDialog(
      `<h2>目录</h2>
       ${regen}
       <p class="small muted">${esc(empty)}</p>`,
      { label: '目录' },
    )
    bindTocRegen(dlg, onRegenerate)
    return dlg
  }

  const html = `<h2>目录</h2>
    ${regen}
    <ol class="reader-toc">
      ${tocRowsHtml(rows, current)}
    </ol>
    ${hint ? `<p class="reader-toc-hint small muted">${esc(hint)}</p>` : ''}`

  const dlg = showDialog(html, { label: '目录' })
  dlg.body.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest' })
  bindTocRegen(dlg, onRegenerate)
  return dlg
}

/** 「重新生成目录」按钮：先关弹窗，再让阅读器重扫（否则弹窗会压住加载反馈） */
function bindTocRegen(dlg, onRegenerate) {
  const btn = dlg?.body.querySelector('[data-toc-regen]')
  if (!btn || !onRegenerate) return
  btn.addEventListener('click', () => {
    dlg.close()
    onRegenerate()
  })
}

/* ---------------- 右侧目录栏（桌面） ---------------- */

const TOC_OPEN_KEY = 'book:toc:open'
/** 断点与 CSS 的 1024px 保持一致 */
const tocWide = () => window.matchMedia('(min-width: 1024px)').matches

const tocSideHtml = (opts = {}) => `<aside class="reader-toc-side" data-toc-side hidden aria-label="目录">
    <div class="reader-toc-head">
      <strong>目录</strong>
      <div class="reader-toc-head-acts">
        ${
          opts.refresh
            ? `<button class="icon-btn" type="button" data-toc-refresh aria-label="重新生成目录" title="重新生成目录">${icon('refresh', 14)}</button>`
            : ''
        }
        <button class="icon-btn" type="button" data-toc-close aria-label="收起目录" title="收起目录">${icon('close', 14)}</button>
      </div>
    </div>
    <ol class="reader-toc reader-toc-list" data-toc-list></ol>
    <p class="reader-toc-hint small muted" data-toc-hint hidden></p>
  </aside>`

/**
 * 桌面右侧目录：默认展开、偏好记忆、当前章高亮 + 自动滚动。
 * onPick(row) 由各阅读器提供跳转逻辑；窄屏不显示（仍走页脚目录按钮的弹窗）。
 */
function createTocSide(stage, onPick) {
  const panel = stage.querySelector('[data-toc-side]')
  if (!panel) return null
  const list = panel.querySelector('[data-toc-list]')
  const hintEl = panel.querySelector('[data-toc-hint]')
  const closeBtn = panel.querySelector('[data-toc-close]')

  let rows = []
  let current = -1
  let open = readStorage(TOC_OPEN_KEY) !== '0'
  let userScrollAt = 0

  const sync = () => {
    panel.hidden = !(open && tocWide() && rows.length > 0)
  }

  const scrollToCurrent = () => {
    // 用户刚手动滚过目录就暂时不抢滚动，避免「手一滑就被拽回去」
    if (panel.hidden || Date.now() - userScrollAt < 1200) return
    list.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest' })
  }

  const paint = () => {
    list.innerHTML = tocRowsHtml(rows, current)
    scrollToCurrent()
  }

  /** 章节表变化时重建；阅读器随后调 setCurrent 同步高亮 */
  const setRows = (next, hint = '') => {
    rows = next || []
    hintEl.textContent = hint
    hintEl.hidden = !hint
    sync()
    paint()
  }

  const setCurrent = (i) => {
    current = Number.isInteger(i) ? i : -1
    list.querySelectorAll('[data-toc-i]').forEach((btn) => {
      if (Number(btn.dataset.tocI) === current) btn.setAttribute('aria-current', 'true')
      else btn.removeAttribute('aria-current')
    })
    scrollToCurrent()
  }

  const toggle = () => {
    open = !open
    writeStorage(TOC_OPEN_KEY, open ? '1' : '0')
    sync()
    if (open) scrollToCurrent()
  }

  const markUserScroll = () => {
    userScrollAt = Date.now()
  }
  list.addEventListener('wheel', markUserScroll, { passive: true })
  list.addEventListener('touchstart', markUserScroll, { passive: true })
  list.addEventListener('pointerdown', markUserScroll)
  list.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-toc-i]')
    if (!btn) return
    const row = rows[Number(btn.dataset.tocI)]
    if (row) onPick(row)
  })
  closeBtn.addEventListener('click', () => {
    open = false
    writeStorage(TOC_OPEN_KEY, '0')
    sync()
  })

  const onResize = () => sync()
  window.addEventListener('resize', onResize)

  return {
    setRows,
    setCurrent,
    toggle,
    canToggle: () => tocWide() && rows.length > 0,
    destroy: () => window.removeEventListener('resize', onResize),
  }
}

/* ---------------- 通用：进度显示 / 带进度读取 ---------------- */

/** 把 loadingBlock 的文案换成可更新的 setter（进度条文字每 100ms 变一次，不重建节点） */
function progressStage(stage, label) {
  stage.innerHTML = loadingBlock(label)
  const el = stage.querySelector('.loading span:last-child')
  return (text) => {
    if (el?.isConnected) el.textContent = text
  }
}

const fmtSize = (bytes) => {
  if (!bytes) return '0'
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * 读完整 body 并报进度：content-length 就是整本大小（跨境链路上百 KB/s，
 * 没有进度的话几十秒白屏跟卡死没区别）。
 */
async function readBodyWithProgress(res, onProgress) {
  const total = Number(res.headers.get('content-length')) || 0
  if (!res.body || !total) return new Uint8Array(await res.arrayBuffer())

  const reader = res.body.getReader()
  const chunks = []
  let received = 0
  let lastAt = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    received += value.length
    const now = Date.now()
    if (now - lastAt > 120) {
      lastAt = now
      onProgress(received, total)
    }
  }
  onProgress(received, total)

  const out = new Uint8Array(received)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.length
  }
  return out
}

/* ---------------- epub ---------------- */

/** epub 目录可能是多层：拍平成 [{ label, href, depth }] */
function flattenToc(items, depth = 0, out = []) {
  for (const item of items || []) {
    const label = String(item?.label ?? '').replace(/\s+/g, ' ').trim()
    if (label && item.href) out.push({ label, href: item.href, depth })
    if (item?.subitems?.length) flattenToc(item.subitems, depth + 1, out)
  }
  return out
}

async function openEpubReader(id, version, fileUrl, stage, setChapter) {
  const alive = () => stage.isConnected
  const root = stage.closest('.reader-root')
  const say = progressStage(stage, '正在打开 epub…')

  try {
    // jszip 必须先于 epub.js 就绪（UMD 从 window.JSZip 取），但书文件可以同时开始下：
    // 三个串行 RTT 变成两段重叠
    const zipReady = loadScriptOnce('/vendor/jszip.min.js')
    const filePromise = fetch(fileUrl)
    await zipReady
    if (!alive()) return
    const epubReady = loadScriptOnce('/vendor/epub.min.js')

    const res = await filePromise
    if (!res.ok) throw new Error(`打开失败：HTTP ${res.status}`)
    const bytes = await readBodyWithProgress(res, (got, total) => {
      say(`正在下载 ${fmtSize(got)} / ${fmtSize(total)}（${Math.round((got / total) * 100)}%）`)
    })
    if (!alive()) return
    await epubReady
    if (!alive()) return

    stage.innerHTML = `
      <div class="reader-body">
        <div class="reader-page"><div class="reader-view" data-view></div></div>
        ${tocSideHtml()}
      </div>
      ${fabHtml()}
      ${footerHtml({ stat: true })}`

    const view = stage.querySelector('[data-view]')
    const prevBtn = stage.querySelector('[data-prev]')
    const nextBtn = stage.querySelector('[data-next]')
    const tocBtn = stage.querySelector('[data-toc]')

    epubBook = window.ePub(bytes.buffer)
    // 坏书（不是合法 epub）要立刻报错：openFailed 之后 loaded.* 永不 resolve，
    // 不加这个监听阅读页会永远停在「正在打开 epub…」
    const openBroken = new Promise((_, reject) =>
      epubBook.on('openFailed', () => reject(new Error('这本书解析失败（不是有效的 epub）'))),
    )
    // spread:'none' + 窄栏：宽屏上仍然是一页一行字，图片不会被拉满整屏
    const rendition = epubBook.renderTo(view, { width: '100%', height: '100%', spread: 'none' })
    const go = (dir) => Promise.resolve(rendition[dir]()).catch(() => {})

    // epub 是 iframe 里的独立文档：背景 / 字号除了写进 rendition 主题，还要直接刷已渲染的 iframe，
    // 否则 themes API 只对翻页后的新内容生效，当前页不变色
    let epubFontSize = Math.max(14, Math.min(26, Number(readStorage(EPUB_FONT_KEY)) || 21))
    const epubThemeColors = {
      paper: null, // 白：跟随原书自带样式（epub 自带排版）
      sepia: { color: '#38301f', background: '#f6f0e0' },
      green: { color: '#23321f', background: '#dfe9da' },
      dark: { color: '#d0d3d8', background: '#1c1c1d' }, // 夜间：epub 自带样式多为黑字，不覆盖看不清
    }
    const paintEpubTheme = () => {
      const colors = epubThemeColors[root.dataset.readerTheme || 'paper']
      try {
        if (colors) {
          rendition.themes.override('color', colors.color)
          rendition.themes.override('background', colors.background)
        } else {
          rendition.themes.override('color', '')
          rendition.themes.override('background', '')
        }
        rendition.themes.fontSize(`${epubFontSize}px`)
      } catch {
        /* 主题接口不可用时按原书样式显示，不影响阅读 */
      }
      try {
        rendition.views().forEach((v) => {
          const doc = v.document
          if (!doc) return
          doc.documentElement.style.fontSize = `${epubFontSize}px`
          const paint = (prop, value) => {
            doc.documentElement.style[prop] = value
            doc.body.style[prop] = value
          }
          paint('color', colors?.color ?? '')
          paint('background', colors?.background ?? '')
        })
      } catch {
        /* iframe 还没渲染好：relocated 后会再刷一遍 */
      }
    }
    paintEpubTheme()

    // 悬浮工具栏：目录 / 阅读设置（字号 + 背景）/ 背景循环；先刷一次主题钮图标
    setReaderTheme(root, root.dataset.readerTheme || 'paper')
    const setFabTheme = (id) => {
      setReaderTheme(root, id)
      paintEpubTheme()
    }
    stage.querySelector('[data-fab-set]').onclick = () => {
      openReaderSettings({
        theme: root.dataset.readerTheme || 'paper',
        font: {
          value: epubFontSize,
          min: 14,
          max: 26,
          onFont: (n) => {
            epubFontSize = n
            writeStorage(EPUB_FONT_KEY, String(n))
            paintEpubTheme()
          },
        },
        onTheme: setFabTheme,
      })
    }
    stage.querySelector('[data-fab-theme]').onclick = () => {
      cycleTheme(root)
      paintEpubTheme()
    }

    // 目录（navigation 解析很快，先拿到才能把 href 映射成 spine 序号）；
    // openBroken 兜底：坏书不进这行 await 的静默挂起，直接走外层错误提示
    const nav = await Promise.race([epubBook.loaded.navigation.catch(() => null), openBroken])
    const tocItems = flattenToc(nav?.toc)
    const spineIndex = (href) => {
      if (!href) return -1
      const clean = String(href).split('#')[0]
      try {
        // 目录 href 常带 #锚点，spine 里则是整节文件：先按原样，再按去锚点 / 同名文件匹配
        let section = epubBook.spine.get(href) ?? epubBook.spine.get(clean)
        if (!section) {
          const name = clean.split('/').pop()
          section = epubBook.spine.spineItems.find((item) => String(item.href).split('#')[0].split('/').pop() === name)
        }
        return Number.isInteger(section?.index) ? section.index : -1
      } catch {
        return -1
      }
    }
    const tocIndexed = tocItems
      .map((item) => ({ ...item, index: spineIndex(item.href) }))
      .filter((item) => item.index >= 0)
      .sort((a, b) => a.index - b.index)
    const totalSections = epubBook.spine?.spineItems?.length ?? 0

    // 右侧目录：默认展开（窄屏隐藏），点击直接 display
    const tocSide = createTocSide(stage, (row) => {
      if (row?.href) rendition.display(row.href).catch(() => {})
    })
    tocSide?.setRows(tocItems.map(({ label, depth, href }) => ({ label, depth, href })))
    const tocIndexOf = (href) => (href ? tocItems.findIndex((item) => item.href === href) : -1)

    let currentIndex = 0
    let lastLoc = null
    let saveTimer = 0

    const chapterAt = (index) => {
      let hit = null
      for (const item of tocIndexed) {
        if (item.index <= index) hit = item
        else break
      }
      return hit
    }

    const paintProgress = () => {
      let ratio = 0
      try {
        if (lastLoc?.start?.cfi && epubBook.locations.length() > 0) {
          ratio = epubBook.locations.percentageFromCfi(lastLoc.start.cfi) || 0
        } else if (Number.isInteger(lastLoc?.start?.index) && totalSections) {
          ratio = Math.min(1, (lastLoc.start.index + (lastLoc.atEnd ? 1 : 0)) / totalSections)
        }
      } catch {
        ratio = 0
      }
      setProgress(stage, ratio, `${Math.round(ratio * 100)}%`, chapterAt(currentIndex)?.label || '')
      reportProgress?.report(ratio)
    }

    const paintLocation = (loc) => {
      if (!alive()) return
      lastLoc = loc || lastLoc
      currentIndex = Number.isInteger(lastLoc?.start?.index) ? lastLoc.start.index : 0
      const hit = chapterAt(currentIndex)
      // 目录缺失或落在两章之间时，退回节序号，标题栏始终有内容
      setChapter(hit?.label || (totalSections ? `第 ${currentIndex + 1} 节` : ''))
      tocSide?.setCurrent(tocIndexOf(hit?.href))
      const stat = stage.querySelector('[data-stat]')
      if (stat) stat.textContent = totalSections ? `第 ${currentIndex + 1} / ${totalSections} 节` : ''
      paintProgress()
    }

    // 键盘：焦点在页面壳时方向键也翻页；iframe 内的按键由 epub.js 自己处理，不会翻两次
    const onKey = (e) => {
      if (document.getElementById('dlg')?.open) return
      if (e.target instanceof HTMLSelectElement || e.target instanceof HTMLInputElement) return
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        go('prev')
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        go('next')
      }
    }

    // 滚轮翻页：epub 是分页排版（没有可滚动内容），滚轮本来就该是翻页；
    // 触摸板小增量先累积，翻页后短暂上锁，避免一下跳好几页
    let wheelAcc = 0
    let wheelAt = 0
    let wheelLock = 0
    const onWheel = (e) => {
      if (e.ctrlKey || e.metaKey) return
      const now = Date.now()
      if (now - wheelAt > 300) wheelAcc = 0
      wheelAt = now
      wheelAcc += e.deltaY
      if (now < wheelLock) {
        e.preventDefault()
        return
      }
      if (Math.abs(wheelAcc) < 24) return
      const dir = wheelAcc > 0 ? 'next' : 'prev'
      wheelAcc = 0
      wheelLock = now + 400
      e.preventDefault()
      go(dir)
    }

    const wheelDocs = []

    /* ---------------- issue #15：epub 图片兜底 ---------------- */

    /**
     * 章节里的相对图片路径 → archive blob URL。
     *
     * epub.js 的资源替换（Resources.replacements）是把 manifest 里的路径做「字符串全局替换」，
     * 章节里写成 `./Images/a.jpg`、大小写不同、带百分号编码、或 `../` 层级不一致时一张都换不到，
     * 残留的相对路径会按 iframe 的 <base> 解析成站点地址 → 404 → 静默空白。
     * 这里逐张重解析：按章节目录拼绝对路径交给 archive，任一变体命中 zip 就用它的 blob URL。
     */
    const resolveEpubImage = async (raw, chapterHref) => {
      const dir = chapterHref.includes('/') ? chapterHref.slice(0, chapterHref.lastIndexOf('/') + 1) : ''
      const tidy = (p) => {
        const out = []
        for (const part of p.split('/')) {
          if (!part || part === '.') continue
          if (part === '..') out.pop()
          else out.push(part)
        }
        return out.join('/')
      }
      const bare = raw.split(/[?#]/)[0]
      const variants = new Set([tidy(dir + bare), tidy(bare)])
      // zip 条目名里常见空格 → 章节里写成 %20（或反过来）：两个方向都试
      try {
        variants.add(tidy(dir + decodeURIComponent(bare)))
      } catch {
        /* 非法百分号编码：按原样试 */
      }
      for (const rel of variants) {
        if (!rel) continue
        // 第二个参数 false = 只算 archive 内路径，不要拼站点 URL
        const abs = epubBook.resolve(rel, false)
        if (!abs) continue
        try {
          const url = await epubBook.archive.createUrl(abs)
          if (typeof url === 'string' && url) return url
        } catch {
          /* 这个候选不在 zip 里：试下一个 */
        }
      }
      return null
    }

    /** 逐张兜底替换；失败的加占位样式 + console.warn，现场可定位是哪一章哪张图 */
    const fixContentImages = (contents) => {
      const doc = contents?.document
      if (!doc) return
      try {
        // adjustImages() 用「解析那一刻的 offsetHeight」算 max-height，iframe 还没布局时会算出
        // 0px !important，封面页 / 整页图 / 漫画页整张被压没。改用视口单位重设（本 hook 后注册，
        // 规则追加在后面，同权重下覆盖 epub.js 的写法），布局什么时候完成都不会是 0。
        contents.addStylesheetRules?.({
          img: { 'max-height': 'calc(100vh - 16px) !important', 'object-fit': 'contain' },
          svg: { 'max-height': 'calc(100vh - 16px) !important' },
          'img[data-wb-img="missing"]': {
            'min-height': '64px',
            'min-width': '64px',
            background: 'rgba(127, 127, 127, 0.12)',
            'border-radius': '4px',
          },
        })
      } catch {
        /* 老版本没有 addStylesheetRules：图片仍按原样式显示 */
      }

      const chapter = epubBook.spine?.get(contents.sectionIndex)?.href ?? ''
      const nodes = [...doc.querySelectorAll('img, image')]
      for (const el of nodes) {
        const isSvgImage = el.tagName.toLowerCase() === 'image'
        // 读 attribute 而不是 property：property 会被浏览器按 <base> 展开成 https://…
        const raw = (
          el.getAttribute(isSvgImage ? 'xlink:href' : 'src') ||
          el.getAttribute('href') ||
          ''
        ).trim()
        if (!raw || /^(?:blob:|data:|https?:)/i.test(raw)) continue
        void resolveEpubImage(raw, chapter).then((url) => {
          if (!url) {
            el.setAttribute('data-wb-img', 'missing')
            if (!isSvgImage) el.setAttribute('alt', el.getAttribute('alt') || '图片无法显示')
            console.warn('[reader] epub 图片解析失败', chapter, raw)
            return
          }
          if (isSvgImage) {
            el.setAttribute('href', url)
            el.setAttribute('xlink:href', url)
          } else {
            el.setAttribute('src', url)
          }
          el.setAttribute('data-wb-img', 'ok')
        })
      }
    }

    rendition.hooks.content.register((contents) => {
      const doc = contents?.document
      if (!doc) return
      doc.addEventListener('wheel', onWheel, { passive: false })
      wheelDocs.push(doc)
      fixContentImages(contents)
    })
    view.addEventListener('wheel', onWheel, { passive: false })

    rendition.on('relocated', (loc) => {
      if (!alive()) return
      paintLocation(loc)
      // 新一节的 iframe 渲染完成：立即把背景 / 字号刷上去（themes API 只覆盖新内容，这里兜当前页）
      paintEpubTheme()
      clearTimeout(saveTimer)
      saveTimer = setTimeout(() => {
        if (!alive() || !loc?.start?.cfi) return
        writeStorage(epubPosKey(id), JSON.stringify({ v: version, cfi: loc.start.cfi }))
      }, 400)
    })
    rendition.on('keydown', (e) => {
      if (e.key === 'ArrowLeft') go('prev')
      if (e.key === 'ArrowRight') go('next')
    })

    document.addEventListener('keydown', onKey)
    epubDispose = () => {
      tocSide?.destroy()
      clearTimeout(saveTimer)
      document.removeEventListener('keydown', onKey)
      view.removeEventListener('wheel', onWheel)
      for (const doc of wheelDocs) doc.removeEventListener('wheel', onWheel)
      wheelDocs.length = 0
    }

    const showToc = () => {
      // 宽屏：按钮退化为右侧目录的显隐开关；窄屏仍开弹窗
      if (tocSide?.canToggle()) {
        tocSide.toggle()
        return
      }
      if (!tocItems.length) {
        showDialog('<h2>目录</h2><p class="small muted">这本书没有目录信息，可按方向键或滚轮翻页。</p>', {
          label: '目录',
        })
        return
      }
      const activeHref = chapterAt(currentIndex)?.href
      let marked = false
      const rows = tocItems.map((item) => {
        const active = !marked && item.href === activeHref
        if (active) marked = true
        return { ...item, current: active, no: '' }
      })
      const currentRow = rows.findIndex((row) => row.current)
      const dlg = openTocDialog(rows, { current: currentRow })
      if (!dlg) return
      dlg.body.querySelectorAll('[data-toc-i]').forEach((btn) => {
        btn.onclick = () => {
          const item = rows[Number(btn.dataset.tocI)]
          dlg.close()
          if (item) rendition.display(item.href).catch(() => {})
        }
      })
    }
    tocBtn.onclick = showToc
    stage.querySelector('[data-fab-toc]').onclick = showToc
    prevBtn.onclick = () => go('prev')
    nextBtn.onclick = () => go('next')

    // 上次读到的 CFI：换过文件（版本不同）就从头开始
    const saved = readJson(epubPosKey(id))
    const savedCfi = saved && String(saved.v) === version && typeof saved.cfi === 'string' ? saved.cfi : null
    let restored = false
    if (savedCfi) {
      try {
        await rendition.display(savedCfi)
        restored = true
      } catch {
        /* 旧位置已失效：回第一页 */
      }
    }
    if (!restored) await rendition.display()
    paintLocation(rendition.currentLocation?.() ?? null)

    // 页码 / 百分比要 locations（整本分页统计，异步跑，不挡阅读）
    epubBook.locations
      .generate(1024)
      .then(() => {
        if (alive()) paintProgress()
      })
      .catch(() => {})
  } catch (err) {
    if (alive()) stage.innerHTML = `<div class="alert danger">${esc(err.message)}</div>`
  }
}

/* ---------------- txt ---------------- */

function readStorage(key) {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStorage(key, value) {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* 隐私模式 / 配额满：只影响记忆位置与直跳，不影响阅读 */
  }
}

function readJson(key) {
  try {
    return JSON.parse(readStorage(key) || 'null')
  } catch {
    return null
  }
}

/** 整本解码：识别 BOM / UTF-8 / GB18030 / UTF-16（非常规编码的兜底） */
function decodeTxt(buf) {
  const bytes = new Uint8Array(buf)
  const decode = (label, input = bytes) => new TextDecoder(label).decode(input)
  try {
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      return decode('utf-8', bytes.subarray(3))
    }
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return decode('utf-16le', bytes.subarray(2))
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return decode('utf-16be', bytes.subarray(2))
  } catch {
    /* 个别浏览器不支持 utf-16be，落到下面的兜底 */
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    try {
      return decode('gb18030')
    } catch {
      return decode('utf-8')
    }
  }
}

/**
 * 候选标题打分（>= 3 才收下）。
 * 比「正则命中 + 布尔条件」稳：编号样式 / 独立行 / 短行加分，正文式引用与句末标点减分；
 * 不再强制要求标题带分隔符或前后空行——很多 TXT 段间只有一个换行。
 */
function scoreTxtHeading(text, { first = false, prevBlank = false, nextBlank = false } = {}) {
  const line = String(text ?? '').trim()
  if (!line || line.length > 60) return 0
  const numOnly = TXT_NUM_ONLY.test(line)
  // 独立序号允许以「、」「.」结尾（一、 / 1.），普通标题仍不允许句读结尾
  if (/[。，；：]$/.test(line) || (!numOnly && /、$/.test(line))) return 0
  const numbered = TXT_HEADING.test(line) || TXT_HEADING_EN.test(line) || TXT_STANDALONE.test(line)
  if (!numbered && !numOnly) return 0
  // 纯序号只在独立成行时认（文首 / 前后空行），避免把正文里的列表项拆成章
  if (!numbered && !first && !prevBlank && !nextBlank) return 0
  if (TXT_PROSE_REF.test(line) || (line.length > 12 && TXT_PROSE_WEAK.test(line))) return 0
  let score = numbered ? 3 : 2
  if (numbered && TXT_HEADING_SEP.test(line)) score += 1
  if (first || prevBlank) score += 1
  if (nextBlank) score += 1
  if (line.length <= 30) score += 1
  if (/[，；]/.test(line)) score -= 2
  return score
}

/** 章内小标题（如「2」「（三）」「卷一」）：独立成行、命中标题样式且够短，渲染成居中标题 */
function isTxtHeadLine(line) {
  const s = line.trim()
  if (!s || s.length > 30 || TXT_PROSE_REF.test(s)) return false
  return TXT_HEADING.test(s) || TXT_HEADING_EN.test(s) || TXT_STANDALONE.test(s) || TXT_NUM_ONLY.test(s)
}

/**
 * 整本分章：标题行保留在 lines 里，正文从 bodyStart 开始，重扫目录时不会丢标题。
 * 返回 { chapters: [{ title, bodyStart, end }], sectioned }，end 为章节结束行（不含）。
 */
function splitTxtLines(lines) {
  const blank = (i) => (lines[i] ?? '').trim() === ''
  const marks = []
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim()
    if (!line) continue
    if (scoreTxtHeading(line, { first: i === 0, prevBlank: blank(i - 1), nextBlank: blank(i + 1) }) < 3) continue
    marks.push(i)
  }

  if (marks.length >= 2) {
    const chapters = []
    // 第一个标题之前的内容（书名 / 作者 / 引子）单独列为「开篇」
    if (marks[0] > 0 && lines.slice(0, marks[0]).join('').trim()) {
      chapters.push({ title: '开篇', bodyStart: 0, end: marks[0] })
    }
    marks.forEach((start, i) => {
      const end = i + 1 < marks.length ? marks[i + 1] : lines.length
      chapters.push({
        title: lines[start].trim().replace(/^#+\s*/, '').slice(0, 60),
        bodyStart: start + 1,
        end,
      })
    })
    return { chapters, sectioned: false }
  }

  return { chapters: splitByLength(lines), sectioned: true }
}

/** 没有章节标题的书按字数分节；开头的书名 / 作者等元信息单独列为「开篇」 */
function splitByLength(lines, limit = SECTION_CHARS) {
  const bodyStart = findTxtBodyStart(lines)
  const chapters = []
  if (bodyStart > 0) chapters.push({ title: '开篇', bodyStart: 0, end: bodyStart })

  let start = bodyStart
  let size = 0
  let no = 0
  for (let i = bodyStart; i < lines.length; i += 1) {
    size += lines[i].length + 1
    if (size >= limit && i + 1 < lines.length) {
      no += 1
      chapters.push({ title: `第 ${no} 节`, bodyStart: start, end: i + 1 })
      start = i + 1
      size = 0
    }
  }
  if (start < lines.length) {
    no += 1
    chapters.push({ title: `第 ${no} 节`, bodyStart: start, end: lines.length })
  }
  return chapters.length ? chapters : [{ title: '正文', bodyStart: 0, end: lines.length }]
}

/**
 * 分节时跳过开头的书名 / 作者 / 版权等元信息，返回正文首行下标。
 * 只跳「连续出现在文件开头」的元信息行，正文第一段再短也保留。
 */
function findTxtBodyStart(lines) {
  const isMeta = (s) =>
    /^[《〈].+[》〉]$/.test(s) ||
    /^(?:书名|作者|译者|出版社|出版|版权|简介|内容简介|声明|来源)[:：]/.test(s) ||
    /^(?:更多精彩|本书由|www\.|https?:)/i.test(s)
  let i = 0
  while (i < lines.length && i < 40) {
    const s = lines[i].trim()
    if (s && !isMeta(s)) break
    i += 1
  }
  return i < lines.length ? i : 0
}

/**
 * 统计 needle 在 text 中出现的次数（字面量、不重叠）。
 * 右键「批量删除广告」用它先给用户一个确切的影响面：命中几处再决定删不删。
 */
function countOccurrences(text, needle) {
  if (!needle) return 0
  let count = 0
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + needle.length)) count += 1
  return count
}

/**
 * 整本删掉一段文字（字面量，不按正则）：单行内命中就删掉匹配文字，
 * 删完只剩空白的行整行去掉（盗版站广告通常独占一行，留着空行会多出空档）。
 * 选中内容跨行时按整段删除。返回 { text, count }。
 */
function removeAllText(source, needle) {
  if (needle.includes('\n')) {
    const count = countOccurrences(source, needle)
    return { text: source.split(needle).join(''), count }
  }
  const out = []
  let count = 0
  for (const line of source.split('\n')) {
    const hits = countOccurrences(line, needle)
    if (!hits) {
      out.push(line)
      continue
    }
    count += hits
    const next = line.split(needle).join('').replace(/[ \t\u3000]+$/, '')
    if (!next.trim() && line.trim()) continue
    out.push(next)
  }
  return { text: out.join('\n'), count }
}

/** 复制选中文字：优先 Clipboard API，失败退回 execCommand（http 局域网 / 权限被拒时） */
async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    /* 走下面的兜底 */
  }
  const el = document.createElement('textarea')
  el.value = text
  el.setAttribute('readonly', '')
  el.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0'
  document.body.append(el)
  el.select()
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  el.remove()
  return ok
}

/**
 * TXT 阅读器：整本下载 → 解码 → 分章，页脚进度按全书字符位置计算。
 *
 * 早先按字节分块拉：进度只能用「已经下载到哪」估算，跳章 / 只读半本时经常不准。
 * 现在一次读完（下载过程显示大小与百分比，URL 带 ?v= 可长缓存，第二次打开直接命中），
 * 章节表与总进度都来自整本内容；UTF-16 等非常规编码也走同一条路。
 */
function openTxtReader(id, title, version, fileUrl, sizeHint, stage, setChapter, filename) {
  stage.innerHTML = `
    <div class="reader-body">
      <div class="txt-reader">
        <div class="txt-body" data-body tabindex="0" role="document" aria-label="${esc(title)}">${loadingBlock('正在加载正文…')}</div>
      </div>
      ${tocSideHtml({ refresh: true })}
    </div>
    ${fabHtml()}
    ${footerHtml({ prev: '上一章', next: '下一章' })}`

  const root = stage
  const body = root.querySelector('[data-body]')
  const prevBtn = root.querySelector('[data-prev]')
  const nextBtn = root.querySelector('[data-next]')
  const tocBtn = root.querySelector('[data-toc]')
  /** 右侧目录控制器：整本分章后一次建好，换章只同步高亮 */
  let tocSide = null

  /** 整本按行切开（含标题行）；正文渲染从章节的 bodyStart 开始 */
  const lines = []
  /** [{ title, bodyStart, end, start, chars }]：start/chars 是全书字符区间，用来算总进度 */
  let chapters = []
  let totalChars = 0
  let index = 0
  /** 没有章节标题、按字数分节 */
  let sectioned = false

  let fontSize = Number(readStorage(TXT_FONT_KEY)) || 21
  let lineHeight = Number(readStorage(TXT_LINE_KEY)) || 1.5
  let saveTimer = 0
  let rafPending = false
  let disposed = false
  let loading = true
  /** 整本原文（解码后，仅用于右键「批量删除」重写文件；分章用 buildBook 的副本） */
  let fullText = ''

  // 旧版按字节分块时缓存的「章节字节表」已经没用了（大书能占不少配额），顺手清掉
  try {
    localStorage.removeItem(`book:txt:idx:${id}`)
  } catch {
    /* 隐私模式 / 存储禁用：清不掉也不影响阅读 */
  }

  /** 加载态文案（整本下载 / 解析阶段），加载完由 paintProgress() 覆盖回百分比 */
  function say(text) {
    const el = body.querySelector('.loading span:last-child')
    if (el) el.textContent = text
  }

  function paintFont() {
    body.style.fontSize = `${fontSize}px`
    body.style.lineHeight = String(lineHeight)
  }

  // ---------- 位置 / 进度 ----------

  function scrollRatio() {
    const max = body.scrollHeight - body.clientHeight
    return max > 0 ? Math.min(1, Math.max(0, body.scrollTop / max)) : 0
  }

  /** 当前读到的全书字符位置 = 本章起始位置 + 章内滚动比例 × 本章字数 */
  function currentCharPos() {
    const c = chapters[index]
    return c ? c.start + c.chars * scrollRatio() : 0
  }

  /** 字符位置 → 章号 + 章内比例（重新生成目录后回到原来的位置） */
  function locateChar(pos) {
    if (!chapters.length) return { index: 0, ratio: 0 }
    let hit = 0
    for (let i = 0; i < chapters.length; i += 1) {
      if (chapters[i].start <= pos) hit = i
      else break
    }
    const c = chapters[hit]
    const ratio = c.chars > 0 ? Math.min(1, Math.max(0, (pos - c.start) / c.chars)) : 0
    return { index: hit, ratio }
  }

  /** 总进度：从第一章正文到全书末尾的字符比例（不是「已下载多少」） */
  function currentRatio() {
    const c = chapters[index]
    if (!c || !totalChars) return 0
    const base = chapters[0]?.start || 0
    const span = Math.max(1, totalChars - base)
    return Math.min(1, Math.max(0, (c.start + c.chars * scrollRatio() - base) / span))
  }

  function paintProgress() {
    const ratio = currentRatio()
    setProgress(
      root,
      ratio,
      `${Math.round(ratio * 100)}%`,
      [index + 1, chapters[index]?.title].filter(Boolean).join(' '),
    )
    reportProgress?.report(ratio)
  }

  function savePos() {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      if (!disposed && chapters.length) {
        writeStorage(txtPosKey(id), JSON.stringify({ v: version, c: index, r: scrollRatio() }))
      }
    }, 300)
  }

  // ---------- 分章 / 目录 ----------

  /** 把整本文字切成行并分章；chapter.start/chars 是用于总进度的字符区间 */
  function buildBook(text) {
    lines.length = 0
    for (const line of text.replace(/\r\n?/g, '\n').split('\n')) lines.push(line)

    // 极端情况：整本没有换行（一行几十万字），先切成伪行，避免一个文本节点把页面拖住
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].length <= SECTION_CHARS * 2) continue
      const parts = []
      for (let at = 0; at < lines[i].length; at += SECTION_CHARS) parts.push(lines[i].slice(at, at + SECTION_CHARS))
      lines.splice(i, 1, ...parts)
    }

    const offsets = new Array(lines.length)
    let at = 0
    for (let i = 0; i < lines.length; i += 1) {
      offsets[i] = at
      at += lines[i].length + 1
    }
    totalChars = Math.max(1, at)

    const parsed = splitTxtLines(lines)
    sectioned = parsed.sectioned
    chapters = parsed.chapters.map((c) => {
      const start = offsets[c.bodyStart] ?? at
      const end = c.end < lines.length ? offsets[c.end] : at
      return { ...c, start, chars: Math.max(0, end - start) }
    })
    index = Math.max(0, Math.min(chapters.length - 1, index))
    paintToc()
  }

  function paintToc() {
    tocSide?.setRows(
      chapters.map((c, i) => ({ label: c.title, i })),
      sectioned ? '没有章节标题，已按字数分节' : '',
    )
  }

  /** 跳章：章节表已经完整，直接切换（不再需要下载） */
  function jump(target) {
    if (disposed || !chapters.length) return
    index = Math.max(0, Math.min(chapters.length - 1, target))
    paint()
  }

  function paint(ratio = null, keepScroll = false) {
    if (!chapters.length) return
    index = Math.max(0, Math.min(chapters.length - 1, index))
    const c = chapters[index]

    const top = keepScroll ? body.scrollTop : 0
    // 一行一段渲染：段间空行只作分段标记（间距交给 margin），章内小标题渲染成居中标题
    const paras = []
    for (const raw of lines.slice(c.bodyStart, c.end)) {
      const text = raw.trim()
      if (!text) continue
      paras.push(`<p${isTxtHeadLine(text) ? ' class="txt-head"' : ''}>${esc(text)}</p>`)
    }
    body.innerHTML = paras.join('') || '<p class="txt-head">（这一章还是空的）</p>'
    body.scrollTop = top
    if (ratio != null && ratio > 0) {
      requestAnimationFrame(() => {
        if (disposed) return
        body.scrollTop = ratio * Math.max(0, body.scrollHeight - body.clientHeight)
        paintProgress()
      })
    }

    prevBtn.disabled = index === 0 || loading
    nextBtn.disabled = index >= chapters.length - 1 || loading
    setChapter(c.title)
    tocSide?.setCurrent(index)
    paintProgress()
    savePos()
  }

  /** 手动重算目录：算法更新或识别不准时重扫整本（不重新下载） */
  function regenerateToc() {
    if (disposed || loading || !lines.length) return
    const pos = currentCharPos()
    buildBook(lines.join('\n'))
    // 章号可能因算法变化而改变：按原来的字符位置回到对应章节
    const target = locateChar(pos)
    index = target.index
    paint(target.ratio)
    toast('目录已重新生成')
  }

  /** 右侧目录：整本分章后一次建好，点击直接跳章 */
  tocSide = createTocSide(stage, (row) => jump(row.i))
  stage.querySelector('[data-toc-refresh]')?.addEventListener('click', () => regenerateToc())

  // ---------- 交互 ----------

  const onScroll = () => {
    savePos()
    if (rafPending) return
    rafPending = true
    requestAnimationFrame(() => {
      rafPending = false
      if (!disposed) paintProgress()
    })
  }

  const onKey = (e) => {
    if (document.getElementById('dlg')?.open) return
    // 右键菜单打开时方向键归菜单，不要在背后翻章
    if (ctx) return
    if (e.target instanceof HTMLSelectElement || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
      return
    }
    if (e.key === 'ArrowLeft') {
      e.preventDefault()
      jump(index - 1)
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      jump(index + 1)
    }
  }

  function openToc() {
    if (!chapters.length) {
      showDialog('<h2>目录</h2><p class="small muted">目录还在加载，稍后再试。</p>', { label: '目录' })
      return
    }
    const rows = chapters.map((c) => ({ label: c.title, no: '' }))
    const dlg = openTocDialog(rows, {
      empty: '这本书没有目录信息。',
      hint: sectioned ? '没有章节标题，已按字数分节' : '',
      current: index,
      onRegenerate: regenerateToc,
    })
    if (!dlg) return
    dlg.body.querySelectorAll('[data-toc-i]').forEach((btn) => {
      btn.onclick = () => {
        const target = Number(btn.dataset.tocI)
        dlg.close()
        jump(target)
      }
    })
  }

  // ---------- 右键菜单：复制 / 批量删除广告 ----------

  /** 当前打开的右键菜单（同一时间只留一个） */
  let ctx = null
  /** 正在重写文件：上传队列串行，但第二条删除要等第一条落地后再让用户操作 */
  let purging = false

  function closeCtx() {
    if (!ctx) return
    const { el, onPointer, onMenuKey, onMove } = ctx
    ctx = null
    el.remove()
    document.removeEventListener('pointerdown', onPointer, true)
    document.removeEventListener('keydown', onMenuKey)
    window.removeEventListener('scroll', onMove, true)
    window.removeEventListener('resize', onMove)
  }

  function openCtx(x, y, text) {
    closeCtx()
    const el = document.createElement('div')
    el.className = 'more-menu is-fixed ctx-menu'
    el.setAttribute('role', 'menu')
    el.innerHTML = `<button class="more-item" type="button" role="menuitem" data-ctx-copy>${icon('copy', 14)}复制</button>
      <button class="more-item danger" type="button" role="menuitem" data-ctx-purge>${icon('trash', 14)}批量删除广告</button>`
    // 先挂到 body 量尺寸再定位：fixed 定位不会被 .txt-body 的滚动容器裁掉
    el.style.visibility = 'hidden'
    el.style.top = '0px'
    el.style.left = '0px'
    document.body.append(el)
    el.style.left = `${Math.max(8, Math.min(x, window.innerWidth - el.offsetWidth - 8))}px`
    el.style.top = `${Math.max(8, Math.min(y, window.innerHeight - el.offsetHeight - 8))}px`
    el.style.visibility = ''

    const onPointer = (e) => {
      if (!el.contains(e.target)) closeCtx()
    }
    const onMenuKey = (e) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      closeCtx()
    }
    const onMove = () => closeCtx()
    ctx = { el, onPointer, onMenuKey, onMove }
    document.addEventListener('pointerdown', onPointer, true)
    document.addEventListener('keydown', onMenuKey)
    window.addEventListener('scroll', onMove, true)
    window.addEventListener('resize', onMove)

    el.querySelector('[data-ctx-copy]').addEventListener('click', async () => {
      closeCtx()
      const ok = await copyToClipboard(text)
      toast(ok ? '已复制' : '复制失败，请用 Ctrl+C', !ok)
    })
    el.querySelector('[data-ctx-purge]').addEventListener('click', () => {
      closeCtx()
      purgeSelected(text)
    })
    el.querySelector('.more-item')?.focus({ preventScroll: true })
  }

  /** 只在选中正文文字时接管右键；没选中就让浏览器原生菜单出现 */
  const onContextMenu = (e) => {
    const sel = window.getSelection()
    const text = sel?.toString() ?? ''
    if (!text.trim() || !sel?.rangeCount || !body.contains(sel.anchorNode)) return
    e.preventDefault()
    let x = e.clientX
    let y = e.clientY
    // 键盘（Shift+F10 / 菜单键）触发的右键没有鼠标坐标：贴着选区放
    if (!x && !y) {
      const rect = sel.getRangeAt(0).getBoundingClientRect()
      x = rect.left
      y = rect.bottom
    }
    openCtx(x, y, text)
  }

  /**
   * 批量删除选中文字：整本已在内存（fullText），先算命中数让用户确认，
   * 再把删好的正文当成新文件重传——r2_key 换新 uuid = 新版本号，旧缓存自动失效。
   */
  function purgeSelected(raw) {
    const target = String(raw ?? '').trim()
    if (target.length < 2) {
      toast('请先选中至少 2 个字再删除', true)
      return
    }
    if (loading || !fullText) {
      toast('正文还在加载，稍后再试', true)
      return
    }
    if (purging) {
      toast('上一次删除还在写入，请稍候', true)
      return
    }
    // 统一换行：显示与选择都基于 LF，原文可能是 CRLF
    const source = fullText.replace(/\r\n?/g, '\n')
    const { text: nextText, count } = removeAllText(source, target)
    if (!count) {
      toast('正文里没有找到这段文字')
      return
    }
    const preview = target.length > 40 ? `${target.slice(0, 40)}…` : target
    const dlg = showDialog(
      `<h2>批量删除广告</h2>
       <p>将从《${esc(title)}》的原文件里删除所有 <code>${esc(preview)}</code>，共 <strong>${count}</strong> 处。</p>
       <p class="small muted">删除会重写原文件（按 UTF-8 保存，无法撤销），阅读位置会尽量保留。</p>
       <div class="dlg-foot">
         <button class="btn" type="button" data-cancel>取消</button>
         <button class="btn danger" type="button" data-go>${icon('trash', 14)}删除 ${count} 处</button>
       </div>`,
      { label: '批量删除广告' },
    )
    dlg.body.querySelector('[data-cancel]').onclick = () => dlg.close()
    dlg.body.querySelector('[data-go]').onclick = () => {
      dlg.close()
      rewriteFile(nextText, count)
    }
  }

  /** 把删好的正文写成新文件重传（复用上传队列：小文件单请求、大文件自动分片） */
  function rewriteFile(text, count) {
    const base = String(filename || title || 'book')
    const name = /\.txt$/i.test(base) ? base : `${base}.txt`
    const bytes = new TextEncoder().encode(text)
    if (!bytes.length) {
      toast('删除后正文为空，已取消', true)
      return
    }
    let file
    try {
      file = new File([bytes], name, { type: 'text/plain' })
    } catch (err) {
      toast(err?.message || '生成新文件失败', true)
      return
    }
    // 上传成功后版本号会变：先记一个「不带版本」的位置，重开时仍回到当前章
    const pos = { v: null, c: index, r: scrollRatio() }
    purging = true
    const batch = enqueue([file], {
      title: `批量删除广告（${count} 处）`,
      params: { bookId: id },
      url: (qs) => `/api/book/upload?${qs}`,
      contentType: () => 'text/plain;charset=utf-8',
      processingLabel: '正在写入原文件…',
      onSettled: (summary) => {
        purging = false
        if (!summary.ok) {
          toast('写入失败，原文件未改动', true)
          return
        }
        writeStorage(txtPosKey(id), JSON.stringify(pos))
        toast(`已删除 ${count} 处，正在重新打开…`)
        const m = /^#\/reader\?id=(\d+)/.exec(location.hash)
        if (m && Number(m[1]) === id) setTimeout(() => location.reload(), 600)
      },
    })
    if (!batch) {
      purging = false
      toast('上传面板不可用，请刷新后重试', true)
    }
  }

  txtReader = {
    cleanup() {
      if (disposed) return
      if (chapters.length) writeStorage(txtPosKey(id), JSON.stringify({ v: version, c: index, r: scrollRatio() }))
      disposed = true
      closeCtx()
      tocSide?.destroy()
      clearTimeout(saveTimer)
      body.removeEventListener('scroll', onScroll)
      body.removeEventListener('contextmenu', onContextMenu)
      document.removeEventListener('keydown', onKey)
    },
  }

  paintFont()
  body.addEventListener('scroll', onScroll, { passive: true })
  body.addEventListener('contextmenu', onContextMenu)
  document.addEventListener('keydown', onKey)
  prevBtn.disabled = true
  nextBtn.disabled = true
  prevBtn.onclick = () => jump(index - 1)
  nextBtn.onclick = () => jump(index + 1)
  const showToc = () => {
    // 宽屏：按钮退化为右侧目录的显隐开关；窄屏仍开弹窗
    if (tocSide?.canToggle()) {
      tocSide.toggle()
      return
    }
    openToc()
  }
  tocBtn.onclick = showToc
  // 悬浮工具栏：目录 / 阅读设置（字号 + 行距 + 背景）/ 背景循环；先刷一次主题钮图标
  setReaderTheme(root, root.dataset.readerTheme || 'paper')
  stage.querySelector('[data-fab-toc]').onclick = showToc
  stage.querySelector('[data-fab-set]').onclick = () => {
    openReaderSettings({
      theme: root.dataset.readerTheme || 'paper',
      font: {
        value: fontSize,
        min: 14,
        max: 26,
        onFont: (n) => {
          fontSize = n
          paintFont()
          writeStorage(TXT_FONT_KEY, String(n))
        },
      },
      line: {
        value: lineHeight,
        options: LINE_OPTIONS,
        onLine: (v) => {
          lineHeight = v
          paintFont()
          writeStorage(TXT_LINE_KEY, String(v))
        },
      },
      onTheme: (id) => setReaderTheme(root, id),
    })
  }
  stage.querySelector('[data-fab-theme]').onclick = () => cycleTheme(root)

  // 整本下载 + 解码 + 分章：URL 带版本号，服务端长缓存，第二次打开基本秒开
  ;(async () => {
    try {
      const hint = Number(sizeHint) || 0
      if (hint) say(`正在下载 ${fmtSize(hint)}…`)
      const res = await fetch(fileUrl)
      if (!res.ok) throw new Error(`打开失败：HTTP ${res.status}`)
      const bytes = await readBodyWithProgress(res, (got, total) => {
        const all = total || hint || got
        const pct = all ? Math.round((got / all) * 100) : 0
        setProgress(root, all ? got / all : 0, `${pct}%`, '正在下载')
        say(`正在下载 ${fmtSize(got)} / ${fmtSize(all)}（${pct}%）`)
      })
      if (disposed) return
      say('正在解析正文…')
      const text = decodeTxt(bytes.buffer)
      if (disposed) return
      if (!text.trim()) {
        loading = false
        body.innerHTML = '<div class="empty">这个文件里没有可显示的文字。</div>'
        return
      }

      buildBook(text)
      fullText = text
      loading = false

      // 上次读到第几章 + 章内位置（换过文件就从头开始）
      const pos = readJson(txtPosKey(id))
      const same = !pos || pos.v == null || String(pos.v) === version
      index = same && Number.isInteger(pos?.c) ? pos.c : 0
      const ratio = same && typeof pos?.r === 'number' ? pos.r : null
      paint(ratio)
    } catch (err) {
      if (disposed) return
      loading = false
      body.innerHTML = `<div class="alert danger">${esc(err?.message || '打开失败')}</div>`
    }
  })()
}

/* ---------------- 小工具 ---------------- */

export function destroy() {
  try {
    epubDispose?.()
  } catch {
    /* 已释放 */
  }
  epubDispose = null
  try {
    epubBook?.destroy()
  } catch {
    /* 已释放 */
  }
  epubBook = null
  try {
    txtReader?.cleanup()
  } catch {
    /* 已释放 */
  }
  txtReader = null
  try {
    reportProgress?.flush()
  } catch {
    /* 上报失败只影响书架进度条 */
  }
  reportProgress = null
}
