import { api, esc, fmtTime } from '../lib.js'

const PAGE_SIZE = 20
let page = 1

export async function render(main) {
  const d = await api(`/api/zsxq/topics?page=${page}`)
  const groupOpts = (d.groups ?? [])
    .map((g) => `<option value="${esc(g.id)}" ${g.enabled ? '' : 'disabled'}>${esc(g.name || g.id)}</option>`)
    .join('')

  main.innerHTML = `
    <div class="page-head">
      <div>
        <h1 class="page-title">知识星球</h1>
        <p class="page-sub">共 ${esc(d.total)} 条 · 同步节奏克制（agent env 配 token）</p>
      </div>
      <div class="page-actions">
        <select class="field field-sm" id="group">${groupOpts || '<option value="">配置 groupId</option>'}</select>
        <button class="btn sm primary" id="save-group">保存同步配置</button>
      </div>
    </div>
    <div class="list">
      ${
        d.topics
          .map(
            (t) => `
        <div>
          ${t.title ? `<div class="fw-semibold">${esc(t.title)}</div>` : ''}
          <div class="pre">${esc(t.talkText || '(无正文)')}</div>
          ${
            (t.images ?? []).length
              ? `<div class="flex wrap mt-2">
            ${t.images
              .map(
                (im) => `<img class="rounded" loading="lazy" style="max-height: 140px"
                   src="/api/zsxq/img?u=${encodeURIComponent(im.u)}" alt="">`,
              )
              .join('')}
          </div>`
              : ''
          }
          ${(t.files ?? []).length ? `<div class="small muted mt-1">📎 ${esc(t.files.map((f) => f.name).join('、'))}</div>` : ''}
          <small class="muted">${fmtTime(t.createTime)}</small>
        </div>`,
          )
          .join('') || '<div class="empty">暂无话题（配置 groupId 并启用 zsxq_sync 任务后由节点同步）</div>'
      }
    </div>
    <nav class="mt-3 flex center">
      <button class="btn sm" id="prev" ${page <= 1 ? 'disabled' : ''}>上一页</button>
      <span class="small muted">第 ${page} 页</span>
      <button class="btn sm" id="next" ${page * PAGE_SIZE >= d.total ? 'disabled' : ''}>下一页</button>
    </nav>`

  main.querySelector('#prev').onclick = () => {
    page--
    render(main)
  }
  main.querySelector('#next').onclick = () => {
    page++
    render(main)
  }
  main.querySelector('#save-group').onclick = async () => {
    const gid = main.querySelector('#group').value
    if (!gid) return
    await api('/api/zsxq/job', { method: 'POST', body: JSON.stringify({ groupId: gid, enabled: true }) })
    alert('已保存：zsxq_sync 任务已启用')
  }
}

export function destroy() {}
