import { api, esc, icon, loadScriptOnce, rerender, run, showDialog, toast } from '../lib.js'

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

export async function render(main) {
  // 上传时用 JSZip 读 epub 元数据；阅读器已独立成 #/reader 页，按需自己加载 epub.js
  await loadScriptOnce('/vendor/jszip.min.js')

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
        <p class="page-sub">豆瓣索引先建条目，有文件后再上传 · 上传后自动匹配豆瓣信息 · 区分待读 / 阅读中 / 已读</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" id="add-book">${icon('plus')}添加图书</button>
        <label class="btn">
          ${icon('upload')}上传文件
          <input class="sr-only" type="file" id="up" accept=".epub,.pdf,.txt" multiple>
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
            const title = b.title || b.filename
            const meta = [b.author || '未知作者', b.pubYear].filter(Boolean).join(' · ')
            const label = esc(title)
            return `
        <article class="book-card">
          <div class="book-cover${cover ? '' : ' no-cover'}">
            <span class="book-cover-ph">${icon('book', 36)}</span>
            ${cover ? `<img src="${esc(cover)}" alt="" loading="lazy">` : ''}
            ${statusBadge(b.status)}
          </div>
          <div class="book-body">
            <h2 class="book-title" title="${label}">${esc(title)}</h2>
            <p class="book-by small muted" title="${esc(meta)}">${esc(meta)}</p>
            <div class="book-meta">
              ${b.category ? `<span class="badge">${esc(b.category)}</span>` : '<span class="badge muted">未分类</span>'}
              ${b.rating ? `<span class="book-rating small muted">${icon('star', 12)}${esc(b.rating)}</span>` : ''}
              ${b.hasFile ? `<span class="badge muted">${esc((b.fmt || '').toUpperCase())}</span>` : '<span class="badge warn">待上传</span>'}
            </div>
            <div class="book-actions">
              ${
                b.hasFile
                  ? `<a class="btn sm primary" href="#/reader?id=${esc(b.id)}"
                       title="阅读《${label}》" aria-label="阅读《${label}》">${icon('book', 14)}阅读</a>`
                  : `<button class="btn sm primary" data-upload="${esc(b.id)}">${icon('upload', 14)}上传文件</button>`
              }
              <div class="book-tools">
                <button class="btn sm" data-e="${esc(b.id)}" title="编辑" aria-label="编辑《${label}》">${icon('edit', 14)}</button>
                <button class="btn sm" data-sync="${esc(b.id)}" title="用豆瓣信息更新书名 / 作者 / 封面 / 简介 / 评分"
                        aria-label="同步豆瓣信息《${label}》">${icon('refresh', 14)}</button>
                ${
                  b.hasFile
                    ? `<a class="btn sm" href="/api/book/read/${esc(b.id)}" target="_blank" rel="noopener"
                          title="打开原文件" aria-label="打开原文件《${label}》">${icon('external', 14)}</a>`
                    : ''
                }
                <button class="btn sm danger" data-d="${esc(b.id)}" title="删除" aria-label="删除《${label}》">${icon('trash', 14)}</button>
              </div>
            </div>
          </div>
        </article>`
          })
          .join('') || `<div class="empty">${books.length ? '当前筛选下还没有书' : '书架空空如也，点「添加图书」从豆瓣建条目，或直接上传 epub / pdf / txt'}</div>`
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
    let synced = 0
    for (const file of files) {
      prog.textContent = `解析 ${file.name} ...`
      const meta = await parseEpubMeta(file)
      prog.textContent = `上传并匹配豆瓣 ${file.name} ...`
      try {
        const data = await uploadFile(file, { ...meta, category: filterCategory })
        if (data?.douban) synced += 1
      } catch (err) {
        failed += 1
        toast(err.message, true)
      }
    }
    prog.textContent = ''
    e.target.value = ''
    if (files.length > failed) {
      toast(`已上传 ${files.length - failed} 本${synced ? `，其中 ${synced} 本已同步豆瓣信息` : ''}`)
    }
    await rerender(render, main)
  }

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
  input.accept = '.epub,.pdf,.txt'
  input.onchange = async () => {
    const file = input.files?.[0]
    if (!file) return
    try {
      const data = await uploadFile(file, { bookId })
      toast(data?.douban ? `已上传：${file.name}（已同步豆瓣信息）` : `已上传：${file.name}`)
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
  const env = await res.json().catch(() => null)
  if (!res.ok || env?.code !== 0) {
    throw new Error(env?.message || `上传失败：${file.name}（HTTP ${res.status}）`)
  }
  return env.data
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

export function destroy() {
  document.getElementById('dlg-body').innerHTML = ''
}
