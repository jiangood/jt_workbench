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
 * 位置 / 字号存 localStorage：只影响记忆，不影响阅读；销毁时释放 epub 实例与定时器。
 */
import { api, esc, icon, loadScriptOnce } from '../lib.js'
import { loadingBlock } from '../ui.js'

const TXT_FONT_KEY = 'book:txt:font'
const txtPosKey = (id) => `book:txt:pos:${id}`
const txtIdxKey = (id) => `book:txt:idx:${id}`

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
/** epub 的整页键盘翻页监听（focus 在页面壳上时也生效；iframe 内由 epub.js 自己处理） */
let detachKeys = null

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
  const meta = [book.author || '未知作者', book.category, book.pubYear].filter(Boolean).join(' · ')
  // 版本号 = 文件自身的 uuid（换文件才变；改书名 / 阅读状态不影响缓存）
  const version = String(book.fileVersion ?? book.updatedAt ?? 0)
  const fileUrl = `/api/book/read/${id}?v=${encodeURIComponent(version)}`

  main.innerHTML = `
    <div class="reader-bar">
      <a class="btn sm" href="#/book" title="返回书架">${icon('book', 14)}书架</a>
      <div class="reader-title">
        <h1 class="page-title">${esc(title)}</h1>
        <p class="page-sub">${esc(meta)}</p>
      </div>
      <div class="reader-actions">
        <a class="btn sm" href="${fileUrl}" download title="下载原文件">${icon('download', 14)}下载</a>
      </div>
    </div>
    <div class="reader-stage" id="reader-stage"></div>`

  document.title = `${title} · 个人工作台`

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
    stage.innerHTML = `<iframe class="reader-frame" src="${fileUrl}" title="${esc(title)}"></iframe>`
    return
  }
  if (book.fmt === 'txt') {
    openTxtReader(id, title, version, fileUrl, book.size, stage)
    return
  }
  await openEpubReader(fileUrl, stage)
}

function message(text) {
  return `<div class="alert danger">${icon('alert')}<span>${esc(text)}</span></div>
    <p class="mt-3"><a class="btn sm" href="#/book">返回书架</a></p>`
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

async function openEpubReader(fileUrl, stage) {
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
      <div class="reader-controls">
        <button class="btn sm" type="button" data-prev>上一页</button>
        <button class="btn sm" type="button" data-next>下一页</button>
        <span class="flex-grow-1"></span>
        <span class="small muted" data-stat></span>
      </div>
      <div class="reader-view"></div>`

    const view = stage.querySelector('.reader-view')
    const stat = stage.querySelector('[data-stat]')

    epubBook = window.ePub(bytes.buffer)
    const rendition = epubBook.renderTo(view, { width: '100%', height: '100%', spread: 'none' })
    const go = (dir) => Promise.resolve(rendition[dir]()).catch(() => {})
    await rendition.display()

    // 节数来自 spine；目录 / 页码要先生成 locations（整本解析，重），这里只报节进度
    const total = epubBook.spine?.spineItems?.length ?? 0
    rendition.on('relocated', (loc) => {
      if (!alive()) return
      const index = loc?.start?.index
      stat.textContent = Number.isInteger(index) ? `第 ${index + 1}${total ? ` / ${total}` : ''} 节` : ''
    })
    rendition.on('keydown', (e) => {
      if (e.key === 'ArrowLeft') go('prev')
      if (e.key === 'ArrowRight') go('next')
    })

    // 焦点还在页面壳（顶栏 / 翻页按钮）时方向键也能翻页；iframe 内的按键不会冒泡到这里，不会翻两次
    const onKey = (e) => {
      if (e.target instanceof HTMLSelectElement || e.target instanceof HTMLInputElement) return
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        go('prev')
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        go('next')
      }
    }
    document.addEventListener('keydown', onKey)
    detachKeys = () => document.removeEventListener('keydown', onKey)

    stage.querySelector('[data-prev]').onclick = () => go('prev')
    stage.querySelector('[data-next]').onclick = () => go('next')
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
function openTxtReader(id, title, version, fileUrl, sizeHint, stage) {
  stage.innerHTML = `
    <div class="txt-reader">
      <div class="txt-toolbar">
        <button class="btn sm" type="button" data-prev>上一章</button>
        <select class="field txt-toc" data-toc aria-label="目录"></select>
        <button class="btn sm" type="button" data-next>下一章</button>
        <span class="flex-grow-1"></span>
        <button class="btn sm" type="button" data-font="-1" aria-label="缩小字号">A−</button>
        <button class="btn sm" type="button" data-font="1" aria-label="放大字号">A+</button>
        <span class="small muted" data-stat></span>
      </div>
      <div class="txt-body" data-body tabindex="0" role="document" aria-label="${esc(title)}">${loadingBlock('正在加载正文…')}</div>
    </div>`

  const root = stage.querySelector('.txt-reader')
  const body = root.querySelector('[data-body]')
  const toc = root.querySelector('[data-toc]')
  const stat = root.querySelector('[data-stat]')
  const prevBtn = root.querySelector('[data-prev]')
  const nextBtn = root.querySelector('[data-next]')

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

  const cached = readIndex()
  for (const c of cached.chapters ?? []) known.set(c.i, { t: c.t, b: c.b })
  if (cached.enc) encoding = cached.enc

  const isBlank = (i) => (lines[i] ?? '').trim() === ''

  const currentPos = () => {
    const max = body.scrollHeight - body.clientHeight
    return { c: index + chapterBase, r: max > 0 ? body.scrollTop / max : 0 }
  }

  function paintFont() {
    body.style.fontSize = `${fontSize}px`
  }

  function say(text) {
    stat.textContent = text
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
      })
    }

    toc.value = String(index + chapterBase)
    prevBtn.disabled = index + chapterBase === 0 || loading
    nextBtn.disabled = (haveAll && index >= chapters.length - 1) || loading
    const progress = totalBytes ? `${fmtSize(restPos)} / ${fmtSize(totalBytes)}` : fmtSize(restPos)
    say(`${index + chapterBase + 1} ${mode === 'sections' ? '节' : '章'} · 已下载 ${progress}`)
    saveIndex()
  }

  function rebuildToc() {
    const rows = [...known.entries()].filter(([, v]) => v.t).sort((a, b) => a[0] - b[0])
    toc.innerHTML = rows
      .map(([i, v]) => `<option value="${i}">${esc(v.t)}</option>`)
      .join('')
    toc.value = String(index + chapterBase)
  }

  // ---------- 增量解码 ----------

  function detectEncoding(bytes) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le'
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be'
    // 末尾可能截断在多字节字符中间：留 4 字节不参与严格校验
    const probe = bytes.length > 8 ? bytes.subarray(0, bytes.length - 4) : bytes
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(probe)
      return 'utf-8'
    } catch {
      return 'gb18030'
    }
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

  function ingest(buf, from) {
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
        ingest(buf, 0)
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
      ingest(buf, from)
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
    rebuildToc()
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
          rebuildToc()
          paint(ratio)
          return
        }
        if (!(await fetchChunk(nextByte, TXT_CHUNK_MORE))) {
          index = local
          rebuildToc()
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
        rebuildToc()
        paint(ratio)
        return
      }
      rebuildChapters()
    }
  }

  // ---------- 交互 ----------

  const onScroll = () => savePos()

  const onKey = (e) => {
    if (e.target instanceof HTMLSelectElement || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
      return
    }
    if (e.key === 'ArrowLeft') {
      e.preventDefault()
      go(index + chapterBase - 1)
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      go(index + chapterBase + 1)
    }
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
  prevBtn.onclick = () => go(index + chapterBase - 1)
  nextBtn.onclick = () => go(index + chapterBase + 1)
  toc.onchange = () => go(Number(toc.value))
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
      rebuildToc()
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
    detachKeys?.()
  } catch {
    /* 已释放 */
  }
  detachKeys = null
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
