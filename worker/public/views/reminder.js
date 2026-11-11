import { api, closeModal, esc, icon, rerender, run, showDialog, toast } from '../lib.js'

const REPEAT = { none: '单次', daily: '每天', weekly: '每周', monthly: '每月' }

function dtLocal(ts) {
  if (!ts) return '—'
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

const toEpochMs = (v) => (v ? new Date(v).getTime() : 0)

export async function render(main) {
  const data = await api('/api/reminder/list')
  const reminders = data.reminders
  const to = data.to

  main.innerHTML = `
    <div class="page-head">
      <div>
        <h1 class="page-title">提醒</h1>
        <p class="page-sub">扫描粒度 10 分钟（与原系统一致）· 收件箱：${
          to ? esc(to) : '<a href="#/admin">未配置，去后台「参数与密钥」填写</a>'
        }</p>
      </div>
      <div class="page-actions">
        <button class="btn sm" id="scan">${icon('refresh')}立即扫描</button>
        <button class="btn sm primary" id="new">${icon('plus')}新建</button>
      </div>
    </div>
    <table>
      <thead><tr><th>标题</th><th>下次提醒</th><th>重复</th><th>上次发送</th><th>状态</th><th></th></tr></thead>
      <tbody>
        ${
          reminders
            .map(
              (r) => `
          <tr>
            <td>${esc(r.title)}${r.note ? `<div class="small muted">${esc(r.note)}</div>` : ''}</td>
            <td class="mono small">${dtLocal(r.remindAt)}</td>
            <td>${REPEAT[r.repeat] || esc(r.repeat)}</td>
            <td class="small">${dtLocal(r.lastSentAt)}</td>
            <td class="small">${
              r.enabled
                ? r.lastError
                  ? `<span class="pill warn" title="${esc(r.lastError)}"><span class="dot"></span>待发(有误)</span>`
                  : `<span class="pill ok"><span class="dot"></span>启用</span>`
                : `<span class="pill"><span class="dot"></span>已结束</span>`
            }</td>
            <td class="nowrap">
              <button class="btn sm" data-e="${esc(r.id)}">编辑</button>
              <button class="btn sm danger" data-d="${esc(r.id)}" aria-label="删除">${icon('trash', 14)}</button>
            </td>
          </tr>`,
            )
            .join('') || '<tr><td colspan="6" class="muted">暂无提醒</td></tr>'
        }
      </tbody>
    </table>`

  main.querySelector('#scan').onclick = async () => {
    const res = await run(main.querySelector('#scan'), () => api('/api/reminder/scan', { method: 'POST' }))
    if (!res.ok) return
    toast(`扫描完成：发送 ${res.data.sent} 封`)
    await rerender(render, main)
  }
  main.querySelector('#new').onclick = () => showForm(main, null)
  main.querySelectorAll('[data-e]').forEach((b) => {
    b.onclick = () => showForm(main, reminders.find((r) => String(r.id) === b.dataset.e))
  })
  main.querySelectorAll('[data-d]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('删除该提醒？删除后不再发送。')) return
      const res = await run(b, () => api(`/api/reminder/list/${b.dataset.d}`, { method: 'DELETE' }))
      if (!res.ok) return
      toast('已删除')
      await rerender(render, main)
    }
  })
}

function showForm(main, r) {
  const { body } = showDialog(`
    <h2>${r ? '编辑提醒' : '新建提醒'}</h2>
    <div class="mb-2">
      <label class="sr-only" for="f-title">标题</label>
      <input class="field" id="f-title" placeholder="标题" value="${esc(r?.title ?? '')}" aria-describedby="f-msg">
    </div>
    <div class="mb-2">
      <label class="sr-only" for="f-note">备注</label>
      <textarea class="field" id="f-note" rows="2" placeholder="备注（可选）">${esc(r?.note ?? '')}</textarea>
    </div>
    <div class="input-group reminder-when mb-2">
      <label class="sr-only" for="f-at">提醒时间</label>
      <input class="field" id="f-at" type="datetime-local" value="${r ? dtLocal(r.remindAt) : ''}" aria-describedby="f-msg">
      <label class="sr-only" for="f-repeat">重复方式</label>
      <select class="field" id="f-repeat">
        ${Object.entries(REPEAT)
          .map(([k, v]) => `<option value="${k}" ${r?.repeat === k ? 'selected' : ''}>${v}</option>`)
          .join('')}
      </select>
    </div>
    <div class="mb-3">
      <p class="small muted">统一发到全局收件箱（后台「参数与密钥」→ 提醒收件邮箱）</p>
    </div>
    <div class="field-error" id="f-msg" role="alert"></div>
    <div class="dlg-foot">
      <button class="btn" id="f-cancel">取消</button>
      <button class="btn primary" id="f-save">保存</button>
    </div>`)

  const titleEl = body.querySelector('#f-title')
  const atEl = body.querySelector('#f-at')
  const msgEl = body.querySelector('#f-msg')
  const clearInvalid = () => [titleEl, atEl].forEach((el) => el.removeAttribute('aria-invalid'))
  const fail = (el, text) => {
    clearInvalid()
    msgEl.textContent = text
    el.setAttribute('aria-invalid', 'true')
    el.focus()
  }
  for (const el of [titleEl, atEl]) {
    el.addEventListener('input', () => {
      msgEl.textContent = ''
      el.removeAttribute('aria-invalid')
    })
  }

  body.querySelector('#f-cancel').onclick = () => closeModal()
  body.querySelector('#f-save').onclick = async () => {
    const btn = body.querySelector('#f-save')
    const title = titleEl.value.trim()
    const remindAt = toEpochMs(atEl.value)
    msgEl.textContent = ''
    clearInvalid()
    if (!title) return fail(titleEl, '标题不能为空')
    if (!remindAt) return fail(atEl, '请选择提醒时间')
    const payload = JSON.stringify({
      title,
      note: body.querySelector('#f-note').value.trim(),
      remindAt,
      repeat: body.querySelector('#f-repeat').value,
    })
    const res = await run(btn, () =>
      r
        ? api(`/api/reminder/list/${r.id}`, { method: 'PUT', body: payload })
        : api('/api/reminder/list', { method: 'POST', body: payload }),
    )
    if (!res.ok) return
    closeModal()
    toast('已保存')
    await rerender(render, main)
  }
}

export function destroy() {}
