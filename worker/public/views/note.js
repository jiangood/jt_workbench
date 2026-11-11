import { api, esc, icon } from '../lib.js'

let currentId = null

export async function render(main) {
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
    <div class="row">
      <div><div class="list" id="notes"></div></div>
      <div id="editor"></div>
    </div>`

  main.querySelector('#new').onclick = () => openEditor(main, null)
  currentId = null
  await refreshList(main)
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
      list.querySelectorAll('[data-id]').forEach((x) => x.classList.remove('active'))
      a.classList.add('active')
      currentId = a.dataset.id
      openEditor(main, (await api(`/api/note/${a.dataset.id}`)).note)
    }
  })
}

function renderAttaches(n) {
  if (!n) return ''
  return JSON.parse(n.attachments || '[]')
    .map(
      (a, i) => `
    <a class="badge" href="/api/note/attach/${esc(n.id)}/${i}">${icon('note', 14)}${esc(a.filename)} (${(a.size / 1024).toFixed(0)}KB)</a>`,
    )
    .join(' ')
}

function openEditor(main, n) {
  currentId = n?.id ?? null
  const editor = main.querySelector('#editor')
  editor.innerHTML = `
    <input class="field mb-2" id="e-title" placeholder="标题" value="${esc(n?.title ?? '')}">
    <textarea class="field mb-2" id="e-content" rows="14" placeholder="正文（原文存储，展示即所见）">${esc(n?.content ?? '')}</textarea>
    <div class="flex between">
      <div class="flex">
        <label class="btn sm mb-0">
          ${icon('upload')}附件
          <input type="file" id="e-file" multiple hidden>
        </label>
        <button class="btn sm danger" id="e-del" ${n ? '' : 'disabled'}>${icon('trash')}删除</button>
      </div>
      <button class="btn primary sm" id="e-save">保存</button>
    </div>
    <div class="mt-2" id="e-attaches">${renderAttaches(n)}</div>`

  editor.querySelector('#e-save').onclick = async () => {
    const body = JSON.stringify({
      id: n?.id,
      title: editor.querySelector('#e-title').value.trim(),
      content: editor.querySelector('#e-content').value,
    })
    const saved = await api('/api/note/save', { method: 'POST', body })
    await refreshList(main)
    openEditor(main, (await api(`/api/note/${saved.id}`)).note)
  }

  editor.querySelector('#e-file').onchange = async (e) => {
    if (!n) {
      alert('先保存笔记再传附件')
      return
    }
    for (const file of e.target.files) {
      await fetch(`/api/note/attach?noteId=${n.id}&filename=${encodeURIComponent(file.name)}`, {
        method: 'POST',
        headers: { 'content-type': file.type },
        body: file,
      })
    }
    openEditor(main, (await api(`/api/note/${n.id}`)).note)
  }

  editor.querySelector('#e-del').onclick = async () => {
    if (!n || !confirm('删除笔记及附件？')) return
    await api(`/api/note/${n.id}`, { method: 'DELETE' })
    currentId = null
    editor.innerHTML = ''
    await refreshList(main)
  }
}

export function destroy() {}
