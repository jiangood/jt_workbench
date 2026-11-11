/**
 * 阅读页（独立路由 #/reader?id=）：epub / pdf / txt 都在整页里读，不再塞进弹窗。
 * - epub：epub.js 直接吃整本 ArrayBuffer（/api/book/read/:id 没有 .epub 后缀，交给库按 URL 找目录会 404）
 * - pdf：浏览器原生查看器（Worker 透传 Range，渐进加载）
 * - txt：浏览器端识别编码 + 分章（决策 #14），只渲染当前章，大文件不卡
 * 位置 / 字号存 localStorage：只影响记忆，不影响阅读；销毁时释放 epub 实例与定时器。
 */
import { api, esc, icon, loadScriptOnce } from '../lib.js'

const TXT_FONT_KEY = 'book:txt:font'
const txtPosKey = (id) => `book:txt:pos:${id}`
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

  main.innerHTML = `
    <div class="reader-bar">
      <a class="btn sm" href="#/book" title="返回书架">${icon('book', 14)}书架</a>
      <div class="reader-title">
        <h1 class="page-title">${esc(title)}</h1>
        <p class="page-sub">${esc(meta)}</p>
      </div>
      <div class="reader-actions">
        <a class="btn sm" href="/api/book/read/${id}" target="_blank" rel="noopener"
           title="在新标签打开原文件">${icon('external', 14)}原文件</a>
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
    stage.innerHTML = `<iframe class="reader-frame" src="/api/book/read/${id}" title="${esc(title)}"></iframe>`
    return
  }
  if (book.fmt === 'txt') {
    openTxtReader(id, title, stage)
    return
  }
  await openEpubReader(id, stage)
}

function message(text) {
  return `<div class="alert danger">${icon('alert')}<span>${esc(text)}</span></div>
    <p class="mt-3"><a class="btn sm" href="#/book">返回书架</a></p>`
}

/* ---------------- epub ---------------- */

async function openEpubReader(id, stage) {
  const alive = () => stage.isConnected
  stage.innerHTML = '<div class="reader-loading muted">加载中…</div>'

  try {
    await loadScriptOnce('/vendor/jszip.min.js')
    await loadScriptOnce('/vendor/epub.min.js')
    if (!alive()) return

    const res = await fetch(`/api/book/read/${id}`, { cache: 'no-store' })
    if (!res.ok) throw new Error(`打开失败：HTTP ${res.status}`)
    const buf = await res.arrayBuffer()
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

    epubBook = window.ePub(buf)
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
    /* 隐私模式 / 配额满：只影响记忆位置，不影响阅读 */
  }
}

/**
 * TXT 编码识别（决策 #14：展示类计算放浏览器）：
 * BOM → UTF-8 严格解码 → GB18030（兼容 GBK / GB2312，中文 txt 最常见）
 */
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

function chunkByLength(lines, limit = 12000) {
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

function openTxtReader(id, title, stage) {
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
      <div class="txt-body" data-body tabindex="0" role="document" aria-label="${esc(title)}">加载中…</div>
    </div>`

  const root = stage.querySelector('.txt-reader')
  const body = root.querySelector('[data-body]')
  const toc = root.querySelector('[data-toc]')
  const stat = root.querySelector('[data-stat]')
  const prevBtn = root.querySelector('[data-prev]')
  const nextBtn = root.querySelector('[data-next]')

  let chapters = []
  let index = 0
  let fontSize = Number(readStorage(TXT_FONT_KEY)) || 17
  let saveTimer = 0
  let disposed = false

  const paintFont = () => {
    body.style.fontSize = `${fontSize}px`
  }

  const currentPos = () => {
    const max = body.scrollHeight - body.clientHeight
    return { c: index, r: max > 0 ? body.scrollTop / max : 0 }
  }

  const onScroll = () => {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      if (!disposed) writeStorage(txtPosKey(id), JSON.stringify(currentPos()))
    }, 300)
  }

  const onKey = (e) => {
    if (e.target instanceof HTMLSelectElement || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
      return
    }
    if (e.key === 'ArrowLeft') {
      e.preventDefault()
      show(index - 1)
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      show(index + 1)
    }
  }

  const show = (i, ratio = 0) => {
    if (!chapters.length) return
    index = Math.max(0, Math.min(chapters.length - 1, i))
    body.textContent = chapters[index].lines.join('\n').replace(/^\n+|\n+$/g, '')
    body.scrollTop = 0
    if (ratio > 0) {
      // 等这一章排版完成再定位，否则 scrollHeight 还是 0
      requestAnimationFrame(() => {
        if (disposed) return
        body.scrollTop = ratio * Math.max(0, body.scrollHeight - body.clientHeight)
      })
    }
    toc.value = String(index)
    prevBtn.disabled = index === 0
    nextBtn.disabled = index === chapters.length - 1
    stat.textContent = `${index + 1} / ${chapters.length} 章`
  }

  txtReader = {
    cleanup() {
      if (disposed) return
      if (chapters.length) writeStorage(txtPosKey(id), JSON.stringify(currentPos()))
      disposed = true
      clearTimeout(saveTimer)
      body.removeEventListener('scroll', onScroll)
      document.removeEventListener('keydown', onKey)
    },
  }

  paintFont()
  body.addEventListener('scroll', onScroll, { passive: true })
  document.addEventListener('keydown', onKey)
  prevBtn.onclick = () => show(index - 1)
  nextBtn.onclick = () => show(index + 1)
  toc.onchange = () => show(Number(toc.value))
  root.querySelectorAll('[data-font]').forEach((b) => {
    b.onclick = () => {
      fontSize = Math.max(14, Math.min(26, fontSize + Number(b.dataset.font)))
      paintFont()
      writeStorage(TXT_FONT_KEY, String(fontSize))
    }
  })

  fetch(`/api/book/read/${id}`, { cache: 'no-store' })
    .then((res) => {
      if (!res.ok) throw new Error(`打开失败：HTTP ${res.status}`)
      return res.arrayBuffer()
    })
    .then((buf) => {
      if (disposed || !stage.isConnected) return
      chapters = splitTxtChapters(decodeTxt(buf))
      toc.innerHTML = chapters.map((c, i) => `<option value="${i}">${esc(c.title)}</option>`).join('')
      const pos = JSON.parse(readStorage(txtPosKey(id)) || 'null')
      show(Number.isInteger(pos?.c) ? pos.c : 0, pos?.r ?? 0)
    })
    .catch((err) => {
      if (!disposed && stage.isConnected) body.innerHTML = `<div class="alert danger">${esc(err.message)}</div>`
    })
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
