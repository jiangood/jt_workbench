import { api, esc, icon, loadModuleOnce, player, rerender, run, toast } from '../lib.js'

let unsubscribe = null

function paintActive(main) {
  main.querySelectorAll('tr[data-track]').forEach((tr) => {
    tr.classList.toggle('active', String(player.currentId) === tr.dataset.track)
  })
}

export async function render(main) {
  // music-metadata 的 vendor 产物是 ESM（末尾 export），必须走动态 import
  const metadata = await loadModuleOnce('/vendor/music-metadata.min.js')
  const data = await api('/api/music/list')

  main.innerHTML = `
    <div class="page-head">
      <div>
        <h1 class="page-title">音乐库</h1>
        <p class="page-sub">tag 由浏览器解析，文件流式入 R2 · 切页不断播</p>
      </div>
      <div class="page-actions">
        <label class="btn sm primary">
          ${icon('upload')}上传
          <input class="sr-only" type="file" id="up" accept="audio/*,.ape" multiple>
        </label>
      </div>
    </div>
    <div id="up-progress" class="small muted mb-2" role="status" aria-live="polite"></div>
    <table>
      <thead><tr><th>标题</th><th>艺术家</th><th>专辑</th><th>大小</th><th></th></tr></thead>
      <tbody>
        ${
          data.tracks
            .map(
              (t) => `
          <tr data-track="${esc(t.id)}">
            <td><a href="#" data-p="${esc(t.id)}">${esc(t.title || t.filename)}</a></td>
            <td>${esc(t.artist || '—')}</td>
            <td>${esc(t.album || '—')}</td>
            <td class="small muted">${(t.size / 1048576).toFixed(1)} MB</td>
            <td><button class="btn sm danger" data-d="${esc(t.id)}" aria-label="删除">${icon('trash', 14)}</button></td>
          </tr>`,
            )
            .join('') || '<tr><td colspan="5" class="muted">暂无曲目</td></tr>'
        }
      </tbody>
    </table>`

  paintActive(main)
  unsubscribe?.()
  unsubscribe = player.onChange(() => paintActive(main))

  main.querySelector('#up').onchange = async (e) => {
    const prog = main.querySelector('#up-progress')
    const files = [...e.target.files]
    let failed = 0
    for (const file of files) {
      prog.textContent = `解析 ${file.name} ...`
      let tags = {}
      try {
        // 浏览器端 music-metadata parseBlob（v3 决策 #9）
        const meta = await metadata.parseBlob(file)
        tags = { title: meta.common.title, artist: meta.common.artist, album: meta.common.album }
      } catch {
        /* 无 tag 用文件名 */
      }
      prog.textContent = `上传 ${file.name} ...`
      const qs = new URLSearchParams({
        filename: file.name,
        ...Object.fromEntries(Object.entries(tags).filter(([, v]) => v)),
      })
      try {
        const res = await fetch(`/api/music/upload?${qs}`, { method: 'POST', headers: { 'content-type': file.type }, body: file })
        if (!res.ok) throw new Error(`上传失败：${file.name}（HTTP ${res.status}）`)
      } catch (err) {
        failed += 1
        toast(err.message, true)
      }
    }
    prog.textContent = ''
    e.target.value = ''
    if (files.length > failed) toast(`已上传 ${files.length - failed} 个文件`)
    await rerender(render, main)
  }

  main.querySelectorAll('[data-p]').forEach((a) => {
    a.onclick = (e) => {
      e.preventDefault()
      const t = data.tracks.find((x) => String(x.id) === a.dataset.p)
      player.play(a.dataset.p, t?.title || t?.filename || '')
    }
  })

  main.querySelectorAll('[data-d]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('删除该曲目（R2 文件一并删除）？')) return
      const res = await run(b, () => api(`/api/music/${b.dataset.d}`, { method: 'DELETE' }))
      if (!res.ok) return
      if (String(player.currentId) === b.dataset.d) player.stop()
      toast('已删除')
      await rerender(render, main)
    }
  })
}

export function destroy() {
  unsubscribe?.()
  unsubscribe = null
}
