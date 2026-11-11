/**
 * 阅读页（独立路由 #/reader?id=）：epub / pdf / txt 都在整页里读，不再塞进弹窗。
 *
 * 跨境链路只有 ~84KB/s（实测），所以「打开一本书」的成本主要在传输，三层处理：
 * - 所有文件 URL 带 ?v=<updatedAt>：换文件必然换版本，服务端据此回 immutable 长缓存（core/files.ts），
 *   第二次打开不再重新下载
 * - txt：按字节分块拉（首块 256KB）→ 流式解码 → 增量找「第X章」，一次只下当前读到的地方；
 *   章节字节表存 localStorage（键带版本号），下次直接跳到上次读到那一章
 * - epub：库不支持 Range，仍是整本 ArrayBuffer，但脚本与文件并行下载 + 显示进度
 *   （/api/book/read/:id 没有 .epub 后缀，交给库按 URL 找目录会 404）
 * - pdf：浏览器原生查看器（Worker 透传 Range，渐进加载）
 *
 * 版式：顶栏只放书名 + 当前章，翻页 / 目录 / 字号 / 进度全部下沉到页脚，
 * 正文列宽固定（epub 单页 760px），宽屏上不把文字与插图拉满整屏。
 * 位置 / 字号存 localStorage：只影响记忆，不影响阅读；销毁时释放 epub 实例与定时器。
 */
import { api, esc, icon, loadScriptOnce, showDialog } from '../lib.js'
import { loadingBlock } from '../ui.js'

const TXT_FONT_KEY = 'book:txt:font'
const txtPosKey = (id) => `book:txt:pos:${id}`
const txtIdxKey = (id) => `book:txt:idx:${id}`
const epubPosKey = (id) => `book:epub:pos:${id}`

/** 首块 256KB：84KB/s 下约 3s 出正文；后续每块 512KB，翻章时不够再续 */
const TXT_CHUNK = 256 * 1024
const TXT_CHUNK_MORE = 512 * 1024
/** localStorage 里最多记这么多章，避免大书把 5MB 配额塞满 */
const TXT_INDEX_MAX = 3000
/** 一屏约 1–2KB，12000 字足够翻好几屏；没有章节标题的书按这个长度分节 */
const SECTION_CHARS = 12000

/** 章节标题：行首「第X章/卷/回…」、常见卷首语，或 markdown 标题 */
const TXT_HEADING = /^(?:第\s*[0-9零一二三四五六七八九十百千万两]+\s*[章节回卷部篇集]|(?:序章|序言|楔子|引子|前言|后记|尾声|终章|番外)|#{1,3}\s)/
/** 章节号后紧跟空格 / 冒号 / 顿号等分隔符：最可靠的标题样式 */
const TXT_HEADING_SEP = /^第\s*[0-9零一二三四五六七八九十百千万两]+\s*[章节回卷部篇集](?:\s|$|[:：、·—\-])/

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
    <div class="reader-bar">
      <div class="reader-title">
        <h1 class="page-title" title="${esc(title)}">${esc(title)}</h1>
        <p class="page-sub">
          <span class="reader-chapter" data-chapter hidden></span>
          <span data-meta>${esc(meta)}</span>
        </p>
      </div>
    </div>
    <div class="reader-stage" id="reader-stage"></div>`

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

  // 翻开的书从「待读」前进到「阅读中」（已读不倒退；失败静默，不挡阅读）
  if (book.status === 'unread') {
    api(`/api/book/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'reading' }) }).catch(() => {})
  }

  const stage = main.querySelector('#reader-stage')
  if (!book.hasFile) {
    stage.innerHTML = '<div class="empty">这本书还没有上传文件，回书架点「上传文件」。</div>'
    return
  }

  if (book.fmt === 'pdf') {
    // PDF 交给浏览器原生查看器：自带缩放 / 页码 / 目录，不再叠加一层页脚
    stage.innerHTML = `<iframe class="reader-frame" src="${esc(fileUrl)}" title="${esc(title)}"></iframe>`
    return
  }
  if (book.fmt === 'txt') {
    openTxtReader(id, title, version, fileUrl, book.size, stage, setChapter)
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

/** 目录弹窗：rows = [{ label, depth?, attrs }]，点击回调由调用方接在 data-toc-i 上 */
function openTocDialog(rows, { empty = '这本书没有目录信息。', hint = '', current = -1 } = {}) {
  if (!rows.length) {
    showDialog(`<h2>目录</h2><p class="small muted">${esc(empty)}</p>`, { label: '目录' })
    return null
  }
  const html = `<h2>目录</h2>
    <ol class="reader-toc">
      ${rows
        .map(
          (row, i) => `<li class="reader-toc-item" data-depth="${Math.min(row.depth ?? 0, 3)}">
            <button class="reader-toc-btn" type="button" data-toc-i="${i}"${
              i === current ? ' aria-current="true"' : ''
            }>${row.no ? `<span class="reader-toc-no">${esc(row.no)}</span>` : ''}${esc(row.label)}</button>
          </li>`,
        )
        .join('')}
    </ol>
    ${hint ? `<p class="reader-toc-hint small muted">${esc(hint)}</p>` : ''}`

  const dlg = showDialog(html, { label: '目录' })
  dlg.body.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest' })
  return dlg
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
      <div class="reader-page"><div class="reader-view" data-view></div></div>
      ${footerHtml({ stat: true })}`

    const view = stage.querySelector('[data-view]')
    const prevBtn = stage.querySelector('[data-prev]')
    const nextBtn = stage.querySelector('[data-next]')
    const tocBtn = stage.querySelector('[data-toc]')

    epubBook = window.ePub(bytes.buffer)
    // spread:'none' + 窄栏：宽屏上仍然是一页一行字，图片不会被拉满整屏
    const rendition = epubBook.renderTo(view, { width: '100%', height: '100%', spread: 'none' })
    const go = (dir) => Promise.resolve(rendition[dir]()).catch(() => {})

    // 深色主题：epub 自带样式多为黑字，不覆盖会在深色底上看不清
    if (document.documentElement.dataset.theme === 'dark') {
      try {
        rendition.themes.override('color', '#e8efee')
        rendition.themes.override('background', '#131c1c')
      } catch {
        /* 主题接口不可用时按原书样式显示，不影响阅读 */
      }
    }

    // 目录（navigation 解析很快，先拿到才能把 href 映射成 spine 序号）
    const nav = await epubBook.loaded.navigation.catch(() => null)
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
    }

    const paintLocation = (loc) => {
      if (!alive()) return
      lastLoc = loc || lastLoc
      currentIndex = Number.isInteger(lastLoc?.start?.index) ? lastLoc.start.index : 0
      // 目录缺失或落在两章之间时，退回节序号，标题栏始终有内容
      setChapter(chapterAt(currentIndex)?.label || (totalSections ? `第 ${currentIndex + 1} 节` : ''))
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
    rendition.hooks.content.register((contents) => {
      const doc = contents?.document
      if (!doc) return
      doc.addEventListener('wheel', onWheel, { passive: false })
      wheelDocs.push(doc)
    })
    view.addEventListener('wheel', onWheel, { passive: false })

    rendition.on('relocated', (loc) => {
      if (!alive()) return
      paintLocation(loc)
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
      clearTimeout(saveTimer)
      document.removeEventListener('keydown', onKey)
      view.removeEventListener('wheel', onWheel)
      for (const doc of wheelDocs) doc.removeEventListener('wheel', onWheel)
      wheelDocs.length = 0
    }

    tocBtn.onclick = () => {
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

/** 整本解码（UTF-16 等非常规编码 / 分块用不上时的兜底） */
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

/** 按「第X章」切分；切不出来（如短篇、无标题）按字数分节，避免整本塞进 DOM */
function splitTxtChapters(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const blank = (i) => (lines[i] ?? '').trim() === ''
  const marks = []
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim()
    if (!line || line.length > 60) continue
    if (!TXT_HEADING.test(line) || /[。，；：、]$/.test(line)) continue
    // 散文里也会出现「第三章讲的是…」这种行：只认有分隔符、被空行包住或文首/标题语的行
    const solid =
      TXT_HEADING_SEP.test(line) ||
      i === 0 ||
      blank(i - 1) ||
      blank(i + 1) ||
      /^#{1,3}\s/.test(line) ||
      /^(?:序章|序言|楔子|引子|前言|后记|尾声|终章|番外)/.test(line)
    if (solid) marks.push(i)
  }

  if (marks.length >= 2) {
    const chapters = []
    const head = lines.slice(0, marks[0])
    if (head.join('').trim()) chapters.push({ title: '开篇', lines: head })
    marks.forEach((start, i) => {
      const end = i + 1 < marks.length ? marks[i + 1] : lines.length
      const chunk = lines.slice(start, end)
      chapters.push({ title: chunk[0].trim().replace(/^#+\s*/, '').slice(0, 60), lines: chunk.slice(1) })
    })
    return chapters
  }
  return chunkByLength(lines)
}

function chunkByLength(lines, limit = SECTION_CHARS) {
  const chapters = []
  let buf = []
  let size = 0
  const flush = () => {
    if (!buf.length) return
    chapters.push({ title: `第 ${chapters.length + 1} 节`, lines: buf })
    buf = []
    size = 0
  }
  for (const line of lines) {
    if (line.length > limit) {
      flush()
      for (let i = 0; i < line.length; i += limit) {
        chapters.push({ title: `第 ${chapters.length + 1} 节`, lines: [line.slice(i, i + limit)] })
      }
      continue
    }
    buf.push(line)
    size += line.length + 1
    if (size >= limit) flush()
  }
  flush()
  return chapters.length ? chapters : [{ title: '正文', lines: ['（空文件）'] }]
}

/**
 * TXT 阅读器：按字节分块下载 + 增量分章。
 *
 * 状态模型：只有一个「窗口」——从某个字节开始的一段已下载内容（lines 数组）。
 * 章节以 line / byte 记录，窗口内相对下标 + chapterBase 换算成全局章号。
 * 允许从任意章的字节直接开新窗口（读过的章在 localStorage 里有字节表），
 * 所以「跳到第 300 章」= 一个 Range 请求，而不是把前 299 章都下下来。
 */
function openTxtReader(id, title, version, fileUrl, sizeHint, stage, setChapter) {
  stage.innerHTML = `
    <div class="txt-reader">
      <div class="txt-body" data-body tabindex="0" role="document" aria-label="${esc(title)}">${loadingBlock('正在加载正文…')}</div>
    </div>
    ${footerHtml({ prev: '上一章', next: '下一章', font: true })}`

  const root = stage
  const body = root.querySelector('[data-body]')
  const prevBtn = root.querySelector('[data-prev]')
  const nextBtn = root.querySelector('[data-next]')
  const tocBtn = root.querySelector('[data-toc]')

  /** 窗口内的行（不含换行符）与章节；章节 line = 标题行，bodyStart = 正文首行 */
  const lines = []
  const marks = []
  let chapters = []
  let index = 0
  let chapterBase = 0
  let windowStart = 0

  let decoder = null
  let encoding = null
  let legacy = false
  /** 未成行的残字节 + 它在文件里的绝对偏移 */
  let rest = new Uint8Array(0)
  let restPos = 0
  let nextByte = 0
  let totalBytes = Number(sizeHint) || 0
  let haveAll = false
  let loading = false
  let disposed = false
  let pendingLine = null
  let headHasText = false
  let sectionChars = 0
  let mode = 'chapters'

  /** 跨窗口的全局章节表（localStorage 里的那份），用于直跳与目录 */
  const known = new Map()

  let fontSize = Number(readStorage(TXT_FONT_KEY)) || 17
  let saveTimer = 0
  let idxTimer = 0
  let rafPending = false

  const cached = readIndex()
  for (const c of cached.chapters ?? []) known.set(c.i, { t: c.t, b: c.b })
  if (cached.enc) encoding = cached.enc

  const isBlank = (i) => (lines[i] ?? '').trim() === ''

  const scrollRatio = () => {
    const max = body.scrollHeight - body.clientHeight
    return max > 0 ? Math.min(1, Math.max(0, body.scrollTop / max)) : 0
  }

  const currentPos = () => ({ c: index + chapterBase, r: scrollRatio() })

  function paintFont() {
    body.style.fontSize = `${fontSize}px`
  }

  /** 加载态文案：借用进度百分比的位置，加载完由 paintProgress() 覆盖回百分比 */
  function say(text) {
    const label = root.querySelector('[data-progress-text]')
    if (label) label.textContent = text
  }

  // ---------- localStorage ----------

  function readIndex() {
    const raw = readJson(txtIdxKey(id))
    if (!raw || String(raw.v) !== version) return {}
    return raw
  }

  function saveIndex() {
    clearTimeout(idxTimer)
    idxTimer = setTimeout(() => {
      if (disposed) return
      try {
        const rows = [...known.entries()]
          .filter(([, v]) => v.b != null)
          .sort((a, b) => a[0] - b[0])
          .slice(0, TXT_INDEX_MAX)
          .map(([i, v]) => ({ i, t: v.t, b: v.b }))
        writeStorage(txtIdxKey(id), JSON.stringify({ v: version, size: totalBytes, enc: encoding, chapters: rows }))
      } catch {
        /* 存不下就算了，只影响下次直跳 */
      }
    }, 600)
  }

  function savePos() {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      if (!disposed && chapters.length) writeStorage(txtPosKey(id), JSON.stringify(currentPos()))
    }, 300)
  }

  // ---------- 进度 ----------

  /** 有字节表就按「本章起始字节 + 章内滚动比例」估算，否则退回按章序号 */
  function currentRatio() {
    const local = index + chapterBase
    const ratio = scrollRatio()
    const start = known.get(local)?.b
    if (start != null && totalBytes) {
      // 下一章字节未知（本章还没下完）时，用已下载到的位置当章尾，避免一屏就冲到 100%
      const next = known.get(local + 1)?.b
      const end = next != null && next > start ? next : Math.max(restPos, start + 1)
      return Math.min(1, (start + (end - start) * ratio) / totalBytes)
    }
    const total = Math.max(chapters.length, known.size, 1)
    return Math.min(1, (index + ratio) / total)
  }

  function paintProgress() {
    const ratio = currentRatio()
    setProgress(root, ratio, `${Math.round(ratio * 100)}%`, [chapterBase + index + 1, chapters[index]?.title].filter(Boolean).join(' '))
  }

  // ---------- 章节维护 ----------

  function rebuildChapters() {
    // 分节 / 整本解码模式是别处维护的章节表，重算会把它清掉
    if (mode === 'sections' || legacy) return
    chapters = []
    if (windowStart === 0 && headHasText) chapters.push({ title: '开篇', line: 0, bodyStart: 0, byte: 0 })
    for (const m of marks) chapters.push({ title: m.title, line: m.line, bodyStart: m.bodyStart, byte: m.byte })
    for (let i = 0; i < chapters.length; i += 1) {
      const c = chapters[i]
      known.set(chapterBase + i, { t: c.title, b: c.byte })
    }
  }

  /** 章节的结束行：下一章标题行；整本读完时是文件尾；还没下载到则是 null */
  function chapterEnd(local) {
    const next = chapters[local + 1]
    if (next) return next.line
    return haveAll ? lines.length : null
  }

  function paint(ratio = null, keepScroll = false) {
    if (!chapters.length) return
    index = Math.max(0, Math.min(chapters.length - 1, index))
    const c = chapters[index]
    const end = chapterEnd(index)
    const text = lines
      .slice(c.bodyStart, end == null ? lines.length : end)
      .join('\n')
      .replace(/^\n+|\n+$/g, '')

    const top = keepScroll ? body.scrollTop : 0
    body.textContent = text || '（这一章还是空的）'
    body.scrollTop = top
    if (ratio != null && ratio > 0) {
      requestAnimationFrame(() => {
        if (disposed) return
        body.scrollTop = ratio * Math.max(0, body.scrollHeight - body.clientHeight)
        paintProgress()
      })
    }

    prevBtn.disabled = index + chapterBase === 0 || loading
    nextBtn.disabled = (haveAll && index >= chapters.length - 1) || loading
    setChapter(chapters[index]?.title || '')
    paintProgress()
    saveIndex()
  }

  // ---------- 增量解码 ----------

  function detectEncoding(bytes) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le'
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be'
    // 分块末尾可能截断在多字节字符中间：逐个回退 1–3 字节找合法边界
    // （不能盲砍 4 字节：那样还可能把前一个汉字的尾巴切掉，utf-8 文本被误判成 gb18030）
    for (let cut = 0; cut <= 3; cut += 1) {
      const probe = cut ? bytes.subarray(0, Math.max(0, bytes.length - cut)) : bytes
      if (!probe.length) break
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(probe)
        return 'utf-8'
      } catch {
        /* 再退一个字节试试 */
      }
    }
    return 'gb18030'
  }

  function decodeLine(bytes) {
    let end = bytes.length
    if (end && bytes[end - 1] === 0x0d) end -= 1
    return decoder.decode(bytes.subarray(0, end))
  }

  function onLine(text, byte) {
    const i = lines.length
    lines.push(text)
    if (mode === 'sections') {
      sectionChars += text.length + 1
      if (sectionChars >= SECTION_CHARS) {
        sectionChars = 0
        chapters.push({ title: `第 ${chapters.length + 1} 节`, line: i + 1, bodyStart: i + 1 })
        known.set(chapterBase + chapters.length - 1, { t: chapters[chapters.length - 1].title, b: null })
      }
      return
    }
    if (pendingLine) detectHeading(pendingLine, isBlank(i))
    pendingLine = { i, text, byte }
  }

  function detectHeading(p, nextBlank) {
    const text = p.text.trim()
    if (!text || text.length > 60) return
    if (!TXT_HEADING.test(text) || /[。，；：、]$/.test(text)) return
    const solid =
      TXT_HEADING_SEP.test(text) ||
      p.i === 0 ||
      isBlank(p.i - 1) ||
      nextBlank ||
      /^#{1,3}\s/.test(text) ||
      /^(?:序章|序言|楔子|引子|前言|后记|尾声|终章|番外)/.test(text)
    if (!solid) return
    if (!marks.length && windowStart === 0) headHasText = lines.slice(0, p.i).some((l) => l.trim())
    marks.push({ line: p.i, bodyStart: p.i + 1, byte: p.byte, title: text.replace(/^#+\s*/, '').slice(0, 60) })
    rebuildChapters()
  }

  function ingest(buf) {
    if (!decoder) {
      encoding = encoding || detectEncoding(buf)
      if (encoding === 'utf-16le' || encoding === 'utf-16be') {
        legacy = true
        return
      }
      decoder = new TextDecoder(encoding)
    }
    if (legacy) return

    const base = restPos
    const data = rest.length ? mergeBytes(rest, buf) : buf
    let start = 0
    for (let i = 0; i < data.length; i += 1) {
      if (data[i] !== 0x0a) continue
      onLine(decodeLine(data.subarray(start, i)), base + start)
      start = i + 1
    }
    rest = data.slice(start)
    restPos = base + start
    maybeSections()
  }

  function maybeSections() {
    // 前 64KB 还没有第二个标题 → 这本不是按章写的（短篇 / 散文），改按字数分节
    if (mode === 'sections' || marks.length >= 2) return
    if (restPos - windowStart < 64 * 1024 && !haveAll) return
    mode = 'sections'
    marks.length = 0
    pendingLine = null
    chapters = [{ title: '第 1 节', line: 0, bodyStart: 0 }]
    sectionChars = 0
    for (let i = 0; i < lines.length; i += 1) {
      sectionChars += lines[i].length + 1
      if (sectionChars >= SECTION_CHARS && i + 1 < lines.length) {
        sectionChars = 0
        chapters.push({ title: `第 ${chapters.length + 1} 节`, line: i + 1, bodyStart: i + 1 })
      }
    }
    known.set(chapterBase, { t: chapters[0].title, b: windowStart })
  }

  // ---------- 下载 ----------

  function setBusy(on) {
    loading = on
    prevBtn.disabled = on || index + chapterBase === 0
    nextBtn.disabled = on || (haveAll && index >= chapters.length - 1)
  }

  async function fetchChunk(from, size) {
    if (loading || haveAll || disposed) return false
    if (totalBytes && from >= totalBytes) {
      haveAll = true
      return false
    }
    setBusy(true)
    try {
      const res = await fetch(fileUrl, { headers: { range: `bytes=${from}-${from + size - 1}` } })
      if (res.status === 416) {
        haveAll = true
        return false
      }
      if (!res.ok) throw new Error(`打开失败：HTTP ${res.status}`)

      const buf = new Uint8Array(await res.arrayBuffer())
      const cr = res.headers.get('content-range') // bytes a-b/total
      if (res.status !== 206 || !cr) {
        // 服务端没按 Range 回：整本到手
        totalBytes = buf.length
        ingest(buf)
        nextByte = buf.length
        haveAll = true
        finishRest()
        return true
      }
      const m = /bytes (\d+)-(\d+)\/(\d+)/.exec(cr)
      if (m) {
        nextByte = Number(m[2]) + 1
        totalBytes = Number(m[3]) || totalBytes
      } else {
        nextByte = from + buf.length
      }
      ingest(buf)
      if (totalBytes && nextByte >= totalBytes) {
        haveAll = true
        finishRest()
      }
      return true
    } finally {
      setBusy(false)
    }
  }

  function finishRest() {
    if (!legacy && rest.length) {
      // 文件末尾没有换行：最后一行也要收进来
      onLine(decodeLine(rest), restPos)
      rest = new Uint8Array(0)
    }
  }

  async function loadAllLegacy() {
    // UTF-16 等分不了行的编码：整本拉完再交给原有解码 / 分章逻辑
    const res = await fetch(fileUrl)
    if (!res.ok) throw new Error(`打开失败：HTTP ${res.status}`)
    const bytes = await readBodyWithProgress(res, (got, total) => say(`正在下载 ${fmtSize(got)} / ${fmtSize(total)}`))
    totalBytes = bytes.length
    haveAll = true
    restPos = totalBytes
    const parsed = splitTxtChapters(decodeTxt(bytes.buffer))
    lines.length = 0
    chapters = []
    for (const chapter of parsed) {
      chapters.push({ title: chapter.title, line: lines.length, bodyStart: lines.length })
      for (const l of chapter.lines) lines.push(l)
    }
    mode = 'chapters'
    for (let i = 0; i < chapters.length; i += 1) known.set(i, { t: chapters[i].title, b: null })
    chapterBase = 0
    windowStart = 0
  }

  async function openWindow(byte, base) {
    say('正在加载…')
    lines.length = 0
    chapters = []
    marks.length = 0
    pendingLine = null
    headHasText = false
    sectionChars = 0
    mode = 'chapters'
    legacy = false
    rest = new Uint8Array(0)
    restPos = byte
    nextByte = byte
    windowStart = byte
    chapterBase = base
    haveAll = false
    decoder = encoding && byte > 0 ? new TextDecoder(encoding) : null
    if (byte > 0 && !encoding) encoding = 'utf-8'
    await fetchChunk(byte, TXT_CHUNK)
    // UTF-16 这类分不了行的编码：直接整本解码（fetchChunk 里已标记 legacy）
    if (legacy) await loadAllLegacy()
    rebuildChapters()
  }

  // ---------- 导航 ----------

  async function go(target, ratio = null) {
    if (disposed) return
    let goal = Math.max(0, target)

    for (let guard = 0; guard < 500; guard += 1) {
      if (disposed) return
      const local = goal - chapterBase

      if (local < 0) {
        // 目标在窗口之前：有字节表就直接开在那一章，否则从头重开
        const hit = known.get(goal)
        if (hit?.b != null) {
          await openWindow(hit.b, goal)
          continue
        }
        await openWindow(0, 0)
        continue
      }

      if (local < chapters.length) {
        const end = chapterEnd(local)
        if (end != null || haveAll) {
          index = local
          paint(ratio)
          return
        }
        if (!(await fetchChunk(nextByte, TXT_CHUNK_MORE))) {
          index = local
          paint(ratio)
          return
        }
        rebuildChapters()
        continue
      }

      // 目标在窗口之后
      const hit = known.get(goal)
      if (hit?.b != null && local > 0) {
        await openWindow(hit.b, goal)
        continue
      }
      if (!(await fetchChunk(nextByte, TXT_CHUNK_MORE))) {
        // 已经到文件尾：夹到最后一章
        if (!chapters.length) return
        index = chapters.length - 1
        paint(ratio)
        return
      }
      rebuildChapters()
    }
  }

  /** 翻页 / 目录跳转统一入口：失败只在页脚提示，不抛未处理 Promise */
  const jump = (target) => {
    go(target).catch((err) => say(err?.message || '加载失败'))
  }

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
    if (e.target instanceof HTMLSelectElement || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
      return
    }
    if (e.key === 'ArrowLeft') {
      e.preventDefault()
      jump(index + chapterBase - 1)
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      jump(index + chapterBase + 1)
    }
  }

  function openToc() {
    const entries = [...known.entries()]
      .filter(([, v]) => v.t)
      .sort((a, b) => a[0] - b[0])
    const rows = entries.map(([i, v]) => ({ label: v.t, no: '' }))
    const current = entries.findIndex(([i]) => i === index + chapterBase)
    const dlg = openTocDialog(rows, {
      empty: '目录还在加载，稍后再试。',
      hint: haveAll ? '' : '目录随阅读进度继续补全',
      current,
    })
    if (!dlg) return
    dlg.body.querySelectorAll('[data-toc-i]').forEach((btn) => {
      btn.onclick = () => {
        const row = entries[Number(btn.dataset.tocI)]
        dlg.close()
        if (row) jump(row[0])
      }
    })
  }

  txtReader = {
    cleanup() {
      if (disposed) return
      if (chapters.length) writeStorage(txtPosKey(id), JSON.stringify(currentPos()))
      disposed = true
      clearTimeout(saveTimer)
      clearTimeout(idxTimer)
      body.removeEventListener('scroll', onScroll)
      document.removeEventListener('keydown', onKey)
    },
  }

  paintFont()
  body.addEventListener('scroll', onScroll, { passive: true })
  document.addEventListener('keydown', onKey)
  prevBtn.onclick = () => jump(index + chapterBase - 1)
  nextBtn.onclick = () => jump(index + chapterBase + 1)
  tocBtn.onclick = openToc
  root.querySelectorAll('[data-font]').forEach((b) => {
    b.onclick = () => {
      fontSize = Math.max(14, Math.min(26, fontSize + Number(b.dataset.font)))
      paintFont()
      writeStorage(TXT_FONT_KEY, String(fontSize))
    }
  })

  // 上次读到第几章：有字节表就直接从那一章开窗，否则从第一章顺序读
  const pos = readJson(txtPosKey(id))
  const startChapter = Number.isInteger(pos?.c) ? Math.max(0, pos.c) : 0
  const startRatio = typeof pos?.r === 'number' ? pos.r : null

  ;(async () => {
    try {
      const hit = startChapter > 0 ? known.get(startChapter) : null
      if (hit?.b != null) await openWindow(hit.b, startChapter)
      else {
        await openWindow(0, 0)
        if (startChapter > 0) await go(startChapter)
      }
      if (disposed) return
      if (chapters.length) {
        index = Math.max(0, Math.min(chapters.length - 1, startChapter - chapterBase))
        paint(hit?.b != null ? startRatio : null)
      } else {
        body.innerHTML = '<div class="empty">这个文件里没有可显示的文字。</div>'
      }
    } catch (err) {
      if (!disposed) body.innerHTML = `<div class="alert danger">${esc(err?.message || '打开失败')}</div>`
    }
  })()
}

/* ---------------- 小工具 ---------------- */

function mergeBytes(a, b) {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

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
}
