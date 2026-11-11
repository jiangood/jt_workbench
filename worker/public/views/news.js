import { api, esc, icon, loadScriptOnce, showDialog } from '../lib.js'

const PAGE_SIZE = 30
let page = 1
let blocks = []
let sources = []
let sourceIdx = {}

/** 正文消毒在浏览器端（原文入库，v3 决策 #9） */
function sanitize(html) {
  return html ? window.DOMPurify.sanitize(html) : ''
}

function sourceName(id) {
  return sourceIdx[id] || id
}

function matchBlocks(item) {
  const text = `${item.title || ''} ${item.author || ''}`
  return blocks.some((b) => {
    if (!b.enabled) return false
    if (b.sourceId && b.sourceId !== item.sourceId) return false
    return text.toLowerCase().includes(b.keyword.toLowerCase())
  })
}

export async function render(main) {
  await loadScriptOnce('/vendor/purify.min.js')

  const [itemData, blockData, sourceData] = await Promise.all([
    api(`/api/news/items?page=${page}`),
    api('/api/news/blocks'),
    api('/api/news/sources'),
  ])
  blocks = blockData.blocks
  sources = sourceData.sources
  sourceIdx = Object.fromEntries(sources.map((s) => [s.id, s.name]))
  const visible = itemData.items.filter((i) => !matchBlocks(i))

  main.innerHTML = `
    <div class="page-head">
      <div>
        <h1 class="page-title">IT 资讯</h1>
        <p class="page-sub">共 ${esc(itemData.total)} 条 · 正文在浏览器端消毒后展示</p>
      </div>
      <div class="page-actions">
        <button class="btn sm" id="btn-sources">${icon('news')}订阅源</button>
        <button class="btn sm" id="btn-blocks">${icon('close')}屏蔽词</button>
      </div>
    </div>
    <div class="list" id="items">
      ${
        visible
          .map(
            (i) => `
        <a href="${esc(i.link || '#')}" target="_blank" rel="noopener">
          <div class="flex between">
            <div>${esc(i.title || '(无标题)')}</div>
            <small class="muted nowrap ms-3">${i.publishedAt ? new Date(i.publishedAt).toLocaleDateString() : ''}</small>
          </div>
          <small class="muted">${esc(sourceName(i.sourceId))}${i.author ? ' · ' + esc(i.author) : ''}</small>
          <div class="small item-preview mt-1" data-id="${esc(i.id)}"></div>
        </a>`,
          )
          .join('') || '<div class="empty">暂无内容（等待抓取任务执行）</div>'
      }
    </div>
    <nav class="mt-3 flex center">
      <button class="btn sm" id="prev" ${page <= 1 ? 'disabled' : ''}>上一页</button>
      <span class="small muted">第 ${page} 页</span>
      <button class="btn sm" id="next" ${page * PAGE_SIZE >= itemData.total ? 'disabled' : ''}>下一页</button>
    </nav>`

  // 正文预览：原文已在列表返回，浏览器端 DOMPurify 消毒后注入
  main.querySelectorAll('.item-preview').forEach((el) => {
    const it = itemData.items.find((x) => String(x.id) === el.dataset.id)
    el.innerHTML = sanitize(it?.preview || '')
  })

  main.querySelector('#prev').onclick = () => {
    page--
    render(main)
  }
  main.querySelector('#next').onclick = () => {
    page++
    render(main)
  }
  main.querySelector('#btn-sources').onclick = () => showSources(main)
  main.querySelector('#btn-blocks').onclick = () => showBlocks(main)
}

function showSources(main) {
  const rows = sources
    .map(
      (s) => `
    <div class="flex between center bb">
      <div>
        <strong>${esc(s.name)}</strong> <span class="muted small">${esc(s.itemCount)} 条</span>
        <div class="small muted truncate" style="max-width: 380px">${esc(s.url)}</div>
      </div>
      <div><input type="checkbox" ${s.enabled ? 'checked' : ''} data-id="${esc(s.id)}"></div>
    </div>`,
    )
    .join('')
  showDialog(`<h5>订阅源</h5>${rows}`)
  document.querySelectorAll('#dlg input[type=checkbox]').forEach((cb) => {
    cb.onchange = async () => {
      await api(`/api/news/sources/${cb.dataset.id}`, { method: 'PUT', body: JSON.stringify({ enabled: cb.checked }) })
      await render(main)
    }
  })
}

function showBlocks(main) {
  const rows = blocks
    .map(
      (b) => `
    <span class="badge muted me-1 mb-1">${esc(b.keyword)}
      <a href="#" class="link-light" data-del="${esc(b.id)}">×</a></span>`,
    )
    .join('')
  showDialog(`
    <h5>屏蔽词</h5><div>${rows}</div>
    <div class="input-group mt-3">
      <input class="field" id="kw" placeholder="新增屏蔽词">
      <button class="btn primary" id="add">添加</button>
    </div>`)
  document.querySelectorAll('#dlg [data-del]').forEach((a) => {
    a.onclick = async (e) => {
      e.preventDefault()
      await api(`/api/news/blocks/${a.dataset.del}`, { method: 'DELETE' })
      await render(main)
      showBlocks(main)
    }
  })
  document.getElementById('add').onclick = async () => {
    const kw = document.getElementById('kw').value.trim()
    if (!kw) return
    await api('/api/news/blocks', { method: 'POST', body: JSON.stringify({ keyword: kw }) })
    await render(main)
    showBlocks(main)
  }
}

export function destroy() {}
