import { api, closeMoreMenu, esc, icon, moreMenu, rerender, run, setupMoreMenus, showDialog, toast } from '../lib.js'
import { enqueue } from '../upload.js'

let currentId = null
/** 视图是否还是当前页：切页后附件上传完成别再刷旧视图 */
let alive = true
/** 当前选中的目录：'all' | 'none'（未分类）| 数字字符串 */
let selectedFolder = 'all'
/** 展开的目录 id（刷新后保留） */
const expanded = new Set()

let foldersCache = []
let notesCache = []
let childrenByParent = new Map()
let folderById = new Map()

/** 全库搜索态：非空时列表只显示后端返回的命中结果，不受目录筛选影响 */
let searchQuery = ''
let searchResults = []
/** 请求序号：连续输入时只认最后一次请求，避免旧结果覆盖新结果 */
let searchSeq = 0
let searchTimer = 0

export async function render(main, params = {}) {
  alive = true
  searchQuery = ''
  searchResults = []
  searchSeq += 1
  clearTimeout(searchTimer)
  main.innerHTML = `
    <div class="page-head">
      <div>
        <h1 class="page-title">笔记</h1>
        <p class="page-sub">原文存储，按目录归档，附件随笔记存到 R2</p>
      </div>
      <div class="page-actions">
        <button class="btn sm primary" id="new">${icon('plus')}新建</button>
      </div>
    </div>
    <div class="note-split">
      <aside class="note-pane note-pane-folders" aria-label="笔记目录">
        <div class="note-folder-head">
          <span>目录</span>
          <button class="link-btn" id="folder-manage" type="button" aria-label="管理目录">管理</button>
        </div>
        <div id="folder-tree" role="tree" aria-label="笔记目录"></div>
      </aside>
      <section class="note-pane note-pane-list" aria-label="笔记列表">
        <div class="note-search">
          <label class="sr-only" for="note-search">搜索笔记</label>
          <input class="field field-sm" id="note-search" type="search" placeholder="搜索标题或正文…" autocomplete="off">
        </div>
        <div class="list" id="notes"></div>
      </section>
      <div class="note-pane note-pane-editor" id="editor"></div>
    </div>`

  main.querySelector('#new').onclick = () => openEditor(main, null)
  main.querySelector('#folder-manage').onclick = () => openFolderManager(main)
  bindFolderTree(main)
  bindSearch(main)

  // 支持首页直达 #/note?id=N：先按 id 选中，列表高亮与编辑器同步
  const targetId = Number(params.id)
  currentId = Number.isFinite(targetId) && targetId > 0 ? targetId : null
  emptyEditor(main.querySelector('#editor'))
  await refreshAll(main)

  if (currentId) {
    const loaded = await run(null, () => api(`/api/note/${currentId}`))
    if (loaded.ok && loaded.data?.note) {
      const n = loaded.data.note
      // 直达笔记时把目录切到它所在的位置，列表不显得「莫名其妙」
      if (n.folder_id != null) {
        selectedFolder = String(n.folder_id)
        expandAncestors(n.folder_id)
      }
      openEditor(main, n)
      renderFolders(main)
      renderNotes(main)
    }
  }
}

// ---------------- 目录树 ----------------

async function refreshAll(main) {
  const [folderData, noteData] = await Promise.all([api('/api/note/folders'), api('/api/note/list')])
  foldersCache = folderData.folders ?? []
  notesCache = noteData.notes ?? []
  indexFolders()
  // 目录可能已被别处删掉：选中项失效时退回「全部」
  if (/^\d+$/.test(selectedFolder) && !folderById.has(Number(selectedFolder))) selectedFolder = 'all'
  renderFolders(main)
  // 搜索态下刷新：重新查一次，避免删/改之后结果列表过期
  if (searchQuery) await runSearch(main, searchQuery)
  else renderNotes(main)
}

// ---------------- 搜索（全库，与目录筛选互斥） ----------------

function bindSearch(main) {
  const input = main.querySelector('#note-search')
  if (!input) return

  input.addEventListener('input', () => {
    clearTimeout(searchTimer)
    const q = input.value.trim()
    if (!q) {
      clearSearch(main)
      return
    }
    // 输入防抖：连续敲字只发最后一次请求
    searchTimer = setTimeout(() => runSearch(main, q), 250)
  })

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && input.value.trim()) {
      e.preventDefault()
      clearTimeout(searchTimer)
      runSearch(main, input.value.trim())
    } else if (e.key === 'Escape' && input.value) {
      e.preventDefault()
      input.value = ''
      clearSearch(main)
    }
  })

  // type=search 的原生清除「×」只触发 search 事件
  input.addEventListener('search', () => {
    if (!input.value.trim()) clearSearch(main)
  })
}

async function runSearch(main, q) {
  const seq = ++searchSeq
  const res = await run(null, () => api(`/api/note/list?q=${encodeURIComponent(q)}`))
  if (seq !== searchSeq) return
  if (!res.ok) return
  searchQuery = q
  searchResults = res.data.notes ?? []
  renderFolders(main)
  renderNotes(main)
}

function clearSearch(main) {
  clearTimeout(searchTimer)
  searchSeq += 1
  if (!searchQuery) return
  searchQuery = ''
  searchResults = []
  renderFolders(main)
  renderNotes(main)
}

function indexFolders() {
  childrenByParent = new Map()
  folderById = new Map(foldersCache.map((f) => [f.id, f]))
  for (const f of foldersCache) {
    const parent = f.parentId ?? null
    if (!childrenByParent.has(parent)) childrenByParent.set(parent, [])
    childrenByParent.get(parent).push(f)
  }
}

function folderCounts() {
  const direct = new Map()
  let uncategorized = 0
  for (const n of notesCache) {
    if (n.folderId == null) uncategorized += 1
    else direct.set(n.folderId, (direct.get(n.folderId) ?? 0) + 1)
  }
  const memo = new Map()
  const total = (id) => {
    if (memo.has(id)) return memo.get(id)
    let count = direct.get(id) ?? 0
    for (const child of childrenByParent.get(id) ?? []) count += total(child.id)
    memo.set(id, count)
    return count
  }
  return { total, uncategorized }
}

function renderFolders(main, focusKey = null) {
  const host = main.querySelector('#folder-tree')
  const { total, uncategorized } = folderCounts()
  const rows = [
    folderRow({
      key: 'all',
      name: '全部笔记',
      count: notesCache.length,
      depth: 0,
    }),
  ]

  const walk = (parent, depth) => {
    for (const f of childrenByParent.get(parent) ?? []) {
      const kids = childrenByParent.get(f.id) ?? []
      const open = expanded.has(f.id)
      rows.push(folderRow({ key: String(f.id), name: f.name, count: total(f.id), depth, folder: f, open, hasKids: kids.length > 0 }))
      if (open) walk(f.id, depth + 1)
    }
  }
  walk(null, 1)

  if (uncategorized > 0) {
    rows.push(folderRow({ key: 'none', name: '未分类', count: uncategorized, depth: 1 }))
  }

  host.innerHTML = rows.join('')
  host.querySelectorAll('.tree-row').forEach((row) => {
    // 全库搜索时列表不归属任何目录，树行不再高亮，免得误以为只在当前目录里搜
    row.classList.toggle('active', !searchQuery && row.dataset.key === selectedFolder)
  })

  // 键盘展开/收起后焦点别丢：回到同一个目录行
  if (focusKey != null) host.querySelector(`.tree-row[data-key="${focusKey}"]`)?.focus()
}

function folderRow({ key, name, count, depth, folder = null, open = false, hasKids = false }) {
  const toggle = hasKids
    ? `<button class="tree-toggle" type="button" tabindex="-1" data-toggle="${esc(folder.id)}" aria-label="${open ? '收起' : '展开'}「${esc(name)}」">${icon('chevron', 14, open ? 'is-open' : '')}</button>`
    : '<span class="tree-toggle" aria-hidden="true"></span>'
  return `<div class="tree-row" role="treeitem" tabindex="0" data-key="${esc(key)}" style="--depth:${depth}"${
    folder ? ` aria-expanded="${open}"` : ''
  }>
    ${toggle}
    <span class="tree-name">${esc(name)}</span>
    <span class="tree-count muted">${esc(count)}</span>
  </div>`
}

function bindFolderTree(main) {
  const tree = main.querySelector('#folder-tree')

  tree.onclick = (e) => {
    const toggle = e.target.closest('[data-toggle]')
    if (toggle) {
      e.stopPropagation()
      const id = Number(toggle.dataset.toggle)
      if (expanded.has(id)) expanded.delete(id)
      else expanded.add(id)
      renderFolders(main, String(id))
      return
    }
    const row = e.target.closest('.tree-row')
    if (row) selectFolder(main, row.dataset.key)
  }

  // 键盘可用：Enter/空格选中，← → 收起/展开
  tree.onkeydown = (e) => {
    const row = e.target
    if (!row || !row.classList?.contains('tree-row')) return
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      selectFolder(main, row.dataset.key)
      return
    }
    const folder = /^\d+$/.test(row.dataset.key) ? folderById.get(Number(row.dataset.key)) : null
    if (!folder) return
    const kids = childrenByParent.get(folder.id) ?? []
    if (!kids.length) return
    if (e.key === 'ArrowRight' && !expanded.has(folder.id)) {
      e.preventDefault()
      expanded.add(folder.id)
      renderFolders(main, row.dataset.key)
    } else if (e.key === 'ArrowLeft' && expanded.has(folder.id)) {
      e.preventDefault()
      expanded.delete(folder.id)
      renderFolders(main, row.dataset.key)
    }
  }
}

function expandAncestors(folderId) {
  let cur = folderById.get(Number(folderId))?.parentId ?? null
  while (cur != null) {
    expanded.add(cur)
    cur = folderById.get(cur)?.parentId ?? null
  }
}

function selectFolder(main, key) {
  // 点目录 = 退出全库搜索，回到按目录浏览（输入框同步清空）
  const wasSearching = searchQuery !== ''
  if (wasSearching) {
    clearTimeout(searchTimer)
    searchSeq += 1
    searchQuery = ''
    searchResults = []
    const input = main.querySelector('#note-search')
    if (input) input.value = ''
  }
  if (selectedFolder === key && !wasSearching) return
  selectedFolder = key
  if (/^\d+$/.test(key)) expandAncestors(Number(key))
  renderFolders(main, key)
  renderNotes(main)
}

function visibleNotes() {
  if (selectedFolder === 'all') return notesCache
  if (selectedFolder === 'none') return notesCache.filter((n) => n.folderId == null)
  const scope = new Set()
  const collect = (id) => {
    scope.add(id)
    for (const child of childrenByParent.get(id) ?? []) collect(child.id)
  }
  collect(Number(selectedFolder))
  return notesCache.filter((n) => n.folderId != null && scope.has(n.folderId))
}

function renderNotes(main) {
  const list = main.querySelector('#notes')
  const searching = searchQuery !== ''
  const notes = searching ? searchResults : visibleNotes()

  const rows = notes.map((n) => {
    // 搜索结果里补一行正文摘要，命中上下文一眼能看见
    const preview = searching && n.preview ? `<small class="item-preview">${highlight(n.preview, searchQuery)}</small>` : ''
    return `
      <a href="#" data-id="${esc(n.id)}" class="${Number(n.id) === currentId ? 'active' : ''}">
        <div>${searching ? highlight(n.title, searchQuery) : esc(n.title)}</div>
        ${preview}
        <small class="muted">${new Date(n.updatedAt).toLocaleString()} · 附件 ${esc(n.attachmentCount)}</small>
      </a>`
  })

  if (searching) rows.unshift(`<div class="note-search-meta muted" role="status">全库搜索「${esc(searchQuery)}」· ${notes.length} 条</div>`)
  // 空目录不提示（目录刚建、还没放笔记时保持干净）；全库为空或搜索无结果才给说明
  const empty = searching
    ? `<div class="empty">没有匹配「${esc(searchQuery)}」的笔记</div>`
    : selectedFolder === 'all'
      ? '<div class="empty">暂无笔记</div>'
      : ''
  list.innerHTML = rows.join('') || empty

  list.querySelectorAll('[data-id]').forEach((a) => {
    a.onclick = async (e) => {
      e.preventDefault()
      const loaded = await run(null, () => api(`/api/note/${a.dataset.id}`))
      if (!loaded.ok) return
      list.querySelectorAll('[data-id]').forEach((x) => x.classList.remove('active'))
      a.classList.add('active')
      currentId = Number(a.dataset.id)
      openEditor(main, loaded.data.note)
    }
  })
}

/** 命中片段包 <mark>：逐段转义拼接，不对已转义文本做二次匹配 */
function highlight(text, q) {
  const src = String(text ?? '')
  if (!q) return esc(src)
  const lower = src.toLowerCase()
  const needle = q.toLowerCase()
  let out = ''
  let from = 0
  for (;;) {
    const i = lower.indexOf(needle, from)
    if (i < 0) break
    out += esc(src.slice(from, i)) + `<mark>${esc(src.slice(i, i + needle.length))}</mark>`
    from = i + needle.length
  }
  return out + esc(src.slice(from))
}

// ---------------- 目录管理（弹窗） ----------------

/**
 * 目录的新建 / 重命名 / 删除 / 建子目录全部收进弹窗，左侧树只负责筛选。
 * 删除带 confirm，且只删目录本身（笔记与子目录上移），避免误操作丢数据。
 */
function openFolderManager(main) {
  const { close, body } = showDialog(
    `<h2>管理目录</h2>
     <form class="input-group mb-3" id="mf-create" novalidate>
       <label class="sr-only" for="mf-name">新目录名称</label>
       <input class="field field-sm" id="mf-name" maxlength="60" placeholder="新目录名称（建在根目录）" autocomplete="off">
       <button class="btn sm primary" type="submit">新建</button>
     </form>
     <div class="folder-admin" id="mf-list"></div>
     <div class="flex between mt-3 folder-admin-foot">
       <p class="muted note-folder-hint">删除目录只删目录本身，里面的笔记和子目录会移到上级目录</p>
       <button class="btn sm" type="button" id="mf-done">完成</button>
     </div>`,
    { label: '管理目录' },
  )

  /** 编辑态：{ mode:'create'|'rename', id?, parentId? } */
  let edit = null
  const list = body.querySelector('#mf-list')
  const rootForm = body.querySelector('#mf-create')
  const rootInput = body.querySelector('#mf-name')
  body.querySelector('#mf-done').onclick = close

  const editRowHtml = ({ depth, value = '', id = null, parentId = null }) => `
    <div class="folder-admin-row is-editing" style="--depth:${depth}">
      <label class="sr-only" for="mf-edit">目录名称</label>
      <input class="field field-sm folder-admin-input" id="mf-edit" maxlength="60" autocomplete="off"
             value="${esc(value)}" data-id="${esc(id ?? '')}" data-parent="${esc(parentId ?? '')}">
      <button class="btn sm primary" type="button" data-act="commit">保存</button>
      <button class="btn sm" type="button" data-act="cancel">取消</button>
    </div>`

  const rowHtml = (f, depth, total) => {
    if (edit?.mode === 'rename' && edit.id === f.id) {
      return editRowHtml({ depth, value: f.name, id: f.id, parentId: f.parentId ?? null })
    }
    return `<div class="folder-admin-row" style="--depth:${depth}">
      <span class="tree-name">${esc(f.name)}</span>
      <span class="tree-count muted">${esc(total(f.id))}</span>
      <span class="folder-admin-acts">
        <button class="link-btn" type="button" data-act="add" data-id="${esc(f.id)}">新建子目录</button>
        <button class="link-btn" type="button" data-act="rename" data-id="${esc(f.id)}">重命名</button>
        <button class="link-btn danger" type="button" data-act="del" data-id="${esc(f.id)}">删除</button>
      </span>
    </div>`
  }

  const draw = () => {
    const { total } = folderCounts()
    const rows = []
    const walk = (parent, depth) => {
      for (const f of childrenByParent.get(parent) ?? []) {
        rows.push(rowHtml(f, depth, total))
        if (edit?.mode === 'create' && edit.parentId === f.id) {
          rows.push(editRowHtml({ depth: depth + 1, parentId: f.id }))
        }
        walk(f.id, depth + 1)
      }
    }
    walk(null, 0)
    list.innerHTML = rows.join('') || '<div class="empty">还没有目录</div>'
    const input = list.querySelector('.folder-admin-input')
    if (input) {
      input.focus()
      input.select()
    }
  }

  async function saveFolder(name, id, parentId, btn) {
    const res = await run(btn, () =>
      api('/api/note/folders/save', { method: 'POST', body: JSON.stringify({ id, name, parentId }) }),
    )
    if (!res.ok) return false
    if (!id) {
      selectedFolder = String(res.data.id)
      if (parentId != null) expanded.add(parentId)
    }
    edit = null
    await refreshAll(main)
    syncFolderLabel(main)
    draw()
    toast(id ? '目录已重命名' : '已创建目录')
    return true
  }

  async function commitEdit(btn) {
    const input = list.querySelector('.folder-admin-input')
    if (!input) return
    const name = input.value.trim()
    if (!name) {
      input.setAttribute('aria-invalid', 'true')
      input.focus()
      return
    }
    const id = input.dataset.id ? Number(input.dataset.id) : null
    const parentId = input.dataset.parent ? Number(input.dataset.parent) : null
    await saveFolder(name, id, parentId, btn)
  }

  rootForm.onsubmit = async (e) => {
    e.preventDefault()
    const name = rootInput.value.trim()
    if (!name) {
      rootInput.setAttribute('aria-invalid', 'true')
      rootInput.focus()
      return
    }
    if (await saveFolder(name, null, null, rootForm.querySelector('button[type="submit"]'))) rootInput.value = ''
    rootInput.focus()
  }
  rootInput.addEventListener('input', () => rootInput.removeAttribute('aria-invalid'))

  list.addEventListener('input', (e) => {
    if (e.target.classList?.contains('folder-admin-input')) e.target.removeAttribute('aria-invalid')
  })
  list.addEventListener('keydown', (e) => {
    if (!e.target.classList?.contains('folder-admin-input') || e.key !== 'Enter') return
    e.preventDefault()
    commitEdit(list.querySelector('[data-act="commit"]'))
  })

  list.onclick = async (e) => {
    const btn = e.target.closest('[data-act]')
    if (!btn) return
    const act = btn.dataset.act
    if (act === 'cancel') {
      edit = null
      draw()
      return
    }
    if (act === 'commit') {
      await commitEdit(btn)
      return
    }

    const folder = folderById.get(Number(btn.dataset.id))
    if (!folder) return
    if (act === 'add') {
      edit = { mode: 'create', parentId: folder.id }
      draw()
    } else if (act === 'rename') {
      edit = { mode: 'rename', id: folder.id }
      draw()
    } else if (act === 'del') {
      if (!confirm(`删除目录「${folder.name}」？里面的笔记和子目录会移到上级目录，不会丢失。`)) return
      const res = await run(btn, () => api(`/api/note/folders/${folder.id}`, { method: 'DELETE' }))
      if (!res.ok) return
      if (selectedFolder === String(folder.id)) selectedFolder = folder.parentId != null ? String(folder.parentId) : 'none'
      expanded.delete(folder.id)
      await refreshAll(main)
      syncFolderLabel(main, folder.parentId ?? null)
      draw()
      toast('已删除目录')
    }
  }

  draw()
}

// ---------------- 笔记编辑器 ----------------

function renderAttaches(n) {
  if (!n) return ''
  return attachmentsOf(n)
    .map(
      (a, i) => `
    <a class="badge" href="/api/note/attach/${esc(n.id)}/${i}">${icon('note', 14)}${esc(a.filename)} (${(a.size / 1024).toFixed(0)}KB)</a>`,
    )
    .join(' ')
}

/** 附件列是 TEXT 存 JSON；单条数据坏掉时不该让整个编辑器白屏 */
function attachmentsOf(n) {
  try {
    const list = JSON.parse(n?.attachments || '[]')
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

function emptyEditor(editor) {
  closeMoreMenu()
  editor.innerHTML = '<div class="editor-empty"><div class="empty">从列表里选一篇笔记，或点「新建」</div></div>'
}

/** 目录下拉：按树深度缩进，和左侧目录结构一致 */
function folderOptions(selectedId) {
  const rows = ['<option value="">未分类</option>']
  const walk = (parent, depth) => {
    for (const f of childrenByParent.get(parent) ?? []) {
      rows.push(
        `<option value="${esc(f.id)}"${Number(selectedId) === f.id ? ' selected' : ''}>${'　'.repeat(depth)}${esc(f.name)}</option>`,
      )
      walk(f.id, depth + 1)
    }
  }
  walk(null, 0)
  return rows.join('')
}

/** 目录 id → 完整路径（根 / 子 / 孙）；null 表示未分类。Set 防脏数据成环 */
function folderPathName(id) {
  if (id == null) return '未分类'
  const names = []
  const seen = new Set()
  let cur = folderById.get(Number(id))
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id)
    names.unshift(cur.name)
    cur = cur.parentId != null ? folderById.get(cur.parentId) : null
  }
  return names.join(' / ') || '未分类'
}

/** 第 3 栏的归属只读展示：id 记在 data-folder-id 上，保存 / 移动都读这里 */
function renderFolderLabel(label, id) {
  const folderId = id ?? null
  const name = folderPathName(folderId)
  label.dataset.folderId = folderId != null ? String(folderId) : ''
  label.title = name
  const nameEl = label.querySelector('.editor-folder-name')
  if (nameEl) nameEl.textContent = name
}

/** 目录增删后同步第 3 栏显示：失效的 id 退到 fallback（通常是父目录） */
function syncFolderLabel(main, fallback = null) {
  const label = main.querySelector('#e-folder-label')
  if (!label) return
  const prev = label.dataset.folderId ? Number(label.dataset.folderId) : null
  renderFolderLabel(label, prev != null && folderById.has(prev) ? prev : fallback)
}

function openEditor(main, n) {
  closeMoreMenu()
  currentId = n?.id != null ? Number(n.id) : null
  const editor = main.querySelector('#editor')
  const folderId = n ? n.folder_id : /^\d+$/.test(selectedFolder) ? Number(selectedFolder) : null
  editor.innerHTML = `
    <div class="editor-head">
      <label class="sr-only" for="e-title">标题</label>
      <input class="field" id="e-title" placeholder="标题" value="${esc(n?.title ?? '')}" aria-describedby="e-msg">
      <div class="editor-acts">
        <button class="btn primary sm" id="e-save">保存</button>
        ${moreMenu(
          'note',
          [
            { label: '移动到目录…', icon: 'folder', attrs: { id: 'e-move' } },
            { label: '删除笔记', icon: 'trash', danger: true, disabled: !n, attrs: { id: 'e-del' } },
          ],
          { iconSize: 18 },
        )}
      </div>
    </div>
    <div class="field-error" id="e-msg" role="alert"></div>
    <div class="editor-meta">
      <span class="muted">目录</span>
      <span class="editor-folder" id="e-folder-label" data-folder-id="${folderId ?? ''}" title="${esc(folderPathName(folderId))}">
        ${icon('folder', 14)}<span class="editor-folder-name">${esc(folderPathName(folderId))}</span>
      </span>
    </div>
    <label class="sr-only" for="e-content">正文</label>
    <textarea class="field" id="e-content" rows="14" placeholder="正文（原文存储，展示即所见）">${esc(n?.content ?? '')}</textarea>
    <div class="editor-foot">
      <button class="btn sm mb-0" type="button" id="e-file-btn" ${n ? '' : 'disabled title="先保存笔记再传附件"'}>
        ${icon('upload')}附件
      </button>
      <input class="sr-only" type="file" id="e-file" multiple tabindex="-1" aria-label="选择附件">
      <div class="editor-attaches" id="e-attaches">${renderAttaches(n)}</div>
    </div>`

  const titleEl = editor.querySelector('#e-title')
  const msgEl = editor.querySelector('#e-msg')
  const labelEl = editor.querySelector('#e-folder-label')
  titleEl.addEventListener('input', () => {
    msgEl.textContent = ''
    titleEl.removeAttribute('aria-invalid')
  })

  // 「更多」下拉：删除笔记等破坏性操作收进菜单，点外部 / Esc 自动关
  setupMoreMenus(editor)

  // 「移动到目录」：只改归属，不动正文；未保存的新笔记先记在本地，保存时一起落库
  editor.querySelector('#e-move').onclick = () => {
    const cur = labelEl.dataset.folderId ? Number(labelEl.dataset.folderId) : null
    const { close, body } = showDialog(
      `<h2>移动到目录</h2>
       <p class="muted small">当前：${esc(folderPathName(cur))}</p>
       <label class="form-label" for="mv-folder">目标目录</label>
       <select class="field" id="mv-folder">${folderOptions(cur)}</select>
       <div class="flex between mt-3">
         <button class="btn sm" type="button" id="mv-cancel">取消</button>
         <button class="btn sm primary" type="button" id="mv-ok">移动</button>
       </div>`,
      { label: '移动到目录' },
    )
    const select = body.querySelector('#mv-folder')
    const okBtn = body.querySelector('#mv-ok')
    body.querySelector('#mv-cancel').onclick = close
    okBtn.onclick = async () => {
      const pick = select.value ? Number(select.value) : null
      if (pick === cur) {
        close()
        return
      }
      if (n) {
        const res = await run(okBtn, () =>
          api(`/api/note/${n.id}/move`, { method: 'POST', body: JSON.stringify({ folderId: pick }) }),
        )
        if (!res.ok) return
        n.folder_id = res.data.folderId ?? null
      }
      close()
      renderFolderLabel(labelEl, pick)
      toast(n ? `已移动到「${folderPathName(pick)}」` : `保存后归入「${folderPathName(pick)}」`)
      // 目录计数与列表跟着变；正文不动，免得光标跳走
      if (n) await rerender(refreshAll, main)
    }
    select.focus()
  }

  editor.querySelector('#e-save').onclick = async () => {
    const btn = editor.querySelector('#e-save')
    const title = titleEl.value.trim()
    if (!title) {
      msgEl.textContent = '标题不能为空'
      titleEl.setAttribute('aria-invalid', 'true')
      titleEl.focus()
      return
    }
    msgEl.textContent = ''
    titleEl.removeAttribute('aria-invalid')
    const pick = labelEl.dataset.folderId
    const body = JSON.stringify({
      id: n?.id,
      title,
      content: editor.querySelector('#e-content').value,
      folderId: pick ? Number(pick) : null,
    })
    const res = await run(btn, () => api('/api/note/save', { method: 'POST', body }))
    if (!res.ok) return
    toast('已保存')
    await rerender(refreshAll, main)
    // 新笔记落库后才有 id，重新载入成「已存在」态；老笔记不重绘编辑器，免得光标跳走
    if (!n) {
      const loaded = await run(null, () => api(`/api/note/${res.data.id}`))
      if (loaded.ok) {
        if (loaded.data.note.folder_id != null) {
          selectedFolder = String(loaded.data.note.folder_id)
          expandAncestors(loaded.data.note.folder_id)
        }
        openEditor(main, loaded.data.note)
        renderFolders(main)
        renderNotes(main)
      }
    }
  }

  // 附件走公共上传队列：面板在 shell 里，切页 / 重绘编辑器都不影响已发出的请求
  const fileInput = editor.querySelector('#e-file')
  editor.querySelector('#e-file-btn').onclick = () => fileInput.click()
  fileInput.onchange = (e) => {
    const files = [...e.target.files]
    e.target.value = ''
    if (!files.length) return
    if (!n) {
      toast('先保存笔记再传附件', true)
      return
    }
    enqueue(files, {
      title: '上传附件',
      params: { noteId: n.id },
      url: (qs) => `/api/note/attach?${qs}`,
      contentType: (file) => file.type || 'application/octet-stream',
      onSettled: async (summary) => {
        if (!alive || !summary.ok) return
        await rerender(refreshAll, main)
        const loaded = await run(null, () => api(`/api/note/${n.id}`))
        if (loaded.ok) openEditor(main, loaded.data.note)
      },
    })
  }

  editor.querySelector('#e-del').onclick = async () => {
    const btn = editor.querySelector('#e-del')
    if (!n || !confirm('删除笔记及附件？')) return
    const res = await run(btn, () => api(`/api/note/${n.id}`, { method: 'DELETE' }))
    if (!res.ok) return
    toast('已删除')
    currentId = null
    emptyEditor(editor)
    await rerender(refreshAll, main)
  }
}

export function destroy() {
  alive = false
  closeMoreMenu()
  clearTimeout(searchTimer)
  searchSeq += 1
}
