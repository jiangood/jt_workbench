/** 公共 UI 件：路由骨架 / 空态 / 错误态 / 区块 loading / Tab / 过滤器组
 *  零构建：只导出字符串模板 + 原生 DOM 接线，不引入任何依赖。
 *  约定：Tab（多面板）用 role=tab，过滤器组（单面板换数据）用 aria-pressed —— 两种语义不混用。
 */

import { esc, icon } from './lib.js'

/* ---------------- 路由骨架 ---------------- */

const SKELETON_BODIES = {
  /* 卡片网格：首页 / 书架 */
  cards: () => `<div class="sk-grid" aria-hidden="true">${'<span class="sk-card"></span>'.repeat(8)}</div>`,
  /* 表格：股票 / 音乐 / 知识星球 / 系统 */
  table: () => `<div class="sk-table" aria-hidden="true">${'<span class="sk-tr"></span>'.repeat(6)}</div>`,
  /* 列表：资讯 / 提醒 / 笔记 */
  list: () => `<div class="sk-list" aria-hidden="true">${'<span class="sk-li"></span>'.repeat(5)}</div>`,
  /* 阅读页：整块画布 */
  reader: () => '<div class="sk-reader" aria-hidden="true"></div>',
}

/**
 * 路由级骨架：尺寸只求接近真实布局（不追求行数一致）。
 * 淡入延迟 150ms —— 快接口下骨架根本不会出现，避免"闪一下"。
 */
export function skeleton(kind = 'list') {
  const body = (SKELETON_BODIES[kind] ?? SKELETON_BODIES.list)()
  return `<div class="skeleton" role="status" aria-busy="true" aria-label="正在加载">
    <div class="sk-head" aria-hidden="true">
      <span class="sk-bar" style="width: 180px; height: 22px"></span>
      <span class="sk-bar" style="width: min(420px, 72%)"></span>
    </div>
    ${body}
  </div>`
}

/* ---------------- 空态 / 错误态 / 区块 loading ---------------- */

export function emptyState(text) {
  return `<div class="empty">${esc(text)}</div>`
}

/** 错误态：必须带重试入口，否则用户只能刷新整页 */
export function errorBlock({ message, retry = false, retryLabel = '重试' } = {}) {
  return `<div class="alert danger">${icon('alert')}<span>${esc(message || '出错了')}</span></div>
    ${
      retry
        ? `<p class="mt-3"><button class="btn sm" type="button" data-retry>${icon('refresh', 14)}${esc(retryLabel)}</button></p>`
        : ''
    }`
}

/** 区块 loading：居中 spinner + 文案（阅读页这类整块等待用） */
export function loadingBlock(label = '加载中…') {
  return `<div class="loading" role="status"><span class="spin" aria-hidden="true"></span><span>${esc(label)}</span></div>`
}

/* ---------------- Tab（多面板） ---------------- */

/** tablist 的 HTML；面板用 <section data-pane="id"> 标记，配合 setupTabs() */
export function tablist({ items, active, label = '', idPrefix = 'tab' }) {
  return `<div class="tabs" role="tablist"${label ? ` aria-label="${esc(label)}"` : ''}>
    ${items
      .map(
        (item) => `<button class="tab" id="${idPrefix}-${esc(item.id)}" type="button" role="tab"
          data-tab="${esc(item.id)}" aria-controls="pane-${esc(item.id)}"
          aria-selected="${item.id === active}" tabindex="${item.id === active ? '0' : '-1'}">${esc(item.label)}</button>`,
      )
      .join('')}
  </div>`
}

/**
 * 接上 tablist + [data-pane]：点击 / ←→ / Home / End 切换，
 * aria-selected + roving tabindex，panes 用 hidden 开关。
 * urlKey 给定时把当前 tab 同步进 hash 查询串（replaceState，不触发 hashchange）。
 * 返回 teardown。
 */
export function setupTabs(root, { active, urlKey, defaultId, onChange, onShow } = {}) {
  const list = root.querySelector('[role="tablist"]')
  if (!list) return () => {}
  const tabs = [...list.querySelectorAll('[role="tab"]')]
  if (!tabs.length) return () => {}
  const panes = [...root.querySelectorAll('[data-pane]')]
  const first = tabs.some((t) => t.dataset.tab === defaultId) ? defaultId : tabs[0].dataset.tab
  const initial = tabs.some((t) => t.dataset.tab === active) ? active : first
  const shown = new Set()

  const show = (id, focus = false) => {
    if (!tabs.some((t) => t.dataset.tab === id)) return
    for (const tab of tabs) {
      const on = tab.dataset.tab === id
      tab.setAttribute('aria-selected', String(on))
      tab.tabIndex = on ? 0 : -1
      if (on && focus) tab.focus()
    }
    for (const pane of panes) pane.hidden = pane.dataset.pane !== id

    if (urlKey) {
      const [path, query = ''] = (location.hash.replace(/^#/, '') || '/').split('?')
      const params = new URLSearchParams(query)
      if (id === first) params.delete(urlKey)
      else params.set(urlKey, id)
      const qs = params.toString()
      history.replaceState(null, '', `#${path}${qs ? `?${qs}` : ''}`)
    }

    if (!shown.has(id)) {
      shown.add(id)
      onShow?.(id)
    }
    onChange?.(id)
  }

  const onClick = (e) => {
    const tab = e.target.closest('[role="tab"]')
    if (tab && list.contains(tab) && tab.dataset.tab) show(tab.dataset.tab)
  }
  // 方向键 / Home / End 在 tab 间移动（WAI-ARIA tabs 模式）
  const onKeyDown = (e) => {
    const i = tabs.indexOf(document.activeElement)
    if (i < 0) return
    let next
    if (e.key === 'ArrowRight') next = (i + 1) % tabs.length
    else if (e.key === 'ArrowLeft') next = (i - 1 + tabs.length) % tabs.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = tabs.length - 1
    else return
    e.preventDefault()
    show(tabs[next].dataset.tab, true)
  }

  list.addEventListener('click', onClick)
  list.addEventListener('keydown', onKeyDown)
  show(initial)

  return () => {
    list.removeEventListener('click', onClick)
    list.removeEventListener('keydown', onKeyDown)
  }
}

/* ---------------- 过滤器组（单面板换数据） ---------------- */

/**
 * toggle 按钮组：语义是 aria-pressed，不是 role=tab（筛选没有对应的 tabpanel）。
 * variant='segmented' → .tabs/.tab（分段控件）；'chips' → .category-chips/.pill。
 * 每个按钮带 data-focus-key，配合 lib.js 的 rerenderKeepingFocus() 保住焦点。
 */
export function filterGroup({ name, items, active, label = '', variant = 'segmented' }) {
  const chips = variant === 'chips'
  return `<div class="${chips ? 'category-chips' : 'tabs'}" role="group" data-filter-group="${esc(name)}"${
    label ? ` aria-label="${esc(label)}"` : ''
  }>
    ${items
      .map(
        (item) => `<button class="${chips ? 'pill' : 'tab'}" type="button" data-filter-value="${esc(item.value)}"
          data-focus-key="${esc(name)}:${esc(item.value)}" aria-pressed="${item.value === active}">${esc(item.label)}${
            item.count != null ? `<span class="tab-count">${esc(item.count)}</span>` : ''
          }</button>`,
      )
      .join('')}
  </div>`
}

/** 接上 filterGroup：监听挂在组容器上，随重绘自然回收（不会在 main 上堆叠监听） */
export function setupFilter(groupEl, onChange) {
  if (!groupEl) return () => {}
  const onClick = (e) => {
    const btn = e.target.closest('[data-filter-value]')
    if (btn && groupEl.contains(btn)) onChange(btn.dataset.filterValue, btn)
  }
  groupEl.addEventListener('click', onClick)
  return () => groupEl.removeEventListener('click', onClick)
}
