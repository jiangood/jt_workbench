import { api, closeMoreMenu, esc, fmtReadTime, icon, loadScriptOnce, moreMenu, readBookStats, rerender, rerenderKeepingFocus, run, setupMoreMenus, showDialog, toast } from '../lib.js'
// 组件叫 filterGroup，和「分组」业务概念无关：本页只用它渲染阅读状态筛选条
import { emptyState, filterGroup as filterButtons, setupFilter } from '../ui.js'
import { enqueue } from '../upload.js'

let filterStatus = 'all'
/**
 * 排序方式：recent（默认）= 最近阅读倒序、同时间按 id；
 * time = 上传（加入书架）时间倒序；title = 书名，中文按拼音、数字按大小
 */
let sortBy = 'recent'
/** 书架内搜索：只筛本地已加载的数据，不发请求；切页后保留，返回时还在原结果上 */
let searchQuery = ''
/** 输入防抖：书架可能上百本，逐字重建卡片没必要 */
let searchTimer = 0
/** 视图是否还是当前页：切页后不要再用旧视图的 main 去刷接口 */
let alive = true

const SORTS = [
  { value: 'recent', label: '最近阅读' },
  { value: 'time', label: '上传时间' },
  { value: 'title', label: '书名' },
]

const bookTitle = (b) => b.title || b.filename || ''
const titleCollator = new Intl.Collator('zh', { numeric: true, sensitivity: 'base' })

/** 书架搜索的命中范围：书名 / 作者 / 分组 / 文件名，空格分隔的多个关键词按「且」匹配 */
function matchesQuery(b, query) {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!tokens.length) return true
  const haystack = [bookTitle(b), b.author, b.category, b.filename].filter(Boolean).join(' ').toLowerCase()
  return tokens.every((token) => haystack.includes(token))
}

/** 阅读状态计数：筛选条上的数字，搜索时按命中结果统计 */
function countByStatus(list) {
  const counts = { all: list.length, unread: 0, reading: 0, read: 0 }
  for (const b of list) counts[b.status] = (counts[b.status] ?? 0) + 1
  return counts
}

/**
 * recent 是默认排序：最近阅读过的书置顶（lastReadAt 由阅读器打开 / 翻页回写），
 * 没读过的一律算 0，掉到后面按 id 升序（录入顺序）。
 * 三项都用 id 兜底而不是书名：书名是用户随时会改的字段，改名后书不该在书架里换位置。
 */
const SORT_FN = {
  recent: (a, b) => (b.lastReadAt ?? 0) - (a.lastReadAt ?? 0) || (a.id ?? 0) - (b.id ?? 0),
  time: (a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0) || (a.id ?? 0) - (b.id ?? 0),
  title: (a, b) => titleCollator.compare(bookTitle(a), bookTitle(b)) || (a.id ?? 0) - (b.id ?? 0),
}

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

/** 「更多」下拉里的标记状态项：已读用对勾，阅读中用时钟，待读回到书本 */
const STATUS_ICON = { unread: 'book', reading: 'clock', read: 'online' }

const statusLabel = (s) => STATUS[s]?.label ?? '待读'
const statusBadge = (s) => `<span class="badge ${STATUS[s]?.cls ?? 'muted'}">${statusLabel(s)}</span>`

/** 豆瓣图床带 Referer 防盗链，封面统一走 Worker 代理 */
const coverUrl = (url) => (url ? `/api/book/cover?url=${encodeURIComponent(url)}` : '')

/** 书籍只支持 EPUB：遗留的 pdf / txt 记录仍可下载，但不再进阅读页 */
const isReadable = (b) => b.fmt === 'epub'

/** 封面底部进度条：pct 是 0–100 的整数 */
function progressBar(pct) {
  const value = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)))
  return `<span class="book-progress" role="img" aria-label="阅读进度 ${value}%">
              <span class="book-progress-track"><i style="width:${value}%"></i></span>
              <span class="book-progress-num">${value}%</span>
            </span>`
}

/** 单张书卡：分组由外层 section 表达，卡片内不再重复分组徽标 */
function bookCard(b) {
  const cover = coverUrl(b.cover)
  const title = b.title || b.filename
  const meta = [b.author || '未知作者', b.pubYear].filter(Boolean).join(' · ')
  const label = esc(title)
  // 只给读到过的书显示进度：0 / 空 = 还没开始，不占封面；已读的书一律按 100% 画（老数据没有 progress 列）
  const progress = b.status === 'read' ? 100 : Number(b.progress)
  const showProgress = b.hasFile && Number.isFinite(progress) && progress > 0
  // 本机累计阅读时长（issue #23）：没有记录 / 不足 1 分钟不占位
  const readTime = b.hasFile ? fmtReadTime(readBookStats(b.id).ms) : ''
  // 有文件时封面本身就是阅读入口；工具栏里再留一个小图标，照顾「看不出封面能点」的人
  const readable = b.hasFile && isReadable(b)
  const coverTag = readable ? 'a' : 'div'
  const coverAttrs = readable
    ? ` href="#/reader?id=${esc(b.id)}" title="阅读《${label}》" aria-label="阅读《${label}》"`
    : ''
  return `
        <article class="book-card">
          <${coverTag} class="book-cover${cover ? '' : ' no-cover'}"${coverAttrs}>
            <span class="book-cover-ph">${icon('book', 36)}</span>
            ${cover ? `<img src="${esc(cover)}" alt="" loading="lazy">` : ''}
            ${statusBadge(b.status)}
            ${showProgress ? progressBar(progress) : ''}
          </${coverTag}>
          <div class="book-body">
            <h3 class="book-title" title="${label}">${esc(title)}</h3>
            <p class="book-by small muted" title="${esc(meta)}">${esc(meta)}</p>
            <div class="book-meta">
              ${b.rating ? `<span class="book-rating small muted">${icon('star', 12)}${esc(b.rating)}</span>` : ''}
              ${
                readTime
                  ? `<span class="book-read-time small muted" title="本机累计阅读 ${esc(readTime)}">${icon('clock', 12)}${esc(readTime)}</span>`
                  : ''
              }
              ${
                !b.hasFile
                  ? '<span class="badge warn">待上传</span>'
                  : readable
                    ? '<span class="badge muted">EPUB</span>'
                    : '<span class="badge warn">格式已停用</span>'
              }
            </div>
            <div class="book-actions">
              <div class="book-tools">
                ${
                  readable
                    ? `<a class="btn sm key" href="#/reader?id=${esc(b.id)}"
                          title="阅读《${label}》" aria-label="阅读《${label}》">${icon('book', 14)}</a>`
                    : `<button class="btn sm key" data-upload="${esc(b.id)}"
                          title="${b.hasFile ? '更换为 EPUB 文件' : `上传《${label}》的文件`}"
                          aria-label="${b.hasFile ? '更换为 EPUB 文件' : `上传《${label}》的文件`}">${icon(b.hasFile ? 'refresh' : 'upload', 14)}</button>`
                }
                <button class="btn sm" data-e="${esc(b.id)}" title="编辑" aria-label="编辑《${label}》">${icon('edit', 14)}</button>
                <button class="btn sm" data-sync="${esc(b.id)}" title="用豆瓣信息更新书名 / 作者 / 封面 / 简介 / 评分"
                        aria-label="同步豆瓣信息《${label}》">${icon('refresh', 14)}</button>
                ${moreMenu(
                  `book-${b.id}`,
                  [
                    ...(b.hasFile
                      ? [
                          {
                            label: '下载原文件',
                            icon: 'download',
                            href: `/api/book/read/${b.id}?v=${b.fileVersion ?? b.updatedAt}`,
                            attrs: { download: '' },
                          },
                        ]
                      : []),
                    // 标记阅读状态放删除前面：同一菜单里先低频不可逆，删除永远最后一项
                    ...['unread', 'reading', 'read'].map((s) => ({
                      label: b.status === s ? `当前：${statusLabel(s)}` : `标记为${statusLabel(s)}`,
                      icon: STATUS_ICON[s],
                      disabled: b.status === s,
                      attrs: { 'data-status': s, 'data-id': b.id },
                    })),
                    { label: '删除这本书', icon: 'trash', danger: true, attrs: { 'data-d': b.id } },
                  ],
                  { label: `更多操作《${title}》`, triggerClass: 'btn sm' },
                )}
              </div>
            </div>
          </div>
        </article>`
}

/** 分组分区 HTML：同名分组一整堆展示，未分组固定最后一区 */
function renderGroups(sections, showGroupHead) {
  return `<div class="book-groups">
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
}

/** 结果区 HTML：搜索无命中时给一个清空入口，不留死胡同 */
function resultsHTML(shown, sections, showGroupHead, hasBooks) {
  if (shown.length) {
    const meta = searchQuery
      ? `<p class="book-search-meta small muted" role="status">搜索「${esc(searchQuery)}」· ${shown.length} 本</p>`
      : ''
    return `${meta}${renderGroups(sections, showGroupHead)}`
  }
  if (searchQuery) {
    return `<div class="empty" role="status">当前筛选下没有匹配「${esc(searchQuery)}」的书
      <button class="link-btn" type="button" data-clear-search>清空搜索</button></div>`
  }
  return emptyState(
    hasBooks
      ? '当前筛选下还没有书'
      : '书架空空如也，点「添加图书」从豆瓣建条目，或直接上传 epub',
  )
}

export async function render(main) {
  alive = true
  // jszip 只有「上传 epub 读元数据」用得到，改到 parseEpubMeta 里按需加载：
  // 之前它挡在书架首次渲染前面，跨境链路上白等 1 秒多
  const data = await api('/api/book/list')
  const books = data.books ?? []

  const totalCounts = countByStatus(books)
  if (filterStatus !== 'all' && !totalCounts[filterStatus]) filterStatus = 'all'

  // 分组候选：添加 / 编辑弹窗的 datalist 与展示分区共用同一份名字（NULL = 未分组，不算一组）
  const groups = [...new Set(books.map((b) => b.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh'))

  // 先搜索，再按阅读状态筛，最后按分组归堆：空分区不渲染
  const keyword = searchQuery.trim()
  const matched = keyword ? books.filter((b) => matchesQuery(b, keyword)) : books
  const matchCounts = countByStatus(matched)
  const sortFn = SORT_FN[sortBy] ?? SORT_FN.recent
  const shown = matched.filter((b) => filterStatus === 'all' || b.status === filterStatus).sort(sortFn)
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
        <p class="page-sub">豆瓣索引先建条目，有文件后再上传 · 上传后自动匹配豆瓣信息 · 按分组归架，区分待读 / 阅读中 / 已读 · 支持按书名 / 作者 / 分组搜索，可按最近阅读 / 上传时间 / 书名排序</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" id="add-book">${icon('plus')}添加图书</button>
        <button class="btn" id="batch-book">${icon('queue')}批量添加</button>
        <label class="btn">
          ${icon('upload')}上传文件
          <input class="sr-only" type="file" id="up" accept=".epub" multiple>
        </label>
      </div>
    </div>
    <div class="book-toolbar">
      ${filterButtons({
        name: 'status',
        label: '阅读状态',
        active: filterStatus,
        items: STATUS_TABS.map((s) => ({ ...s, count: matchCounts[s.value] ?? 0 })),
      })}
      <div class="book-toolbar-end">
        <input class="field field-sm book-search" id="book-search" type="search"
               placeholder="搜索书名 / 作者 / 分组…" aria-label="搜索书架"
               value="${esc(searchQuery)}" autocomplete="off" spellcheck="false">
        <label class="book-sort">
          排序
          <select class="field field-sm" id="book-sort" data-focus-key="book-sort">
            ${SORTS.map(
              (s) => `<option value="${s.value}"${s.value === sortBy ? ' selected' : ''}>${s.label}</option>`,
            ).join('')}
          </select>
        </label>
      </div>
    </div>
    <div id="book-results">${resultsHTML(shown, sections, showGroupHead, books.length)}</div>`

  const resultsEl = main.querySelector('#book-results')
  const searchInput = main.querySelector('#book-search')
  const statusGroup = main.querySelector('[data-filter-group="status"]')

  /** 结果区内的卡片动作：搜索只换结果区，这些监听要跟着新节点重挂 */
  function bindResults() {
    // 封面加载失败（豆瓣限流 / 下架）时退回占位图标
    setupMoreMenus(resultsEl)
    resultsEl.querySelectorAll('.book-cover img').forEach((img) => {
      img.addEventListener('error', () => img.closest('.book-cover')?.classList.add('no-cover'))
    })
    resultsEl.querySelectorAll('[data-upload]').forEach((b) => {
      b.onclick = () => pickFile(b.dataset.upload, main)
    })
    resultsEl.querySelectorAll('[data-e]').forEach((b) => {
      b.onclick = () => {
        const row = books.find((x) => String(x.id) === b.dataset.e)
        if (row) openEditDialog(row, main, groups)
      }
    })
    resultsEl.querySelectorAll('[data-sync]').forEach((b) => {
      b.onclick = async () => {
        if (!confirm('用豆瓣信息覆盖书名、作者、封面、简介和评分？分组与阅读状态不受影响。')) return
        const res = await run(b, () => api(`/api/book/${b.dataset.sync}/sync`, { method: 'POST' }))
        if (!res.ok) return
        toast(`已同步：${res.data?.title || '豆瓣信息'}`)
        await rerender(render, main)
      }
    })
    resultsEl.querySelectorAll('[data-status]').forEach((el) => {
      el.onclick = async () => {
        const id = el.dataset.id
        const status = el.dataset.status
        // 当前项在菜单里就是 disabled，这里再兜一层
        if (!id || !STATUS[status]) return
        const row = books.find((x) => String(x.id) === id)
        if (!row || row.status === status) return
        // 后端联动：已读 = finished_at 落时 + 进度 100%，退回待读 = 进度清零
        const res = await run(el, () => api(`/api/book/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) }))
        if (!res.ok) return
        toast(`已标记为${statusLabel(status)}：《${bookTitle(row)}》`)
        await rerender(render, main)
      }
    })
    resultsEl.querySelectorAll('[data-d]').forEach((b) => {
      b.onclick = async () => {
        if (!confirm('删除该书（已上传的 R2 文件一并删除）？')) return
        const res = await run(b, () => api(`/api/book/${b.dataset.d}`, { method: 'DELETE' }))
        if (!res.ok) return
        toast('已删除')
        await rerender(render, main)
      }
    })
    resultsEl.querySelector('[data-clear-search]')?.addEventListener('click', () => {
      clearTimeout(searchTimer)
      searchQuery = ''
      searchInput.value = ''
      searchInput.focus()
      paintResults()
    })
  }

  /** 搜索只重画结果区：输入框不重建，焦点和光标都留在原处 */
  function paintResults() {
    const query = searchQuery.trim()
    const matchedNow = query ? books.filter((b) => matchesQuery(b, query)) : books
    const sortFnNow = SORT_FN[sortBy] ?? SORT_FN.recent
    const shownNow = matchedNow
      .filter((b) => filterStatus === 'all' || b.status === filterStatus)
      .sort(sortFnNow)
    const sectionsNow = [
      ...groups.map((name) => ({ name, books: shownNow.filter((b) => b.category === name) })),
      { name: '', books: shownNow.filter((b) => !b.category) },
    ].filter((section) => section.books.length)
    resultsEl.innerHTML = resultsHTML(
      shownNow,
      sectionsNow,
      !(sectionsNow.length === 1 && !sectionsNow[0].name),
      books.length,
    )

    // 筛选条上的数字跟着搜索命中结果走
    const countsNow = countByStatus(matchedNow)
    statusGroup?.querySelectorAll('[data-filter-value]').forEach((btn) => {
      const count = btn.querySelector('.tab-count')
      if (count) count.textContent = String(countsNow[btn.dataset.filterValue] ?? 0)
    })
    bindResults()
  }

  bindResults()

  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer)
    searchTimer = setTimeout(() => {
      searchQuery = searchInput.value.trim()
      paintResults()
    }, 120)
  })

  searchInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !searchInput.value) return
    e.preventDefault()
    clearTimeout(searchTimer)
    searchQuery = ''
    searchInput.value = ''
    paintResults()
  })

  // type=search 的原生清除「×」只触发 search 事件
  searchInput.addEventListener('search', () => {
    if (searchInput.value.trim()) return
    clearTimeout(searchTimer)
    searchQuery = ''
    paintResults()
  })

  // 状态筛选：重绘整页，但焦点要留在刚点的按钮上（data-focus-key）
  setupFilter(statusGroup, (value) => {
    // 防抖可能还没触发：整页重绘前先把输入框里的关键字落定
    clearTimeout(searchTimer)
    searchQuery = searchInput.value.trim()
    filterStatus = value
    rerenderKeepingFocus(render, main)
  })

  // 排序同样是原地换数据，焦点留在下拉框上
  main.querySelector('#book-sort').onchange = (e) => {
    clearTimeout(searchTimer)
    searchQuery = searchInput.value.trim()
    sortBy = SORTS.some((s) => s.value === e.target.value) ? e.target.value : 'recent'
    rerenderKeepingFocus(render, main)
  }

  main.querySelector('#add-book').onclick = () => openAddDialog(main, groups)
  main.querySelector('#batch-book').onclick = () => openBatchDialog(main, groups)

  main.querySelector('#up').onchange = (e) => {
    const files = [...e.target.files]
    e.target.value = ''
    if (!files.length) return
    enqueue(files, uploadOptions(main))
  }
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

/* ---------------- 批量添加：一个多行文本 + 分组 ---------------- */

/** 与 Worker 的 MAX_BATCH 对齐：免费版 D1 每次请求只有 50 条语句额度 */
const MAX_BATCH = 50

/** 每行一本，整行都是书名（不做字段拆分，作者 / 分组等由豆瓣和分组框补） */
function parseBatchTitles(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

/** 失败清单太长时只列前几本，避免把弹窗撑爆 */
function titleList(titles, max = 3) {
  const head = titles.slice(0, max).map((t) => `《${t}》`).join('、')
  return titles.length > max ? `${head} 等 ${titles.length} 本` : head
}

/**
 * 批量添加是「先确认再入库」：逐本查豆瓣，全部对上才一次性写入。
 * 任何一本查不到 / 查询出错都不入库，让用户单独添加（避免书架里混进没信息的空条目）。
 */
function openBatchDialog(main, groups) {
  const { close, body } = showDialog(
    `<h2>批量添加图书</h2>
     <p class="small muted">每行一本，只写书名。点「添加」后会先逐本查豆瓣，全部确认到条目才一起入库；
       有任何一本查不到或有歧义，整批都不会添加，请把那几本单独添加。</p>
     <label class="form-label mt-2" for="batch-text">书目清单</label>
     <textarea class="field" id="batch-text" rows="10" spellcheck="false"
       placeholder="三体&#10;人类简史&#10;明朝那些事儿"></textarea>
     <label class="form-label mt-2" for="batch-group">分组（可选，整批共用）</label>
     <input class="field" id="batch-group" list="batch-group-list" maxlength="50"
            placeholder="如 小说 / 技术 / 历史，留空则未分组" autocomplete="off">
     <datalist id="batch-group-list">${groups.map((c) => `<option value="${esc(c)}"></option>`).join('')}</datalist>
     <div class="field-error" id="batch-msg" role="alert"></div>
     <p class="small muted" id="batch-count" aria-live="polite"></p>
     <div class="dlg-foot">
       <button class="btn sm" type="button" data-close>取消</button>
       <button class="btn primary sm" type="button" id="batch-save">添加</button>
     </div>`,
    { label: '批量添加图书' },
  )

  const textEl = body.querySelector('#batch-text')
  const groupEl = body.querySelector('#batch-group')
  const msg = body.querySelector('#batch-msg')
  const countEl = body.querySelector('#batch-count')
  const saveBtn = body.querySelector('#batch-save')

  const count = () => {
    const n = parseBatchTitles(textEl.value).length
    countEl.textContent = n ? `已识别 ${n} 本` : ''
    msg.textContent = ''
  }
  textEl.addEventListener('input', count)

  saveBtn.onclick = async () => {
    const titles = [...new Set(parseBatchTitles(textEl.value))]
    if (!titles.length) {
      msg.textContent = '请每行填写一本书名'
      textEl.focus()
      return
    }
    if (titles.length > MAX_BATCH) {
      msg.textContent = `一次最多 ${MAX_BATCH} 本，请分批添加`
      return
    }

    // 第一步：逐本查豆瓣（每本都是独立请求，不会撞 Worker 单次子请求上限）
    const lookup = await run(
      saveBtn,
      async () => {
        const found = []
        const missing = []
        for (let i = 0; i < titles.length; i += 1) {
          countEl.textContent = `正在查询豆瓣 ${i + 1}/${titles.length}…`
          const data = await api(`/api/book/search?q=${encodeURIComponent(titles[i])}`)
          if (data.match) found.push(data.match)
          else missing.push(titles[i])
        }
        return { found, missing }
      },
      { silent: true },
    )
    if (!lookup.ok) {
      countEl.textContent = ''
      msg.textContent = lookup.error?.message || '查询豆瓣失败，请稍后再试'
      return
    }
    const { found, missing } = lookup.data
    if (missing.length) {
      countEl.textContent = ''
      msg.textContent = `豆瓣没有查到 ${titleList(missing)}，整批未添加。请把那几本单独添加。`
      return
    }

    // 已在书架的直接跳过（不当作失败），剩下的整批入库
    const fresh = found.filter((o) => !o.added)
    if (!fresh.length) {
      countEl.textContent = ''
      msg.textContent = '这些书都已经在书架里了'
      return
    }

    const category = groupEl.value.trim() || null
    const saved = await run(saveBtn, () =>
      api('/api/book/batch', {
        method: 'POST',
        body: JSON.stringify({
          items: fresh.map((o) => ({
            title: o.title,
            author: o.author,
            category,
            cover: o.cover,
            pubYear: o.year,
            doubanId: o.doubanId,
            doubanUrl: o.url,
          })),
        }),
      }),
    )
    if (!saved.ok) {
      countEl.textContent = ''
      return
    }
    const added = saved.data?.added ?? 0
    const skipped = (saved.data?.skipped ?? 0) + (found.length - fresh.length)
    close()
    toast(`已添加 ${added} 本${skipped ? `，跳过 ${skipped} 本重复` : ''}`)
    await rerender(render, main)
  }

  // Ctrl / Cmd + Enter 直接提交，纯文本框里也顺手
  textEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      saveBtn.click()
    }
  })

  body.querySelector('[data-close]').onclick = close
  textEl.focus()
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
    // 后端按字节流处理，不信任浏览器猜的 MIME
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
  input.accept = '.epub'
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
  clearTimeout(searchTimer)
  closeMoreMenu()
  document.getElementById('dlg-body').innerHTML = ''
}
