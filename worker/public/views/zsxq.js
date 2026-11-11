import { api, esc, fmtTime, icon, rerender, run, scrollToTop, toast } from '../lib.js'

const PAGE_SIZE = 20
let page = 1
let pollTimer = 0

const stopPoll = () => {
  if (pollTimer) clearTimeout(pollTimer)
  pollTimer = 0
}

/** 星球列表空态：按 token / 拉取任务状态给不同引导 */
function emptyGroupsHint(g) {
  if (!g.hasToken) {
    return '还没有星球列表：先在上方填写知识星球 token，保存后会自动拉取；也可以点右上角「刷新星球列表」。'
  }
  const r = g.refresh
  if (r?.status === 'pending' || r?.status === 'leased') {
    return '正在从知识星球拉取你加入的星球…（需要至少一个在线节点，稍等片刻）'
  }
  if (r?.status === 'failed') return `拉取失败：${esc(r.result || '未知错误')}。检查 token 后点右上角重试。`
  if (r?.status === 'done') return '星球列表为空：账号下没有可同步的星球，或 token 已失效。'
  return '点右上角「刷新星球列表」，用后台配置的 token 拉取你加入的星球。'
}

export async function render(main) {
  stopPoll()
  const [d, g] = await Promise.all([api(`/api/zsxq/topics?page=${page}`), api('/api/zsxq/groups')])
  const job = d.job ?? {}
  const groups = g.groups ?? []
  const selected = new Set(job.groupIds ?? [])
  const refreshing = g.refresh?.status === 'pending' || g.refresh?.status === 'leased'
  const statusText = job.enabled
    ? `同步已启用${selected.size ? ` · ${selected.size} 个星球` : ''}${job.lastRunAt ? ` · 上次 ${fmtTime(job.lastRunAt)}` : ''}`
    : '同步未启用'

  const groupChecks = groups
    .map(
      (x) => `<label class="check"><input type="checkbox" name="group" value="${esc(x.id)}" ${selected.has(x.id) ? 'checked' : ''}>
        <span>${esc(x.name || x.id)}</span><span class="small muted mono">${esc(x.id)}</span></label>`,
    )
    .join('')

  main.innerHTML = `
    <div class="page-head">
      <div>
        <h1 class="page-title">知识星球</h1>
        <p class="page-sub">共 ${esc(d.total)} 条 · ${esc(statusText)}</p>
      </div>
      <div class="page-actions">
        <button class="btn sm" id="refresh-groups">${refreshing ? '正在拉取…' : '刷新星球列表'}</button>
        <button class="btn sm primary" id="sync-now" ${job.enabled ? '' : 'disabled'}>立即同步</button>
      </div>
    </div>

    <section class="card mb-3">
      <div class="section-head" style="margin-top: 0">
        <h2>同步星球</h2>
        <label class="check"><input type="checkbox" id="sync-enabled" ${job.enabled ? 'checked' : ''}> 启用同步</label>
      </div>
      <div class="flex wrap center mb-2">
        <input class="field field-sm" id="token" type="password" autocomplete="off" style="max-width: 320px"
               placeholder="${g.hasToken ? 'token 已配置，留空不修改' : '粘贴知识星球 token'}"
               aria-label="知识星球 token">
        <button class="btn sm" id="save-token">保存 token</button>
        ${g.hasToken ? `<button class="btn sm warn" id="clear-token">清除</button>` : ''}
        <span class="small muted">${g.hasToken ? 'token 已配置' : 'token 未配置'} · wx.zsxq.com 登录后从请求头取</span>
      </div>
      ${
        groups.length
          ? `<div class="check-row" id="group-list" style="max-height: 220px; overflow: auto">${groupChecks}</div>
             <div class="small muted mt-2">已勾选 ${selected.size} 个；每日 20:20 自动同步，保存后立刻排一轮。</div>`
          : `<div class="small muted" id="group-empty">${emptyGroupsHint(g)}</div>`
      }
      <div class="flex wrap center mt-2">
        <button class="btn sm primary" id="save-group">保存同步配置</button>
        ${job.enabled && job.result ? `<span class="small muted">最近一次同步：${esc(String(job.result).slice(0, 160))}</span>` : ''}
      </div>
    </section>

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
          .join('') ||
        '<div class="empty">暂无话题（勾选星球并保存，任务启用后由节点同步）</div>'
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

  // 首次进入且从未拉取过星球列表：token 就绪时自动请求一次（失败后 refresh 非空，不会反复触发）
  if (g.hasToken && !g.refresh) void queueRefresh(main, true)

  main.querySelector('#refresh-groups').onclick = () => queueRefresh(main)

  // token 就地维护：保存后自动拉一次星球列表，操作连贯
  main.querySelector('#save-token').onclick = async () => {
    const btn = main.querySelector('#save-token')
    const input = main.querySelector('#token')
    const token = input.value.trim()
    if (!token) return toast('先粘贴知识星球 token', true)
    const res = await run(btn, () =>
      api('/api/zsxq/token', { method: 'POST', body: JSON.stringify({ token }) }),
    )
    if (!res.ok) return
    input.value = ''
    await queueRefresh(main, false, 'token 已保存，正在拉取星球列表…')
  }

  const clearToken = main.querySelector('#clear-token')
  if (clearToken) {
    clearToken.onclick = async () => {
      if (!confirm('清除 token 后同步会失败，需要重新填写才能拉取星球列表。确定清除？')) return
      const res = await run(clearToken, () =>
        api('/api/zsxq/token', { method: 'POST', body: JSON.stringify({ token: '' }) }),
      )
      if (!res.ok) return
      toast('token 已清除')
      await rerender(render, main)
    }
  }

  main.querySelector('#save-group').onclick = async () => {
    const btn = main.querySelector('#save-group')
    const groupIds = [...main.querySelectorAll('#group-list input[name="group"]:checked')].map((i) => i.value)
    const enabled = main.querySelector('#sync-enabled').checked
    if (enabled && !groupIds.length) return toast('至少勾选一个要同步的星球', true)
    const res = await run(btn, () =>
      api('/api/zsxq/job', { method: 'POST', body: JSON.stringify({ groupIds, enabled }) }),
    )
    if (!res.ok) return
    toast(enabled ? '已保存：节点下次轮询即同步' : '已保存：同步任务已停用')
    await rerender(render, main)
  }

  main.querySelector('#sync-now').onclick = async () => {
    const btn = main.querySelector('#sync-now')
    const res = await run(btn, () => api('/api/zsxq/sync', { method: 'POST' }))
    if (res.ok) toast('已排入同步队列，节点下次轮询开始同步')
  }
}

/** 请求节点拉一次星球列表（token 由 Worker 下发时注入） */
async function queueRefresh(main, auto = false, message = auto ? '正在拉取星球列表…' : '已请求节点拉取星球列表') {
  const btn = main.querySelector('#refresh-groups')
  const res = await run(btn, () => api('/api/zsxq/groups/refresh', { method: 'POST' }))
  if (!res.ok) return
  if (auto) {
    const hint = main.querySelector('#group-empty')
    if (hint) hint.textContent = '正在从知识星球拉取你加入的星球…（需要至少一个在线节点，稍等片刻）'
  }
  toast(message)
  pollGroups(main)
}

/** 轮询拉取结果：一次性任务 done/failed 后重绘；最多等 ~40s，避免无节点时无限等待 */
function pollGroups(main) {
  stopPoll()
  let tries = 0
  const tick = async () => {
    tries++
    try {
      const g = await api('/api/zsxq/groups')
      if (g.refresh?.status === 'pending' || g.refresh?.status === 'leased') {
        if (tries >= 20) {
          toast('星球列表还在等待节点领取：确认节点在线后再点「刷新星球列表」', true)
          await rerender(render, main)
          return
        }
        pollTimer = setTimeout(tick, 2000)
        return
      }
      await rerender(render, main)
      if (g.groups?.length) toast(`已获取 ${g.groups.length} 个星球，勾选后保存`)
      else toast(g.refresh?.result || '没拉到星球：检查 token 或节点在线情况', true)
    } catch {
      if (tries < 10) pollTimer = setTimeout(tick, 2000)
      else toast('拉取星球列表超时，请稍后重试', true)
    }
  }
  pollTimer = setTimeout(tick, 1500)
}

export function destroy() {
  stopPoll()
}
