import { api, esc, icon, rerender, run, toast } from '../lib.js'

let currentId = null

export async function render(main, params = {}) {
  main.innerHTML = `
    <div class="page-head">
      <div>
        <h1 class="page-title">笔记</h1>
        <p class="page-sub">原文存储，附件随笔记归档到 R2</p>
      </div>
      <div class="page-actions">
        <button class="btn sm primary" id="new">${icon('plus')}新建</button>
      </div>
    </div>
    <div class="note-split">
      <div class="note-list"><div class="list" id="notes"></div></div>
      <div class="note-editor" id="editor"></div>
    </div>`

  main.querySelector('#new').onclick = () => openEditor(main, null)
  // 支持首页直达 #/note?id=N：先按 id 选中，列表高亮与编辑器同步
  const targetId = Number(params.id)
  currentId = Number.isFinite(targetId) && targetId > 0 ? targetId : null
  emptyEditor(main.querySelector('#editor'))
  await refreshList(main)

  if (currentId) {
    const loaded = await run(null, () => api(`/api/note/${currentId}`))
    if (loaded.ok && loaded.data?.note) openEditor(main, loaded.data.note)
  }
}

async function refreshList(main) {
  const data = await api('/api/note/list')
  const list = main.querySelector('#notes')
  list.innerHTML =
    data.notes
      .map(
        (n) => `
      <a href="#" data-id="${esc(n.id)}" class="${n.id === currentId ? 'active' : ''}">
        <div>${esc(n.title)}</div>
        <small class="muted">${new Date(n.updatedAt).toLocaleString()} · 附件 ${esc(n.attachmentCount)}</small>
      </a>`,
      )
      .join('') || '<div class="empty">暂无笔记</div>'

  list.querySelectorAll('[data-id]').forEach((a) => {
    a.onclick = async (e) => {
      e.preventDefault()
      const loaded = await run(null, () => api(`/api/note/${a.dataset.id}`))
      if (!loaded.ok) return
      list.querySelectorAll('[data-id]').forEach((x) => x.classList.remove('active'))
      a.classList.add('active')
      currentId = a.dataset.id
      openEditor(main, loaded.data.note)
    }
  })
}

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
  editor.innerHTML = '<div class="empty">选择左侧笔记，或点「新建」</div>'
}

function openEditor(main, n) {
  currentId = n?.id ?? null
  const editor = main.querySelector('#editor')
  editor.innerHTML = `
    <label class="sr-only" for="e-title">标题</label>
    <input class="field mb-2" id="e-title" placeholder="标题" value="${esc(n?.title ?? '')}" aria-describedby="e-msg">
    <label class="sr-only" for="e-content">正文</label>
    <textarea class="field mb-2" id="e-content" rows="14" placeholder="正文（原文存储，展示即所见）">${esc(n?.content ?? '')}</textarea>
    <div class="field-error" id="e-msg" role="alert"></div>
    <div class="flex between">
      <div class="flex">
        <label class="btn sm mb-0">
          ${icon('upload')}附件
          <input class="sr-only" type="file" id="e-file" multiple>
        </label>
        <button class="btn sm danger" id="e-del" ${n ? '' : 'disabled'}>${icon('trash')}删除</button>
      </div>
      <button class="btn primary sm" id="e-save">保存</button>
    </div>
    <div class="mt-2" id="e-attaches">${renderAttaches(n)}</div>`

  const titleEl = editor.querySelector('#e-title')
  const msgEl = editor.querySelector('#e-msg')
  titleEl.addEventListener('input', () => {
    msgEl.textContent = ''
    titleEl.removeAttribute('aria-invalid')
  })

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
    const body = JSON.stringify({
      id: n?.id,
      title,
      content: editor.querySelector('#e-content').value,
    })
    const res = await run(btn, () => api('/api/note/save', { method: 'POST', body }))
    if (!res.ok) return
    toast('已保存')
    await rerender(refreshList, main)
    // 新笔记落库后才有 id，重新载入成「已存在」态；老笔记不重绘编辑器，免得光标跳走
    if (!n) {
      const loaded = await run(null, () => api(`/api/note/${res.data.id}`))
      if (loaded.ok) openEditor(main, loaded.data.note)
    }
  }

  editor.querySelector('#e-file').onchange = async (e) => {
    if (!n) {
      toast('先保存笔记再传附件', true)
      e.target.value = ''
      return
    }
    const files = [...e.target.files]
    let failed = 0
    for (const file of files) {
      try {
        const r = await fetch(`/api/note/attach?noteId=${n.id}&filename=${encodeURIComponent(file.name)}`, {
          method: 'POST',
          headers: { 'content-type': file.type },
          body: file,
        })
        if (!r.ok) throw new Error(`附件上传失败：${file.name}（HTTP ${r.status}）`)
      } catch (err) {
        failed += 1
        toast(err.message, true)
      }
    }
    e.target.value = ''
    if (!failed) toast(`已上传 ${files.length} 个附件`)
    const loaded = await run(null, () => api(`/api/note/${n.id}`))
    if (loaded.ok) openEditor(main, loaded.data.note)
  }

  editor.querySelector('#e-del').onclick = async () => {
    if (!n || !confirm('删除笔记及附件？')) return
    const res = await run(editor.querySelector('#e-del'), () => api(`/api/note/${n.id}`, { method: 'DELETE' }))
    if (!res.ok) return
    toast('已删除')
    currentId = null
    emptyEditor(editor)
    await rerender(refreshList, main)
  }
}

export function destroy() {}
