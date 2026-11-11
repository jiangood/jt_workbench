import { api, esc, icon, loadScriptOnce, rerender, rerenderKeepingFocus, run, showDialog, toast } from '../lib.js'
// 组件叫 filterGroup，和「分组」业务概念无关：本页只用它渲染阅读状态筛选条
import { emptyState, filterGroup as filterButtons, setupFilter } from '../ui.js'
import { enqueue } from '../upload.js'

let filterStatus = 'all'
/** 视图是否还是当前页：切页后不要再用旧视图的 main 去刷接口 */
let alive = true

const STATUS_TABS = [
  { value: 'all', label: '全部' },
  { value: 'unread', label: '待读' },
  { value: 'reading', label: '阅读中' },
  { value: 'read', label: '已读' },
]

const STATUS = {
  unread: { label: '待读', cls: 'muted' },
  reading: { label: '阅读中', cls: 'warn' },
  read: { label: '已读', cls: 'ok' },
}

const statusLabel = (s) => STATUS[s]?.label ?? '待读'
const statusBadge = (s) => `<span class="badge ${STATUS[s]?.cls ?? 'muted'}">${statusLabel(s)}</span>`

/** 豆瓣图床带 Referer 防盗链，封面统一走 Worker 代理 */
const coverUrl = (url) => (url ? `/api/book/cover?url=${encodeURIComponent(url)}` : '')

/** 单张书卡：分组由外层 section 表达，卡片内不再重复分组徽标 */
function bookCard(b) {
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
            <h3 class="book-title" title="${label}">${esc(title)}</h3>
            <p class="book-by small muted" title="${esc(meta)}">${esc(meta)}</p>
            <div class="book-meta">
              ${b.rating ? `<span class="book-rating small muted">${icon('star', 12)}${esc(b.rating)}</span>` : ''}
              ${
                b.hasFile
                  ? `<span class="badge muted">${esc((b.fmt || '').toUpperCase())}</span>`
                  : '<span class="badge warn">待上传</span>'
              }
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
                    ? `<a class="btn sm" href="/api/book/read/${esc(b.id)}?v=${esc(b.fileVersion ?? b.updatedAt)}" download
                          title="下载原文件" aria-label="下载原文件《${label}》">${icon('download', 14)}</a>`
                    : ''
                }
                <button class="btn sm danger" data-d="${esc(b.id)}" title="删除" aria-label="删除《${label}》">${icon('trash', 14)}</button>
              </div>
            </div>
          </div>
        </article>`
}

export async function render(main) {
  alive = true
  // jszip 只有「上传 epub 读元数据」用得到，改到 parseEpubMeta 里按需加载：
  // 之前它挡在书架首次渲染前面，跨境链路上白等 1 秒多
  const data = await api('/api/book/list')
  const books = data.books ?? []

  const counts = { all: books.length, unread: 0, reading: 0, read: 0 }
  for (const b of books) counts[b.status] = (counts[b.status] ?? 0) + 1
  if (filterStatus !== 'all' && !counts[filterStatus]) filterStatus = 'all'

  // 分组候选：添加 / 编辑弹窗的 datalist 与展示分区共用同一份名字（NULL = 未分组，不算一组）
  const groups = [...new Set(books.map((b) => b.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh'))

  // 先按阅读状态筛，再按分组归堆：同名分组排在一起，未分组固定放最后，空分区不渲染
  const shown = books.filter((b) => filterStatus === 'all' || b.status === filterStatus)
  const sections = [
    ...groups.map((name) => ({ name, books: shown.filter((b) => b.category === name) })),
    { name: '', books: shown.filter((b) => !b.category) },
  ].filter((section) => section.books.length)
  // 只有「未分组」一堆时不显示分区标题，避免一条孤零零的分组名
  const showGroupHead = !(sections.length === 1 && !sections[0].name)

  main.innerHTML = `
    <div class="page-head">
      <div>
        <h1 class="page-title">书架</h1>
        <p class="page-sub">豆瓣索引先建条目，有文件后再上传 · 上传后自动匹配豆瓣信息 · 按分组归架，区分待读 / 阅读中 / 已读</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" id="add-book">${icon('plus')}添加图书</button>
        <label class="btn">
          ${icon('upload')}上传文件
          <input class="sr-only" type="file" id="up" accept=".epub,.pdf,.txt" multiple>
        </label>
      </div>
    </div>
    ${filterButtons({
      name: 'status',
      label: '阅读状态',
      active: filterStatus,
      items: STATUS_TABS.map((s) => ({ ...s, count: counts[s.value] ?? 0 })),
    })}
    ${
      shown.length
        ? `<div class="book-groups">
            ${sections
              .map(
                (section, i) => `<section class="book-group"${
                  showGroupHead ? ` aria-labelledby="book-group-${i}"` : ''
                }>
              ${
                showGroupHead
                  ? `<div class="book-group-head">
                <h2 class="book-group-title" id="book-group-${i}">${section.name ? esc(section.name) : '未分组'}</h2>
                <span class="tab-count">${section.books.length}</span>
              </div>`
                  : ''
              }
              <div class="book-grid">${section.books.map(bookCard).join('')}</div>
            </section>`,
              )
              .join('')}
          </div>`
        : emptyState(
            books.length
              ? '当前筛选下还没有书'
              : '书架空空如也，点「添加图书」从豆瓣建条目，或直接上传 epub / pdf / txt',
          )
    }`

  // 封面加载失败（豆瓣限流 / 下架）时退回占位图标
  main.querySelectorAll('.book-cover img').forEach((img) => {
    img.addEventListener('error', () => img.closest('.book-cover')?.classList.add('no-cover'))
  })

  // 状态筛选：重绘整页，但焦点要留在刚点的按钮上（data-focus-key）
  setupFilter(main.querySelector('[data-filter-group="status"]'), (value) => {
    filterStatus = value
    rerenderKeepingFocus(render, main)
  })

  main.querySelector('#add-book').onclick = () => openAddDialog(main, groups)

  main.querySelector('#up').onchange = (e) => {
    const files = [...e.target.files]
    e.target.value = ''
    if (!files.length) return
    enqueue(files, uploadOptions(main))
  }

  main.querySelectorAll('[data-upload]').forEach((b) => {
    b.onclick = () => pickFile(b.dataset.upload, main)
  })
  main.querySelectorAll('[data-e]').forEach((b) => {
    b.onclick = () => {
      const row = books.find((x) => String(x.id) === b.dataset.e)
      if (row) openEditDialog(row, main, groups)
    }
  })
  main.querySelectorAll('[data-sync]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('用豆瓣信息覆盖书名、作者、封面、简介和评分？分组与阅读状态不受影响。')) return
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

function openAddDialog(main, groups) {
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
           <label class="form-label" for="book-group">分组</label>
           <input class="field" id="book-group" list="book-group-list" maxlength="50"
                  placeholder="如 小说 / 技术 / 历史" autocomplete="off">
           <datalist id="book-group-list">${groups.map((c) => `<option value="${esc(c)}"></option>`).join('')}</datalist>
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
  const groupEl = body.querySelector('#book-group')
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
    groupEl.focus()

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
      category: groupEl.value.trim() || null,
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

function openEditDialog(row, main, groups) {
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
           <label class="form-label" for="edit-group">分组</label>
           <input class="field" id="edit-group" list="edit-group-list" maxlength="50"
                  placeholder="未分组" value="${esc(row.category || '')}">
           <datalist id="edit-group-list">${groups.map((c) => `<option value="${esc(c)}"></option>`).join('')}</datalist>
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
      category: body.querySelector('#edit-group').value.trim() || null,
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

/** 书架上传的公共选项：批量选文件与单本补传走同一个队列 */
function uploadOptions(main, params = {}) {
  return {
    title: '上传图书文件',
    params,
    prepare: (file) => parseEpubMeta(file),
    url: (qs) => `/api/book/upload?${qs}`,
    // 后端给 epub/pdf/txt 统一按字节流处理，不信任浏览器猜的 MIME
    contentType: () => 'application/octet-stream',
    // 字节发完后 Worker 还要同步豆瓣，进度条会停在 100%，必须显式告诉用户还在处理
    processingLabel: '处理中（匹配豆瓣信息…）',
    onSettled: (summary) => {
      if (alive && summary.ok) rerender(render, main)
    },
  }
}

function pickFile(bookId, main) {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.epub,.pdf,.txt'
  input.onchange = () => {
    const file = input.files?.[0]
    if (!file) return
    enqueue([file], uploadOptions(main, { bookId }))
  }
  input.click()
}

/** epub 元数据：浏览器端 JSZip 读 OPF（v3 决策 #9）；失败返回空对象，用文件名兜底 */
async function parseEpubMeta(file) {
  if (!file.name.toLowerCase().endsWith('.epub')) return {}
  try {
    await loadScriptOnce('/vendor/jszip.min.js')
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
  alive = false
  document.getElementById('dlg-body').innerHTML = ''
}
