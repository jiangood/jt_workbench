import { api, esc, fmtTime, icon, rerender, run, scrollToTop, toast } from '../lib.js'

const PAGE_SIZE = 20
let page = 1

export async function render(main) {
  const d = await api(`/api/zsxq/topics?page=${page}`)
  const job = d.job ?? {}
  const groupOpts = (d.groups ?? [])
    .map((g) => `<option value="${esc(g.id)}" label="${esc(g.name || g.id)}">${esc(g.name || g.id)}</option>`)
    .join('')
  const statusText = job.enabled
    ? `同步已启用${job.lastRunAt ? ` · 上次 ${fmtTime(job.lastRunAt)}` : ''}`
    : '同步未启用'

  main.innerHTML = `
    <div class="page-head">
      <div>
        <h1 class="page-title">知识星球</h1>
        <p class="page-sub">共 ${esc(d.total)} 条 · ${esc(statusText)} · token 在后台「参数与密钥」维护</p>
      </div>
      <div class="page-actions">
        <input class="field field-sm" id="group" list="group-list" inputmode="numeric" autocomplete="off"
               style="max-width: 210px" placeholder="星球 ID（数字）" value="${esc(job.groupId ?? '')}"
               aria-label="知识星球 groupId">
        <datalist id="group-list">${groupOpts}</datalist>
        <label class="check"><input type="checkbox" id="sync-enabled" ${job.enabled ? 'checked' : ''}> 启用同步</label>
        <button class="btn sm primary" id="save-group">保存同步配置</button>
      </div>
    </div>
    ${
      job.enabled
        ? job.result
          ? `<p class="small muted">最近一次同步：${esc(String(job.result).slice(0, 160))}</p>`
          : ''
        : `<p class="small muted">星球 ID 取自网页版地址 <code>wx.zsxq.com/group/&lt;数字&gt;</code>：填好并勾选「启用同步」保存，节点下次轮询就会同步一轮。</p>`
    }
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
          ${(t.files ?? []).length ? `<div class="small muted mt-1">${icon('paperclip', 14)} ${esc(t.files.map((f) => f.name).join('、'))}</div>` : ''}
          <small class="muted">${fmtTime(t.createTime)}</small>
        </div>`,
          )
          .join('') || '<div class="empty">暂无话题（在上方填写星球 ID 并保存，任务启用后由节点同步）</div>'
      }
    </div>
    <nav class="mt-3 flex center">
      <button class="btn sm" id="prev" ${page <= 1 ? 'disabled' : ''}>上一页</button>
      <span class="small muted">第 ${page} 页</span>
      <button class="btn sm" id="next" ${page * PAGE_SIZE >= d.total ? 'disabled' : ''}>下一页</button>
    </nav>`

  // 翻页后回顶，别让用户停在上一页底部
  const go = async (delta) => {
    page += delta
    await rerender(render, main)
    scrollToTop()
  }
  main.querySelector('#prev').onclick = () => go(-1)
  main.querySelector('#next').onclick = () => go(1)
  main.querySelector('#save-group').onclick = async () => {
    const btn = main.querySelector('#save-group')
    const gid = main.querySelector('#group').value.trim()
    const enabled = main.querySelector('#sync-enabled').checked
    if (enabled && !/^\d{1,20}$/.test(gid)) {
      return toast('先填写星球数字 ID（网页版地址 /group/ 后面那串数字）', true)
    }
    const res = await run(btn, () =>
      api('/api/zsxq/job', {
        method: 'POST',
        body: JSON.stringify({ groupId: gid || undefined, enabled }),
      }),
    )
    if (!res.ok) return
    toast(enabled ? '已保存：同步任务已启用，节点下次轮询即同步' : '已保存：同步任务已停用')
    await rerender(render, main)
  }
}

export function destroy() {}
