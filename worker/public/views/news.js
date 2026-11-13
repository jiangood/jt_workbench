import { api, esc, icon, loadScriptOnce, rerender, run, scrollToTop, showDialog, toast } from '../lib.js'
import { emptyState } from '../ui.js'

const PAGE_SIZE = 30
let page = 1
let total = 0
let blocks = []
let sources = []
let sourceIdx = {}
let loading = false
let observer = null
/** 渲染序号：无限滚动的异步加载在 await 后检查，避免把旧页数据追加进重绘后的新列表 */
let renderToken = 0

/** 正文消毒在浏览器端（原文入库，v3 决策 #9） */
function sanitize(html) {
  return html ? window.DOMPurify.sanitize(html) : ''
}

function sourceName(id) {
  return sourceIdx[id] || id
}

/** 人类可读的相对时间（资讯页顶部「上次同步」用；不引第三方库） */
function agoText(ts) {
  const t = Number(ts) || 0
  if (!t) return '尚未同步'
  const min = Math.floor(Math.max(0, Date.now() - t) / 60_000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hours = Math.floor(min / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.floor(hours / 24)} 天前`
}

function matchBlocks(item) {
  const text = `${item.title || ''} ${item.author || ''}`
  return blocks.some((b) => {
    if (!b.enabled) return false
    if (b.sourceId && b.sourceId !== item.sourceId) return false
    return text.toLowerCase().includes(b.keyword.toLowerCase())
  })
}

function itemHtml(i) {
  const link = i.link || ''
  return `
    <div class="news-item">
      <div class="flex between center">
        <div class="flex center flex-grow-1 news-line">
          <a class="news-title" href="${esc(link || '#')}" target="_blank" rel="noopener">${esc(i.title || '(无标题)')}</a>
        </div>
        <small class="muted nowrap ms-3">${i.publishedAt ? new Date(i.publishedAt).toLocaleDateString() : ''}</small>
      </div>
      <div class="flex between center mt-1">
        <small class="muted">${esc(sourceName(i.sourceId))}${i.author ? ' · ' + esc(i.author) : ''}</small>
        <span data-origin="${esc(i.id)}"></span>
      </div>
      <div class="small item-preview mt-1" data-id="${esc(i.id)}"></div>
    </div>`
}

/** 预览里重复的「点击查看原文」入口（标题本身就是链接，issue #22） */
const DUP_ORIGIN_TEXT = /^(?:点击查看原文|查看原文|阅读原文|阅读全文|查看全文|原文链接|原文|read\s*more|more)\s*[»›>→]*$/i

/**
 * 单条正文预览：DOMPurify 消毒后注入（消毒仍在浏览器端，v3 决策 #9）。
 * - 去掉与标题重复的「点击查看原文」；剩下没有正文时收成行尾「原文 ↗」小按钮
 * - 坏链图片（上游 `https:https://…` 之类）加载失败就移除，不留碎图标
 */
function fillOrigin(el, item, link) {
  const slot = el.closest('.news-item')?.querySelector(`[data-origin="${esc(item?.id)}"]`)
  if (!slot || slot.childElementCount || !link) return
  const hasBody = !!el.textContent.trim() || !!el.querySelector('img, video, iframe, table')
  if (!hasBody) slot.innerHTML = `<a class="btn sm" href="${esc(link)}" target="_blank" rel="noopener">原文 ↗</a>`
}

function applyPreview(el, item) {
  el.innerHTML = sanitize(item?.preview || '')
  const link = item?.link || ''
  el.querySelectorAll('a[href]').forEach((a) => {
    const text = (a.textContent || '').replace(/\s+/g, ' ').trim()
    const sameTarget = !!link && a.href === link && !a.querySelector('img')
    if (DUP_ORIGIN_TEXT.test(text) || sameTarget) {
      a.remove()
      return
    }
    a.target = '_blank'
    a.rel = 'noopener'
  })
  // 移除链接后可能留下空块（<p> </p>），顺手清掉，避免多一行空白
  el.querySelectorAll('p, div, li, span, section').forEach((n) => {
    if (!n.textContent.trim() && !n.querySelector('img, video, iframe, table')) n.remove()
  })
  el.querySelectorAll('img').forEach((img) => {
    img.loading = 'lazy'
    img.decoding = 'async'
    // 加载失败（含 CSP 拦掉的 http 图）就移除整张图；只剩图的条目降级成「原文 ↗」
    img.onerror = () => {
      img.remove()
      fillOrigin(el, item, link)
    }
  })
  fillOrigin(el, item, link)
}

/** 正文预览：只处理本批返回的条目，避免把已注入的旧预览清空 */
function applyPreviews(root, items) {
  const byId = new Map(items.map((x) => [String(x.id), x]))
  root.querySelectorAll('.item-preview').forEach((el) => {
    const it = byId.get(el.dataset.id)
    if (it) applyPreview(el, it)
  })
}

/** 分页信息：无限滚动下显示「第 N / 总页」= 已加载到第 N 页（总数接口给 total，这里换算页数） */
function totalPages() {
  return Math.max(1, Math.ceil(total / PAGE_SIZE))
}

function syncPager(main) {
  const pages = totalPages()
  const loaded = Math.min(pages, Math.max(1, page - 1))
  const info = main.querySelector('#page-info')
  if (info) info.textContent = `第 ${loaded} / ${pages} 页`
  const jump = main.querySelector('#page-jump')
  if (jump) jump.max = String(pages)
}

function setLoadStatus(main) {
  const el = main.querySelector('#load-status')
  if (!el) return
  if (!total) {
    el.textContent = ''
    return
  }
  el.textContent = page * PAGE_SIZE >= total ? `已全部加载（共 ${total} 条）` : '上滑加载更多'
}

/** 哨兵进入视口（含 400px 预取余量）就追加下一页 */
function setupInfiniteScroll(main) {
  const sentinel = main.querySelector('#sentinel')
  if (!sentinel || typeof IntersectionObserver === 'undefined') return
  observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) loadMore(main)
    },
    { rootMargin: '400px 0px' },
  )
  observer.observe(sentinel)
}

/** 追加下一页：屏蔽词在客户端过滤，整页可能被滤空，继续往后取直到出现可见条目或到底 */
async function loadMore(main) {
  const token = renderToken
  if (loading || page * PAGE_SIZE >= total) return
  loading = true
  const status = main.querySelector('#load-status')
  if (status) status.textContent = '加载中…'
  try {
    while (page * PAGE_SIZE < total) {
      const data = await api(`/api/news/items?page=${page}`)
      if (token !== renderToken) return // 视图已重绘 / 已跳页，别把旧页数据写进新列表
      page++
      total = Number(data.total) || total
      const visible = data.items.filter((i) => !matchBlocks(i))
      const list = main.querySelector('#items')
      if (!list) return
      list.querySelector('.empty')?.remove()
      list.insertAdjacentHTML('beforeend', visible.map(itemHtml).join(''))
      applyPreviews(main, data.items)
      if (visible.length) break
    }
  } finally {
    if (token === renderToken) loading = false
  }
  if (token !== renderToken) return
  setLoadStatus(main)
  syncPager(main)
}

/** 页码跳转（Enter 触发，越界 clamp）：列表直接换成目标页，之后继续向下无限滚动 */
async function goToPage(main, raw) {
  const target = Math.min(totalPages(), Math.max(1, Math.floor(Number(raw)) || 1))
  const list = main.querySelector('#items')
  if (!list) return
  const token = ++renderToken // 作废在途的 loadMore 结果
  loading = false
  const res = await run(null, () => api(`/api/news/items?page=${target}`))
  if (token !== renderToken) return
  if (!res.ok) return
  const data = res.data
  total = Number(data.total) || total
  page = target + 1
  const visible = data.items.filter((i) => !matchBlocks(i))
  list.innerHTML =
    visible.map(itemHtml).join('') ||
    (total ? '' : emptyState('暂无内容（等待抓取任务执行）'))
  applyPreviews(list, data.items)
  setLoadStatus(main)
  syncPager(main)
  scrollToTop()
}

export async function render(main) {
  await loadScriptOnce('/vendor/purify.min.js')

  // 无限滚动：每次进视图 / 切筛选都从第一页开始
  page = 1
  loading = false
  observer?.disconnect()
  observer = null
  const token = ++renderToken

  const [itemData, blockData, sourceData] = await Promise.all([
    api(`/api/news/items?page=${page}`),
    api('/api/news/blocks'),
    api('/api/news/sources'),
  ])
  blocks = blockData.blocks
  sources = sourceData.sources
  sourceIdx = Object.fromEntries(sources.map((s) => [s.id, s.name]))
  total = Number(itemData.total) || 0
  const visible = itemData.items.filter((i) => !matchBlocks(i))

  // 抓取健康度（issue #16）：上次同步时间 + 被熔断暂停 / 连续失败的源，一行可见
  const lastSync = sources.reduce((max, s) => Math.max(max, Number(s.lastRunAt) || 0), 0)
  const paused = sources.filter((s) => s.jobEnabled === 0 && s.jobStatus === 'failed')
  const failing = sources.filter((s) => s.jobEnabled !== 0 && Number(s.failStreak) > 0)
  const problems = [
    ...paused.map((s) => `${esc(s.name)}（已暂停）`),
    ...failing.map((s) => `${esc(s.name)}（连续失败 ${Number(s.failStreak)} 次）`),
  ]
  // 一次都没跑过（新库 / 刚加源）时别谎报「正常」，用中性 pill
  const syncState = problems.length ? 'warn' : lastSync ? 'ok' : ''
  const syncText = problems.length ? '抓取异常' : lastSync ? '抓取正常' : '等待首次同步'

  main.innerHTML = `
    <div class="page-head">
      <div>
        <h1 class="page-title">资讯</h1>
        <p class="page-sub">共 ${esc(itemData.total)} 条 · 正文在浏览器端消毒后展示</p>
      </div>
      <div class="page-actions">
        <button class="btn sm" id="btn-sources">${icon('news')}订阅源</button>
        <button class="btn sm" id="btn-blocks">${icon('close')}屏蔽词</button>
      </div>
    </div>
    <p class="small mt-1">
      <span class="pill${syncState ? ' ' + syncState : ''}"><span class="dot"></span>${syncText}</span>
      <span class="muted">上次同步 ${esc(agoText(lastSync))}${problems.length ? ` · ${problems.join('、')}` : ''}</span>
    </p>
    <div class="list" id="items">
      ${
        visible.map(itemHtml).join('') ||
        (total ? '' : emptyState('暂无内容（等待抓取任务执行）'))
      }
    </div>
    <p class="small muted text-center mt-2" id="pager">
      <span id="page-info">第 1 / ${totalPages()} 页</span>
      <label class="ms-3" for="page-jump">跳到</label>
      <input class="field-sm" id="page-jump" type="number" inputmode="numeric" min="1" step="1"
             style="width: 4.5em" aria-label="跳转到页码">
      <span>页</span>
    </p>
    <p class="small muted center mt-2" id="load-status" role="status">${total ? '上滑加载更多' : ''}</p>
    <div id="sentinel" aria-hidden="true"></div>`

  // 正文预览：原文已在列表返回，浏览器端 DOMPurify 消毒后注入
  applyPreviews(main, itemData.items)
  syncPager(main)
  setLoadStatus(main)

  main.querySelector('#btn-sources').onclick = () => showSources(main)
  main.querySelector('#btn-blocks').onclick = () => showBlocks(main)

  // 页码跳转：Enter 生效，越界由 goToPage clamp 到 1..总页
  const jumpInput = main.querySelector('#page-jump')
  jumpInput.onkeydown = (e) => {
    if (e.key !== 'Enter') return
    e.preventDefault()
    const target = jumpInput.value
    jumpInput.value = ''
    goToPage(main, target)
  }

  setupInfiniteScroll(main)
}

function showSources(main) {
  const rows = sources
    .map((s) => {
      const streak = Number(s.failStreak) || 0
      const paused = s.jobEnabled === 0 && s.jobStatus === 'failed'
      const lastError = String(s.lastError || '').slice(0, 120)
      const state = paused
        ? `<span class="pill warn"><span class="dot"></span>已暂停</span> <span class="muted">${esc(lastError || '连续 3 次失败')}</span>`
        : `<span class="muted">上次同步 ${esc(agoText(s.lastRunAt))}${streak ? ` · 连续失败 ${streak} 次` : ''}${streak && lastError ? ` · ${esc(lastError)}` : ''}</span>`
      return `
    <div class="flex between center bb">
      <div>
        <strong>${esc(s.name)}</strong> <span class="muted small">${esc(s.itemCount)} 条</span>
        <div class="small muted truncate" style="max-width: 380px">${esc(s.url)}</div>
        <div class="small truncate" style="max-width: 380px">${state}</div>
      </div>
      <div class="flex center">
        ${paused ? `<button class="btn sm" data-resume="${esc(s.id)}">恢复抓取</button>` : ''}
        <input type="checkbox" ${s.enabled ? 'checked' : ''} data-id="${esc(s.id)}" aria-label="启用 ${esc(s.name)}">
      </div>
    </div>`
    })
    .join('')
  showDialog(`<h2>订阅源</h2>${rows}`)
  // 熔断暂停的源：一键恢复（服务端会清零连败并立即排一次抓取）
  document.querySelectorAll('#dlg [data-resume]').forEach((btn) => {
    btn.onclick = async () => {
      const res = await run(btn, () =>
        api(`/api/news/sources/${btn.dataset.resume}`, { method: 'PUT', body: JSON.stringify({ enabled: true }) }),
      )
      if (!res.ok) return
      await rerender(render, main)
      showSources(main)
      toast('已恢复抓取')
    }
  })
  document.querySelectorAll('#dlg input[type=checkbox]').forEach((cb) => {
    cb.onchange = async () => {
      const res = await run(cb, () =>
        api(`/api/news/sources/${cb.dataset.id}`, { method: 'PUT', body: JSON.stringify({ enabled: cb.checked }) }),
      )
      if (!res.ok) {
        // 保存失败就把勾选回滚，别让界面和服务端不一致
        cb.checked = !cb.checked
        return
      }
      await rerender(render, main)
    }
  })
}

function showBlocks(main) {
  const rows = blocks
    .map(
      (b) => `
    <span class="badge muted me-1 mb-1">${esc(b.keyword)}
      <a href="#" class="link-light" role="button" data-del="${esc(b.id)}" data-kw="${esc(b.keyword)}" aria-label="移除屏蔽词 ${esc(b.keyword)}">×</a></span>`,
    )
    .join('')
  showDialog(`
    <h2>屏蔽词</h2><div>${rows}</div>
    <div class="input-group mt-3">
      <label class="sr-only" for="kw">新增屏蔽词</label>
      <input class="field" id="kw" placeholder="新增屏蔽词" aria-describedby="kw-msg">
      <button class="btn primary" id="add">添加</button>
    </div>
    <div class="field-error" id="kw-msg" role="alert"></div>`)
  document.querySelectorAll('#dlg [data-del]').forEach((a) => {
    a.onclick = async (e) => {
      e.preventDefault()
      if (!confirm(`移除屏蔽词「${a.dataset.kw}」？`)) return
      const res = await run(a, () => api(`/api/news/blocks/${a.dataset.del}`, { method: 'DELETE' }))
      if (!res.ok) return
      await rerender(render, main)
      showBlocks(main)
      toast('已移除屏蔽词')
    }
  })
  const kwEl = document.getElementById('kw')
  const kwMsg = document.getElementById('kw-msg')
  kwEl.addEventListener('input', () => {
    kwMsg.textContent = ''
    kwEl.removeAttribute('aria-invalid')
  })
  document.getElementById('add').onclick = async () => {
    const btn = document.getElementById('add')
    const kw = kwEl.value.trim()
    if (!kw) {
      kwMsg.textContent = '屏蔽词不能为空'
      kwEl.setAttribute('aria-invalid', 'true')
      kwEl.focus()
      return
    }
    kwMsg.textContent = ''
    const res = await run(btn, () => api('/api/news/blocks', { method: 'POST', body: JSON.stringify({ keyword: kw }) }))
    if (!res.ok) return
    await rerender(render, main)
    showBlocks(main)
    toast('已添加屏蔽词')
  }
}

export function destroy() {
  observer?.disconnect()
  observer = null
}
