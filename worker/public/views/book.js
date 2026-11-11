import { api, esc, icon, loadScriptOnce, rerender, run, showDialog, toast } from '../lib.js'

let epubBook = null
let closeBound = false
let filterStatus = 'all'
let filterCategory = ''

const STATUS = {
  unread: { label: '待读', cls: 'muted' },
  reading: { label: '阅读中', cls: 'warn' },
  read: { label: '已读', cls: 'ok' },
}

const statusLabel = (s) => STATUS[s]?.label ?? '待读'
const statusBadge = (s) => `<span class="badge ${STATUS[s]?.cls ?? 'muted'}">${statusLabel(s)}</span>`

/** 豆瓣图床带 Referer 防盗链，封面统一走 Worker 代理 */
const coverUrl = (url) => (url ? `/api/book/cover?url=${encodeURIComponent(url)}` : '')

function closeReader() {
  try {
    epubBook?.destroy()
  } catch {
    /* 已释放 */
  }
  epubBook = null
}

export async function render(main) {
  await loadScriptOnce('/vendor/jszip.min.js')
  await loadScriptOnce('/vendor/epub.min.js')
  if (!closeBound) {
    document.getElementById('dlg').addEventListener('close', closeReader)
    closeBound = true
  }

  const data = await api('/api/book/list')
  const books = data.books ?? []

  const counts = { all: books.length, unread: 0, reading: 0, read: 0 }
  const catCounts = new Map()
  for (const b of books) {
    counts[b.status] = (counts[b.status] ?? 0) + 1
    if (b.category) catCounts.set(b.category, (catCounts.get(b.category) ?? 0) + 1)
  }
  const categories = [...catCounts.keys()].sort((a, b) => a.localeCompare(b, 'zh'))
  if (filterCategory && !catCounts.has(filterCategory)) filterCategory = ''
  if (filterStatus !== 'all' && !counts[filterStatus]) filterStatus = 'all'

  const shown = books.filter(
    (b) => (filterStatus === 'all' || b.status === filterStatus) && (!filterCategory || b.category === filterCategory),
  )

  main.innerHTML = `
    <div class="page-head">
      <div>
        <h1 class="page-title">书架</h1>
        <p class="page-sub">豆瓣索引先建条目，有文件后再上传 · 区分待读 / 阅读中 / 已读</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" id="add-book">${icon('plus')}添加图书</button>
        <label class="btn">
          ${icon('upload')}上传文件
          <input class="sr-only" type="file" id="up" accept=".epub,.pdf" multiple>
        </label>
      </div>
    </div>
    <div id="up-progress" class="small muted mb-2" role="status" aria-live="polite"></div>
    <div class="tabs" role="tablist" aria-label="阅读状态">
      ${[
        ['all', '全部'],
        ['unread', '待读'],
        ['reading', '阅读中'],
        ['read', '已读'],
      ]
        .map(
          ([value, label]) => `<button class="tab" type="button" role="tab" data-status="${value}"
            aria-selected="${filterStatus === value}">${label} <span class="muted">${counts[value] ?? 0}</span></button>`,
        )
        .join('')}
    </div>
    ${
      categories.length
        ? `<div class="category-chips" aria-label="分类筛选">
            <button class="pill" type="button" data-cat="" aria-pressed="${!filterCategory}">全部分类</button>
            ${categories
              .map(
                (c) => `<button class="pill" type="button" data-cat="${esc(c)}"
                  aria-pressed="${filterCategory === c}">${esc(c)} <span class="muted">${catCounts.get(c)}</span></button>`,
              )
              .join('')}
          </div>`
        : ''
    }
    <div class="book-grid">
      ${
        shown
          .map((b) => {
            const cover = coverUrl(b.cover)
            const meta = [b.author || '未知作者', b.pubYear].filter(Boolean).join(' · ')
            return `
        <article class="book-card">
          <div class="book-cover${cover ? '' : ' no-cover'}">
            <span class="book-cover-ph">${icon('book', 34)}</span>
            ${cover ? `<img src="${esc(cover)}" alt="" loading="lazy">` : ''}
            ${statusBadge(b.status)}
          </div>
          <div class="book-body">
            <div class="book-title" title="${esc(b.title || b.filename)}">${esc(b.title || b.filename)}</div>
            <div class="small muted">${esc(meta)}</div>
            <div class="book-meta">
              ${b.category ? `<span class="badge">${esc(b.category)}</span>` : '<span class="badge muted">未分类</span>'}
              ${b.rating ? `<span class="small muted">★ ${esc(b.rating)}</span>` : ''}
              ${b.hasFile ? `<span class="badge muted">${esc((b.fmt || '').toUpperCase())}</span>` : '<span class="badge warn">待上传</span>'}
            </div>
            <div class="book-actions">
              ${
                b.hasFile
                  ? `<button class="btn sm primary" data-r="${esc(b.id)}">${icon('book', 14)}阅读</button>`
                  : `<button class="btn sm primary" data-upload="${esc(b.id)}">${icon('upload', 14)}上传文件</button>`
              }
              <button class="btn sm" data-e="${esc(b.id)}">编辑</button>
              <button class="btn sm" data-sync="${esc(b.id)}" title="用豆瓣信息更新书名/作者/封面/简介/评分">${icon('refresh', 14)}同步</button>
              ${b.hasFile ? `<a class="btn sm" href="/api/book/read/${esc(b.id)}" target="_blank" rel="noopener">原文件</a>` : ''}
              <button class="btn sm danger" data-d="${esc(b.id)}" aria-label="删除">${icon('trash', 14)}</button>
            </div>
          </div>
        </article>`
          })
          .join('') || `<div class="empty">${books.length ? '当前筛选下还没有书' : '书架空空如也，点「添加图书」从豆瓣建条目，或直接上传 epub / pdf'}</div>`
      }
    </div>`

  // 封面加载失败（豆瓣限流 / 下架）时退回占位图标
  main.querySelectorAll('.book-cover img').forEach((img) => {
    img.addEventListener('error', () => img.closest('.book-cover')?.classList.add('no-cover'))
  })

  main.querySelectorAll('[data-status]').forEach((b) => {
    b.onclick = () => {
      filterStatus = b.dataset.status
      rerender(render, main)
    }
  })
  main.querySelectorAll('[data-cat]').forEach((b) => {
    b.onclick = () => {
      filterCategory = b.dataset.cat
      rerender(render, main)
    }
  })

  main.querySelector('#add-book').onclick = () => openAddDialog(main, categories)

  main.querySelector('#up').onchange = async (e) => {
    const prog = main.querySelector('#up-progress')
    const files = [...e.target.files]
    let failed = 0
    for (const file of files) {
      prog.textContent = `解析 ${file.name} ...`
      const meta = await parseEpubMeta(file)
      prog.textContent = `上传 ${file.name} ...`
      try {
        await uploadFile(file, { ...meta, category: filterCategory })
      } catch (err) {
        failed += 1
        toast(err.message, true)
      }
    }
    prog.textContent = ''
    e.target.value = ''
    if (files.length > failed) toast(`已上传 ${files.length - failed} 本`)
    await rerender(render, main)
  }

  main.querySelectorAll('[data-r]').forEach((a) => {
    a.onclick = () => {
      const b = books.find((x) => String(x.id) === a.dataset.r)
      if (!b) return
      openReader(b.id, b.fmt, b.title || b.filename)
      // 开卷即视为阅读中（已读不倒退；失败静默，不挡阅读）
      if (b.status === 'unread') {
        api(`/api/book/${b.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'reading' }) })
          .then(() => rerender(render, main))
          .catch(() => {})
      }
    }
  })
  main.querySelectorAll('[data-upload]').forEach((b) => {
    b.onclick = () => pickFile(b.dataset.upload, main)
  })
  main.querySelectorAll('[data-e]').forEach((b) => {
    b.onclick = () => {
      const row = books.find((x) => String(x.id) === b.dataset.e)
      if (row) openEditDialog(row, main, categories)
    }
  })
  main.querySelectorAll('[data-sync]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('用豆瓣信息覆盖书名、作者、封面、简介和评分？分类与阅读状态不受影响。')) return
      const res = await run(b, () => api(`/api/book/${b.dataset.sync}/sync`, { method: 'POST' }))
      if (!res.ok) return
      toast(`已同步：${res.data?.title || '豆瓣信息'}`)
      await rerender(render, main)
    }
  })
  main.querySelectorAll('[data-d]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('删除该书（已上传的 R2 文件一并删除）？')) return
      const res = await run(b, () => api(`/api/book/${b.dataset.d}`, { method: 'DELETE' }))
      if (!res.ok) return
      toast('已删除')
      await rerender(render, main)
    }
  })
}

/* ---------------- 豆瓣索引：添加 ---------------- */

function openAddDialog(main, categories) {
  const { close, body } = showDialog(
    `<h2>添加图书</h2>
     <label class="form-label" for="book-q">豆瓣搜索</label>
     <div class="combo">
       <input class="field" id="book-q" placeholder="书名 / 作者 / ISBN，搜索不到可直接在下方填写"
              role="combobox" aria-autocomplete="list" aria-expanded="false"
              aria-controls="book-suggest" aria-describedby="book-msg"
              autocomplete="off" spellcheck="false">
       <div class="combo-list" id="book-suggest" role="listbox" aria-label="豆瓣图书搜索结果" hidden></div>
     </div>
     <div class="field-error" id="book-msg" role="alert"></div>
     <form id="book-add-form" class="mt-2" novalidate>
       <div class="row g-2">
         <div>
           <label class="form-label" for="book-title">书名</label>
           <input class="field" id="book-title" maxlength="200" required autocomplete="off">
         </div>
         <div>
           <label class="form-label" for="book-author">作者</label>
           <input class="field" id="book-author" maxlength="120" autocomplete="off">
         </div>
       </div>
       <label class="form-label mt-2" for="book-cover">封面链接（可选）</label>
       <input class="field" id="book-cover" placeholder="https://…，留空则使用豆瓣封面" autocomplete="off">
       <img class="cover-preview" id="book-cover-preview" alt="" hidden>
       <div class="row g-2 mt-2">
         <div>
           <label class="form-label" for="book-category">分类</label>
           <input class="field" id="book-category" list="book-cat-list" maxlength="50"
                  placeholder="如 小说 / 技术 / 历史" autocomplete="off">
           <datalist id="book-cat-list">${categories.map((c) => `<option value="${esc(c)}"></option>`).join('')}</datalist>
         </div>
         <div>
           <label class="form-label" for="book-status">阅读状态</label>
           <select class="field" id="book-status">
             <option value="unread">待读</option>
             <option value="reading">阅读中</option>
             <option value="read">已读</option>
           </select>
         </div>
       </div>
       <div class="book-picked" id="book-picked" hidden></div>
       <div class="dlg-foot">
         <button class="btn sm" type="button" data-close>取消</button>
         <button class="btn primary sm" type="submit">保存到书架</button>
       </div>
     </form>`,
    { label: '添加图书' },
  )

  const form = body.querySelector('#book-add-form')
  const qInput = body.querySelector('#book-q')
  const list = body.querySelector('#book-suggest')
  const msg = body.querySelector('#book-msg')
  const titleEl = body.querySelector('#book-title')
  const authorEl = body.querySelector('#book-author')
  const coverEl = body.querySelector('#book-cover')
  const coverPreview = body.querySelector('#book-cover-preview')
  const categoryEl = body.querySelector('#book-category')
  const statusEl = body.querySelector('#book-status')
  const picked = body.querySelector('#book-picked')
  watchCoverInput(coverEl, coverPreview)

  let options = []
  let selected = null
  let active = -1
  let status = ''
  let seq = 0
  let detailSeq = 0
  let timer = 0
  let blurTimer = 0

  const say = (text) => {
    msg.textContent = text ?? ''
    if (text) qInput.setAttribute('aria-invalid', 'true')
    else qInput.removeAttribute('aria-invalid')
  }

  const paintPicked = () => {
    if (!selected) {
      picked.hidden = true
      picked.innerHTML = ''
      return
    }
    const cover = coverUrl(selected.cover)
    const meta = [selected.author, selected.year, selected.rating ? `豆瓣 ${selected.rating}` : '']
      .filter(Boolean)
      .join(' · ')
    picked.hidden = false
    picked.innerHTML = `
      ${cover ? `<img src="${esc(cover)}" alt="">` : ''}
      <div class="flex-grow-1 small">
        <div class="fw-semibold">豆瓣索引</div>
        <div class="muted">${esc(meta || '已选条目')}</div>
        ${selected.summary ? `<div class="book-picked-summary">${esc(selected.summary)}</div>` : ''}
      </div>`
    picked.querySelector('img')?.addEventListener('error', (e) => e.target.remove())
  }

  const paint = () => {
    const open = options.length > 0 || Boolean(status)
    if (options.length) {
      list.innerHTML = options
        .map(
          (o, i) => `<div class="combo-opt" id="book-opt-${i}" role="option" data-i="${i}"
              aria-selected="${i === active}"${o.added ? ' aria-disabled="true"' : ''}>
            ${o.cover ? `<img class="book-opt-cover" src="${esc(coverUrl(o.cover))}" alt="">` : ''}
            <span class="flex-grow-1">
              <span class="fw-semibold">${esc(o.title)}</span>
              <span class="muted small"> ${esc([o.author, o.year].filter(Boolean).join(' · '))}</span>
            </span>
            ${o.added ? '<span class="badge">已在书架</span>' : ''}
          </div>`,
        )
        .join('')
    } else {
      list.innerHTML = `<div class="combo-empty">${esc(status || '未找到匹配的图书')}</div>`
    }
    list.hidden = !open
    qInput.setAttribute('aria-expanded', String(open))
    if (active >= 0) qInput.setAttribute('aria-activedescendant', `book-opt-${active}`)
    else qInput.removeAttribute('aria-activedescendant')
    if (active >= 0) list.querySelector(`#book-opt-${active}`)?.scrollIntoView({ block: 'nearest' })
  }

  const closeList = () => {
    seq += 1
    clearTimeout(timer)
    options = []
    active = -1
    status = ''
    list.hidden = true
    list.innerHTML = ''
    qInput.setAttribute('aria-expanded', 'false')
    qInput.removeAttribute('aria-activedescendant')
  }

  const choose = (i) => {
    const o = options[i]
    if (!o || o.added) return
    selected = o
    titleEl.value = o.title || ''
    authorEl.value = o.author || ''
    coverEl.value = o.cover || ''
    coverPreview.src = o.cover ? coverUrl(o.cover) : ''
    coverPreview.hidden = !o.cover
    say('')
    closeList()
    paintPicked()
    categoryEl.focus()

    const my = ++detailSeq
    api(`/api/book/douban/${o.doubanId}`)
      .then((d) => {
        if (my !== detailSeq || selected !== o) return
        Object.assign(o, d.detail ?? {})
        if (!coverEl.value.trim() && o.cover) {
          coverEl.value = o.cover
          coverPreview.src = coverUrl(o.cover)
          coverPreview.hidden = false
        }
        paintPicked()
      })
      .catch(() => {})
  }

  const search = async (keyword) => {
    const mySeq = ++seq
    if (!keyword) {
      closeList()
      return
    }
    options = []
    active = -1
    status = '搜索中…'
    paint()
    try {
      const data = await api(`/api/book/search?q=${encodeURIComponent(keyword)}`)
      if (mySeq !== seq) return
      options = data.items ?? []
      active = options.findIndex((o) => !o.added)
      status = options.length ? '' : '未找到匹配的图书，可直接在下方手动填写'
      paint()
    } catch (err) {
      if (mySeq !== seq) return
      options = []
      active = -1
      status = err?.message || '搜索失败'
      paint()
    }
  }

  qInput.addEventListener('input', () => {
    selected = null
    detailSeq += 1
    paintPicked()
    say('')
    clearTimeout(timer)
    const keyword = qInput.value.trim()
    timer = setTimeout(() => search(keyword), 320)
  })

  qInput.addEventListener('blur', () => {
    clearTimeout(blurTimer)
    blurTimer = setTimeout(closeList, 150)
  })

  qInput.addEventListener('keydown', (e) => {
    const open = !list.hidden
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!open || !options.length) return
      e.preventDefault()
      const step = e.key === 'ArrowDown' ? 1 : -1
      let next = active < 0 ? (step > 0 ? -1 : 0) : active
      for (let n = 0; n < options.length; n += 1) {
        next = (next + step + options.length) % options.length
        if (!options[next].added) {
          active = next
          paint()
          return
        }
      }
      return
    }
    if (e.key === 'Enter' && open && active >= 0) {
      e.preventDefault()
      choose(active)
      return
    }
    if (e.key === 'Escape' && open) {
      e.preventDefault()
      closeList()
    }
  })

  // mousedown 阻止默认：点选项时输入框不失焦（否则 blur 先把列表关掉）
  list.addEventListener('mousedown', (e) => e.preventDefault())
  list.addEventListener(
    'error',
    (e) => {
      if (e.target instanceof HTMLImageElement) e.target.style.display = 'none'
    },
    true,
  )
  list.addEventListener('click', (e) => {
    const opt = e.target instanceof Element ? e.target.closest('[data-i]') : null
    if (opt) choose(Number(opt.dataset.i))
  })

  form.onsubmit = async (e) => {
    e.preventDefault()
    const title = titleEl.value.trim()
    if (!title) {
      say('请填写书名，或从豆瓣搜索结果中选择')
      titleEl.focus()
      return
    }
    const payload = {
      title,
      author: authorEl.value.trim() || null,
      category: categoryEl.value.trim() || null,
      status: statusEl.value,
      cover: coverEl.value.trim() || null,
      summary: selected?.summary || null,
      rating: selected?.rating ?? null,
      pubYear: selected?.year || selected?.pubYear || null,
      doubanId: selected?.doubanId || null,
      doubanUrl: selected?.url || null,
    }
    const res = await run(form.querySelector('button[type="submit"]'), () =>
      api('/api/book/add', { method: 'POST', body: JSON.stringify(payload) }),
    )
    if (!res.ok) return
    close()
    toast(`已添加到书架：${title}`)
    await rerender(render, main)
  }

  body.querySelector('[data-close]').onclick = close
  qInput.focus()
}

/* ---------------- 编辑 / 上传文件 ---------------- */

/** 封面链接输入 → 实时预览（无效或 404 时隐藏预览，不挡保存） */
function watchCoverInput(input, img) {
  if (!input || !img) return
  const paint = () => {
    const value = input.value.trim()
    if (!value) {
      img.hidden = true
      img.removeAttribute('src')
      return
    }
    img.hidden = false
    img.src = coverUrl(value)
  }
  img.addEventListener('error', () => {
    img.hidden = true
  })
  input.addEventListener('input', paint)
  paint()
}

function openEditDialog(row, main, categories) {
  const { close, body } = showDialog(
    `<h2>编辑图书</h2>
     <form id="book-edit-form" novalidate>
       <label class="form-label" for="edit-title">书名</label>
       <input class="field" id="edit-title" maxlength="200" required value="${esc(row.title)}">
       <label class="form-label mt-2" for="edit-author">作者</label>
       <input class="field" id="edit-author" maxlength="120" value="${esc(row.author || '')}">
       <label class="form-label mt-2" for="edit-cover">封面链接</label>
       <input class="field" id="edit-cover" placeholder="https://…，留空则不显示封面"
              value="${esc(row.cover || '')}" autocomplete="off">
       <img class="cover-preview" id="edit-cover-preview" alt="" hidden>
       <div class="row g-2 mt-2">
         <div>
           <label class="form-label" for="edit-category">分类</label>
           <input class="field" id="edit-category" list="edit-cat-list" maxlength="50"
                  placeholder="未分类" value="${esc(row.category || '')}">
           <datalist id="edit-cat-list">${categories.map((c) => `<option value="${esc(c)}"></option>`).join('')}</datalist>
         </div>
         <div>
           <label class="form-label" for="edit-status">阅读状态</label>
           <select class="field" id="edit-status">
             ${['unread', 'reading', 'read']
               .map((s) => `<option value="${s}"${row.status === s ? ' selected' : ''}>${statusLabel(s)}</option>`)
               .join('')}
           </select>
         </div>
       </div>
       <div class="dlg-foot">
         <button class="btn sm" type="button" data-close>取消</button>
         <button class="btn primary sm" type="submit">保存</button>
       </div>
     </form>`,
    { label: '编辑图书' },
  )

  const form = body.querySelector('#book-edit-form')
  watchCoverInput(body.querySelector('#edit-cover'), body.querySelector('#edit-cover-preview'))
  form.onsubmit = async (e) => {
    e.preventDefault()
    const title = body.querySelector('#edit-title').value.trim()
    if (!title) {
      body.querySelector('#edit-title').focus()
      return
    }
    const payload = {
      title,
      author: body.querySelector('#edit-author').value.trim() || null,
      cover: body.querySelector('#edit-cover').value.trim() || null,
      category: body.querySelector('#edit-category').value.trim() || null,
      status: body.querySelector('#edit-status').value,
    }
    const res = await run(form.querySelector('button[type="submit"]'), () =>
      api(`/api/book/${row.id}`, { method: 'PATCH', body: JSON.stringify(payload) }),
    )
    if (!res.ok) return
    close()
    toast('已保存')
    await rerender(render, main)
  }
  body.querySelector('[data-close]').onclick = close
  body.querySelector('#edit-title').focus()
}

function pickFile(bookId, main) {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.epub,.pdf'
  input.onchange = async () => {
    const file = input.files?.[0]
    if (!file) return
    try {
      await uploadFile(file, { bookId })
      toast(`已上传：${file.name}`)
      await rerender(render, main)
    } catch (err) {
      toast(err.message, true)
    }
  }
  input.click()
}

async function uploadFile(file, extra = {}) {
  const qs = new URLSearchParams({ filename: file.name })
  for (const [key, value] of Object.entries(extra)) {
    if (value !== null && value !== undefined && value !== '') qs.set(key, value)
  }
  const res = await fetch(`/api/book/upload?${qs}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: file,
  })
  if (!res.ok) {
    const env = await res.json().catch(() => null)
    throw new Error(env?.message || `上传失败：${file.name}（HTTP ${res.status}）`)
  }
  return res.json()
}

/** epub 元数据：浏览器端 JSZip 读 OPF（v3 决策 #9）；失败返回空对象，用文件名兜底 */
async function parseEpubMeta(file) {
  if (!file.name.toLowerCase().endsWith('.epub')) return {}
  try {
    const zip = await window.JSZip.loadAsync(file)
    const containerXml = await zip.file('META-INF/container.xml')?.async('text')
    const opfPath = containerXml?.match(/full-path="([^"]+)"/)?.[1]
    const opf = opfPath ? await zip.file(opfPath)?.async('text') : ''
    return {
      title: opf?.match(/<dc:title[^>]*>([^<]+)</)?.[1],
      author: opf?.match(/<dc:creator[^>]*>([^<]+)</)?.[1],
    }
  } catch {
    return {}
  }
}

/* ---------------- 阅读器 ---------------- */

function openReader(id, fmt, title) {
  closeReader()
  const url = `/api/book/read/${id}`
  const { body } = showDialog('<div id="reader-view"></div>', { xl: true, label: '阅读器' })
  const view = body.querySelector('#reader-view')

  if (fmt === 'pdf') {
    view.innerHTML = `<iframe src="${url}" style="width: 100%; height: 80vh; border: 0" title="${esc(title)}"></iframe>`
    return
  }

  // 直接把整本 epub 读成 ArrayBuffer 交给 epub.js：避免它按 URL 末段当目录去解析
  // （/api/book/read/9 没有 .epub 后缀，否则会去请求 /read/META-INF/container.xml）
  fetch(url)
    .then((res) => {
      if (!res.ok) throw new Error(`打开失败：HTTP ${res.status}`)
      return res.arrayBuffer()
    })
    .then((buf) => {
      if (!view.isConnected) return // 弹窗已关闭/切页
      epubBook = window.ePub(buf)
      const rendition = epubBook.renderTo(view, { width: '100%', height: '100%', spread: 'none' })
      rendition.display()
      rendition.on('keydown', (e) => {
        if (e.key === 'ArrowLeft') rendition.prev()
        if (e.key === 'ArrowRight') rendition.next()
      })
    })
    .catch((err) => {
      if (view.isConnected) view.innerHTML = `<div class="alert danger">${esc(err.message)}</div>`
    })
}

export function destroy() {
  closeReader()
  document.getElementById('dlg-body').innerHTML = ''
}
