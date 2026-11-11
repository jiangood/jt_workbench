import { api, esc, icon, loadScriptOnce, showDialog } from '../lib.js'

let book = null
let closeBound = false

function closeReader() {
  try {
    book?.destroy()
  } catch {
    /* 已释放 */
  }
  book = null
}

export async function render(main) {
  await loadScriptOnce('/vendor/jszip.min.js')
  await loadScriptOnce('/vendor/epub.min.js')
  if (!closeBound) {
    document.getElementById('dlg').addEventListener('close', closeReader)
    closeBound = true
  }

  const data = await api('/api/book/list')
  main.innerHTML = `
    <div class="page-head">
      <div>
        <h1 class="page-title">读书</h1>
        <p class="page-sub">epub 元数据由浏览器 JSZip 解析，正文用 epub.js 阅读</p>
      </div>
      <div class="page-actions">
        <label class="btn sm primary">
          ${icon('upload')}上传
          <input type="file" id="up" accept=".epub,.pdf" multiple hidden>
        </label>
      </div>
    </div>
    <div id="up-progress" class="small muted mb-2"></div>
    <div class="row book-grid">
      ${
        data.books
          .map(
            (b) => `
        <div>
          <div class="card h-100">
            <div class="card-body flex flex-column">
              <div class="badge">${esc(b.fmt.toUpperCase())}</div>
              <div class="fw-semibold" style="min-height: 2.6em">${esc(b.title || b.filename)}</div>
              <div class="small muted">${esc(b.author || '未知作者')}</div>
              <div class="mt-auto flex pt-2">
                <a class="btn sm primary" href="#" data-r="${esc(b.id)}" data-fmt="${esc(b.fmt)}" data-title="${esc(b.title || b.filename)}">${icon('book', 14)}阅读</a>
                <a class="btn sm" href="/api/book/read/${esc(b.id)}" target="_blank" rel="noopener">原文件</a>
                <button class="btn sm danger" data-d="${esc(b.id)}" aria-label="删除">${icon('trash', 14)}</button>
              </div>
            </div>
          </div>
        </div>`,
          )
          .join('') || '<div class="empty">书架空空如也</div>'
      }
    </div>`

  main.querySelector('#up').onchange = async (e) => {
    const prog = main.querySelector('#up-progress')
    for (const file of e.target.files) {
      prog.textContent = `解析 ${file.name} ...`
      let meta = {}
      if (file.name.toLowerCase().endsWith('.epub')) {
        try {
          // 浏览器端 JSZip 读 OPF（v3 决策 #9）
          const zip = await window.JSZip.loadAsync(file)
          const containerXml = await zip.file('META-INF/container.xml')?.async('text')
          const opfPath = containerXml?.match(/full-path="([^"]+)"/)?.[1]
          const opf = opfPath ? await zip.file(opfPath)?.async('text') : ''
          meta = {
            title: opf.match(/<dc:title[^>]*>([^<]+)</)?.[1],
            author: opf.match(/<dc:creator[^>]*>([^<]+)</)?.[1],
          }
        } catch {
          /* 无元数据用文件名 */
        }
      }
      prog.textContent = `上传 ${file.name} ...`
      const qs = new URLSearchParams({
        filename: file.name,
        ...Object.fromEntries(Object.entries(meta).filter(([, v]) => v)),
      })
      const res = await fetch(`/api/book/upload?${qs}`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: file,
      })
      if (!res.ok) {
        prog.textContent = `上传失败 ${file.name}`
        continue
      }
      prog.textContent = ''
    }
    e.target.value = ''
    await render(main)
  }

  main.querySelectorAll('[data-r]').forEach((a) => {
    a.onclick = (e) => {
      e.preventDefault()
      openReader(a.dataset.r, a.dataset.fmt, a.dataset.title)
    }
  })
  main.querySelectorAll('[data-d]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('删除该书（R2 文件一并删除）？')) return
      await api(`/api/book/${b.dataset.d}`, { method: 'DELETE' })
      await render(main)
    }
  })
}

function openReader(id, fmt, title) {
  closeReader()
  const url = `/api/book/read/${id}`
  const { body } = showDialog('<div id="reader-view"></div>', { xl: true })
  const view = body.querySelector('#reader-view')

  if (fmt === 'pdf') {
    view.innerHTML = `<iframe src="${url}" style="width: 100%; height: 80vh; border: 0" title="${esc(title)}"></iframe>`
    return
  }

  // 直接把整本 epub 读成 ArrayBuffer 交给 epub.js：避免它按 URL 末段当目录去解析
  // （/api/book/read/9 没有 .epub 后缀，否则会去请求 /read/META-INF/container.xml）
  fetch(url)
    .then((res) => {
      if (!res.ok) throw new Error(`打开失败：HTTP ${res.status}`)
      return res.arrayBuffer()
    })
    .then((buf) => {
      if (!view.isConnected) return // 弹窗已关闭/切页
      book = window.ePub(buf)
      const rendition = book.renderTo(view, { width: '100%', height: '100%', spread: 'none' })
      rendition.display()
      rendition.on('keydown', (e) => {
        if (e.key === 'ArrowLeft') rendition.prev()
        if (e.key === 'ArrowRight') rendition.next()
      })
    })
    .catch((err) => {
      if (view.isConnected) view.innerHTML = `<div class="alert danger">${esc(err.message)}</div>`
    })
}

export function destroy() {
  closeReader()
  document.getElementById('dlg-body').innerHTML = ''
}
