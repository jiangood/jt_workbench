import { api, closeModal, esc, icon, showDialog } from '../lib.js'

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

  main.innerHTML = `
    <div class="page-head">
      <div>
        <h1 class="page-title">提醒</h1>
        <p class="page-sub">扫描粒度 10 分钟（与原系统一致）</p>
      </div>
      <div class="page-actions">
        <button class="btn sm" id="scan">${icon('refresh')}立即扫描</button>
        <button class="btn sm primary" id="new">${icon('plus')}新建</button>
      </div>
    </div>
    <table>
      <thead><tr><th>标题</th><th>下次提醒</th><th>重复</th><th>收件人</th><th>上次发送</th><th>状态</th><th></th></tr></thead>
      <tbody>
        ${
          reminders
            .map(
              (r) => `
          <tr>
            <td>${esc(r.title)}${r.note ? `<div class="small muted">${esc(r.note)}</div>` : ''}</td>
            <td class="mono small">${dtLocal(r.remindAt)}</td>
            <td>${REPEAT[r.repeat] || esc(r.repeat)}</td>
            <td class="small">${esc(r.email)}</td>
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
            .join('') || '<tr><td colspan="7" class="muted">暂无提醒</td></tr>'
        }
      </tbody>
    </table>`

  main.querySelector('#scan').onclick = async () => {
    const r = await api('/api/reminder/scan', { method: 'POST' })
    alert(`扫描完成：发送 ${r.sent} 封`)
    await render(main)
  }
  main.querySelector('#new').onclick = () => showForm(main, null)
  main.querySelectorAll('[data-e]').forEach((b) => {
    b.onclick = () => showForm(main, reminders.find((r) => String(r.id) === b.dataset.e))
  })
  main.querySelectorAll('[data-d]').forEach((b) => {
    b.onclick = async () => {
      await api(`/api/reminder/list/${b.dataset.d}`, { method: 'DELETE' })
      await render(main)
    }
  })
}

function showForm(main, r) {
  const body = showDialog(`
    <h5>${r ? '编辑提醒' : '新建提醒'}</h5>
    <div class="mb-2"><input class="field" id="f-title" placeholder="标题" value="${esc(r?.title ?? '')}"></div>
    <div class="mb-2"><textarea class="field" id="f-note" rows="2" placeholder="备注（可选）">${esc(r?.note ?? '')}</textarea></div>
    <div class="input-group mb-2">
      <input class="field" id="f-at" type="datetime-local" value="${r ? dtLocal(r.remindAt) : ''}">
      <select class="field" id="f-repeat" style="max-width: 120px">
        ${Object.entries(REPEAT)
          .map(([k, v]) => `<option value="${k}" ${r?.repeat === k ? 'selected' : ''}>${v}</option>`)
          .join('')}
      </select>
    </div>
    <div class="mb-3"><input class="field" id="f-email" placeholder="收件邮箱" value="${esc(r?.email ?? '')}"></div>
    <div class="dlg-foot">
      <button class="btn" id="f-cancel">取消</button>
      <button class="btn primary" id="f-save">保存</button>
    </div>`)

  body.querySelector('#f-cancel').onclick = () => closeModal()
  body.querySelector('#f-save').onclick = async () => {
    const payload = JSON.stringify({
      title: body.querySelector('#f-title').value.trim(),
      note: body.querySelector('#f-note').value.trim(),
      remindAt: toEpochMs(body.querySelector('#f-at').value),
      repeat: body.querySelector('#f-repeat').value,
      email: body.querySelector('#f-email').value.trim(),
    })
    if (r) await api(`/api/reminder/list/${r.id}`, { method: 'PUT', body: payload })
    else await api('/api/reminder/list', { method: 'POST', body: payload })
    closeModal()
    await render(main)
  }
}

export function destroy() {}
