import { api, esc, icon, loadScriptOnce, rerender, rerenderKeepingFocus, run, scrollToTop, showDialog, toast } from '../lib.js'
import { emptyState } from '../ui.js'

const PAGE_SIZE = 30
let page = 1
let onlyUnread = false
let unreadCount = 0
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
    api(`/api/news/items?page=${page}${onlyUnread ? '&unread=1' : ''}`),
    api('/api/news/blocks'),
    api('/api/news/sources'),
  ])
  blocks = blockData.blocks
  sources = sourceData.sources
  sourceIdx = Object.fromEntries(sources.map((s) => [s.id, s.name]))
  unreadCount = Number(itemData.unread ?? 0)
  const visible = itemData.items.filter((i) => !matchBlocks(i))

  main.innerHTML = `
    <div class="page-head">
      <div>
        <h1 class="page-title">资讯</h1>
        <p class="page-sub">共 ${esc(itemData.total)} 条 · <span id="unread-count">未读 ${unreadCount}</span> · 正文在浏览器端消毒后展示</p>
      </div>
      <div class="page-actions">
        <button class="btn sm" id="btn-unread" data-focus-key="unread" aria-pressed="${onlyUnread}">${onlyUnread ? '显示全部' : '只看未读'}</button>
        <button class="btn sm" id="btn-sources">${icon('news')}订阅源</button>
        <button class="btn sm" id="btn-blocks">${icon('close')}屏蔽词</button>
      </div>
    </div>
    <div class="list" id="items">
      ${
        visible
          .map(
            (i) => `
        <div class="news-item${i.readFlag ? ' is-read' : ''}">
          <div class="flex between center">
            <div class="flex center flex-grow-1 news-line">
              <span class="news-dot" aria-hidden="true"></span>
              <a class="news-title" href="${esc(i.link || '#')}" target="_blank" rel="noopener"
                 data-open="${esc(i.id)}">${esc(i.title || '(无标题)')}</a>
            </div>
            <small class="muted nowrap ms-3">${i.publishedAt ? new Date(i.publishedAt).toLocaleDateString() : ''}</small>
          </div>
          <div class="flex between center mt-1">
            <small class="muted">${esc(sourceName(i.sourceId))}${i.author ? ' · ' + esc(i.author) : ''}</small>
            <button class="link-btn" type="button" data-toggle="${esc(i.id)}" data-read="${i.readFlag ? '1' : ''}">
              ${i.readFlag ? '标为未读' : '标为已读'}
            </button>
          </div>
          <div class="small item-preview mt-1" data-id="${esc(i.id)}"></div>
        </div>`,
          )
          .join('') || emptyState(onlyUnread ? '没有未读资讯' : '暂无内容（等待抓取任务执行）')
      }
    </div>
    <nav class="mt-3 flex center">
      <button class="btn sm" id="prev" data-focus-key="prev" ${page <= 1 ? 'disabled' : ''}>上一页</button>
      <span class="small muted">第 ${page} 页</span>
      <button class="btn sm" id="next" data-focus-key="next" ${page * PAGE_SIZE >= itemData.total ? 'disabled' : ''}>下一页</button>
    </nav>`

  // 正文预览：原文已在列表返回，浏览器端 DOMPurify 消毒后注入
  main.querySelectorAll('.item-preview').forEach((el) => {
    const it = itemData.items.find((x) => String(x.id) === el.dataset.id)
    el.innerHTML = sanitize(it?.preview || '')
  })

  // 翻页后回顶：否则列表重新渲染时用户还停在上一页的底部
  const go = async (delta) => {
    page += delta
    await rerenderKeepingFocus(render, main)
    scrollToTop()
  }
  main.querySelector('#prev').onclick = () => go(-1)
  main.querySelector('#next').onclick = () => go(1)
  main.querySelector('#btn-unread').onclick = async () => {
    onlyUnread = !onlyUnread
    page = 1
    await rerenderKeepingFocus(render, main)
    scrollToTop()
  }
  main.querySelector('#btn-sources').onclick = () => showSources(main)
  main.querySelector('#btn-blocks').onclick = () => showBlocks(main)

  // 点标题打开原文时顺带标记已读（失败不影响跳转）
  main.querySelectorAll('[data-open]').forEach((a) => {
    a.onclick = () => {
      if (a.closest('.news-item')?.classList.contains('is-read')) return
      setRead(main, a.dataset.open, true)
    }
  })
  // 手动切换已读/未读
  main.querySelectorAll('[data-toggle]').forEach((btn) => {
    btn.onclick = async () => {
      const read = btn.dataset.read !== '1'
      if ((await setRead(main, btn.dataset.toggle, read)) && onlyUnread && read) {
        await rerender(render, main)
      }
    }
  })
}

/** 写已读状态 + 本地乐观更新（圆点 / 按钮 / 未读数），失败由 run 统一 toast */
async function setRead(main, id, read) {
  const res = await run(null, () =>
    api(`/api/news/${read ? 'read' : 'unread'}`, { method: 'POST', body: JSON.stringify({ ids: [Number(id)] }) }),
  )
  if (!res.ok) return false

  unreadCount = Math.max(0, unreadCount + (read ? -1 : 1))
  const row = main.querySelector(`.news-item [data-toggle="${id}"]`)?.closest('.news-item')
  if (row) {
    row.classList.toggle('is-read', read)
    const btn = row.querySelector('[data-toggle]')
    if (btn) {
      btn.dataset.read = read ? '1' : ''
      btn.textContent = read ? '标为未读' : '标为已读'
    }
  }
  const counter = main.querySelector('#unread-count')
  if (counter) counter.textContent = `未读 ${unreadCount}`
  return true
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
  showDialog(`<h2>订阅源</h2>${rows}`)
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

export function destroy() {}
