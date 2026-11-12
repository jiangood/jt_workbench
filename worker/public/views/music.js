import {
  api,
  closeModal,
  closeMoreMenu,
  esc,
  fmtDuration,
  icon,
  loadModuleOnce,
  moreMenu,
  player,
  rerender,
  run,
  setupMoreMenus,
  showDialog,
  toast,
} from '../lib.js'
import { enqueue } from '../upload.js'

/** 曲目列表缓存：进页先用上次数据铺满，再静默换成接口最新数据（切页回来不再空一屏） */
const CACHE_KEY = 'wb-music-list'

let unsubscribe = null
/** 视图是否还是当前页：切页后不要再用旧视图的 main 去刷接口 */
let alive = true
/** 当前曲目列表（接口数据；缓存只在首屏兜底） */
let tracks = []
/** music-metadata 模块：加载失败只影响上传解析，不影响列表 */
let metadata = null

function readCache() {
  try {
    const list = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null')
    return Array.isArray(list) ? list : null
  } catch {
    return null
  }
}

function writeCache(list) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(list))
  } catch {
    /* 隐私模式 / 配额满：缓存失败不影响使用 */
  }
}

function trackOf(id) {
  return tracks.find((t) => String(t.id) === String(id))
}

function paintActive(main) {
  main.querySelectorAll('tr[data-track]').forEach((tr) => {
    tr.classList.toggle('active', String(player.currentId) === tr.dataset.track)
  })
}

function rowHtml(t, i) {
  const title = t.title || t.filename
  return `
    <tr data-track="${esc(t.id)}">
      <td class="col-no">${i + 1}</td>
      <td>
        <button class="track-title" type="button" data-p="${esc(t.id)}" title="播放 ${esc(title)}">
          <span class="track-name truncate">${esc(title)}</span>
          <span class="row-sub small muted truncate">${esc(t.artist || '未知艺术家')}</span>
        </button>
      </td>
      <td class="col-artist">${esc(t.artist || '—')}</td>
      <td class="col-album">${esc(t.album || '—')}</td>
      <td class="col-dur small muted">${fmtDuration(t.duration) || '—'}</td>
      <td class="col-size small muted">${(t.size / 1048576).toFixed(1)} MB</td>
      <td>
        <div class="row-acts">
          <button class="icon-btn" data-q="${esc(t.id)}" aria-label="加入播放列表" title="加入播放列表">${icon('plus', 16)}</button>
          <button class="icon-btn" data-e="${esc(t.id)}" aria-label="编辑曲目信息" title="编辑曲目信息">${icon('edit', 16)}</button>
          ${moreMenu(
            `music-${t.id}`,
            [{ label: '删除曲目', icon: 'trash', danger: true, attrs: { 'data-d': t.id } }],
            { label: `更多操作 ${title}` },
          )}
        </div>
      </td>
    </tr>`
}

function paintTracks(main, list) {
  const tbody = main.querySelector('#tracks')
  if (!tbody) return
  tbody.innerHTML =
    list.map(rowHtml).join('') ||
    '<tr><td colspan="7" class="muted">暂无曲目 · 点右上角「上传」添加，或拖入音频文件</td></tr>'
  setupMoreMenus(main)
  main.querySelector('#play-all').disabled = !list.length
  main.querySelector('#play-shuffle').disabled = !list.length
  paintActive(main)
}

function paintSummary(main, list) {
  const sum = main.querySelector('#music-sum')
  if (!sum) return
  const total = list.reduce((n, t) => n + (Number(t.duration) || 0), 0)
  sum.textContent = list.length
    ? `共 ${list.length} 首${total ? ` · ${Math.floor(total / 60)}:${String(Math.round(total % 60)).padStart(2, '0')}` : ''} · tag 由浏览器解析，切页不断播`
    : 'tag 由浏览器解析，切页不断播'
}

function shellHtml() {
  return `
    <div class="page-head">
      <div>
        <h1 class="page-title">音乐库</h1>
        <p class="page-sub" id="music-sum">tag 由浏览器解析，切页不断播</p>
      </div>
      <div class="page-actions">
        <button class="btn sm primary" id="play-all" type="button" disabled>${icon('play', 14)}播放全部</button>
        <button class="btn sm" id="play-shuffle" type="button" disabled>${icon('shuffle', 14)}随机播放</button>
        <label class="btn sm">
          ${icon('upload')}上传
          <input class="sr-only" type="file" id="up" accept="audio/*,.ape" multiple>
        </label>
      </div>
    </div>
    <table>
      <thead>
        <tr>
          <th class="col-no">#</th>
          <th>标题</th>
          <th class="col-artist">艺术家</th>
          <th class="col-album">专辑</th>
          <th class="col-dur">时长</th>
          <th class="col-size">大小</th>
          <th><span class="sr-only">操作</span></th>
        </tr>
      </thead>
      <tbody id="tracks"></tbody>
    </table>`
}

function openEdit(main, t) {
  const { body } = showDialog(`
    <h2>编辑曲目信息</h2>
    <div class="mb-2">
      <label class="field-label" for="m-title">标题</label>
      <input class="field" id="m-title" maxlength="300" value="${esc(t.title || t.filename || '')}" aria-describedby="m-msg">
    </div>
    <div class="mb-2">
      <label class="field-label" for="m-artist">艺术家</label>
      <input class="field" id="m-artist" maxlength="200" value="${esc(t.artist || '')}" placeholder="留空显示「未知艺术家」">
    </div>
    <div class="mb-2">
      <label class="field-label" for="m-album">专辑</label>
      <input class="field" id="m-album" maxlength="200" value="${esc(t.album || '')}">
    </div>
    <p class="small muted">只改音乐库里的显示信息，不会写回音频文件的 tag。</p>
    <div class="field-error" id="m-msg" role="alert"></div>
    <div class="dlg-foot">
      <button class="btn" id="m-cancel" type="button">取消</button>
      <button class="btn primary" id="m-save" type="button">保存</button>
    </div>`)

  const titleEl = body.querySelector('#m-title')
  const artistEl = body.querySelector('#m-artist')
  const albumEl = body.querySelector('#m-album')
  const msgEl = body.querySelector('#m-msg')
  const saveBtn = body.querySelector('#m-save')

  for (const el of [titleEl, artistEl, albumEl]) {
    el.addEventListener('input', () => {
      msgEl.textContent = ''
      el.removeAttribute('aria-invalid')
    })
  }

  body.querySelector('#m-cancel').onclick = () => closeModal()
  saveBtn.onclick = async () => {
    const title = titleEl.value.trim()
    const artist = artistEl.value.trim()
    const album = albumEl.value.trim()
    if (!title) {
      msgEl.textContent = '标题不能为空'
      titleEl.setAttribute('aria-invalid', 'true')
      titleEl.focus()
      return
    }
    const res = await run(saveBtn, () =>
      api(`/api/music/${t.id}`, { method: 'PATCH', body: JSON.stringify({ title, artist, album }) }),
    )
    if (!res.ok) return
    // 队列 / 播放条上的同名曲目同步更新，不必重载页面
    player.updateTrack(t.id, { title, artist, album })
    tracks = tracks.map((x) => (x.id === t.id ? { ...x, title, artist, album } : x))
    writeCache(tracks)
    closeModal()
    toast('已保存')
    await rerender(render, main)
  }
}

async function removeTrack(main, id) {
  if (!confirm('删除该曲目（R2 文件一并删除）？')) return
  const btn = main.querySelector(`[data-d="${id}"]`)
  const res = await run(btn, () => api(`/api/music/${id}`, { method: 'DELETE' }))
  if (!res.ok) return
  // 从播放队列里移出；正在播的那首会顺势切到下一首
  const qi = player.queue.findIndex((t) => String(t.id) === String(id))
  if (qi >= 0) player.removeAt(qi)
  tracks = tracks.filter((t) => t.id !== id)
  writeCache(tracks)
  toast('已删除')
  await rerender(render, main)
}

export async function render(main) {
  alive = true
  // 缓存优先：先铺上次的列表，接口回来再替换（首屏不用等网络）
  const cached = tracks.length ? tracks : readCache()
  main.innerHTML = shellHtml()
  paintTracks(main, cached || [])
  paintSummary(main, cached || [])

  const data = await api('/api/music/list')
  if (!alive) return
  tracks = data.tracks || []
  writeCache(tracks)
  paintTracks(main, tracks)
  paintSummary(main, tracks)
  // 队列里（localStorage 恢复的）旧曲目补文件版本，再次播放才能命中长缓存
  player.syncMeta(tracks)

  unsubscribe?.()
  unsubscribe = player.onChange(() => paintActive(main))

  main.querySelector('#play-all').onclick = () => {
    if (!tracks.length) return
    player.playQueue(tracks, 0)
  }
  main.querySelector('#play-shuffle').onclick = () => {
    if (!tracks.length) return
    player.playQueue(tracks, 0, { mode: 'shuffle', random: true })
  }

  main.querySelector('#up').onchange = (e) => {
    const files = [...e.target.files]
    e.target.value = ''
    if (!files.length) return
    enqueue(files, {
      title: '上传音乐',
      // 浏览器端 music-metadata parseBlob（v3 决策 #9）：失败就用文件名
      // vendor 有 234KB，等真要上传再拉——进页就下会和音频流抢同一条带宽
      prepare: async (file) => {
        metadata = metadata || (await loadModuleOnce('/vendor/music-metadata.min.js').catch(() => null))
        if (!metadata) return {}
        try {
          const meta = await metadata.parseBlob(file)
          return {
            title: meta.common.title,
            artist: meta.common.artist,
            album: meta.common.album,
            duration: meta.format?.duration ? Math.round(meta.format.duration) : '',
          }
        } catch {
          return {}
        }
      },
      url: (qs) => `/api/music/upload?${qs}`,
      contentType: (file) => file.type || 'application/octet-stream',
      onSettled: (summary) => {
        if (alive && summary.ok) rerender(render, main)
      },
    })
  }

  // 表格操作走事件委托：tbody 重绘后不用重新绑定
  main.onclick = async (e) => {
    const btn = e.target.closest('[data-p],[data-q],[data-e],[data-d]')
    if (!btn) return
    const t = trackOf(btn.dataset.p || btn.dataset.q || btn.dataset.e || btn.dataset.d)
    if (!t) return

    if (btn.dataset.p) {
      const pos = tracks.findIndex((x) => x.id === t.id)
      player.playQueue(tracks, Math.max(pos, 0))
    } else if (btn.dataset.q) {
      const r = player.enqueue(t)
      toast(r === 'exists' ? '已在播放列表中' : r === 'playing' ? '开始播放' : '已加入播放列表')
    } else if (btn.dataset.e) {
      openEdit(main, t)
    } else if (btn.dataset.d) {
      await removeTrack(main, t.id)
    }
  }
}

export function destroy() {
  alive = false
  closeMoreMenu()
  unsubscribe?.()
  unsubscribe = null
}
