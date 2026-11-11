import { api, closeModal, esc, icon, rerender, run, showDialog, toast } from '../lib.js'

const REPEAT = { none: '单次', daily: '每天', weekly: '每周', monthly: '每月', yearly: '每年' }

const OFFSET_PRESETS = [
  { days: 30, label: '提前 30 天' },
  { days: 14, label: '提前 14 天' },
  { days: 7, label: '提前 1 周' },
  { days: 3, label: '提前 3 天' },
  { days: 1, label: '提前 1 天' },
  { days: 0, label: '当天' },
]

const LUNAR_MONTHS = ['正月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '冬月', '腊月']
const LUNAR_DAYS = [
  '初一', '初二', '初三', '初四', '初五', '初六', '初七', '初八', '初九', '初十',
  '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十',
  '廿一', '廿二', '廿三', '廿四', '廿五', '廿六', '廿七', '廿八', '廿九', '三十',
]

const pad = (n) => String(n).padStart(2, '0')

function dtLocal(ts) {
  if (!ts) return '—'
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function inputDateTime(ts) {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function timeOfDay(ts) {
  const d = new Date(ts)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const toEpochMs = (v) => (v ? new Date(v).getTime() : 0)

/** 提前点摘要：30/7/1 + 当天 */
function offsetText(offsets) {
  const list = Array.isArray(offsets) ? offsets : []
  const leads = list.filter((o) => o > 0)
  const sameDay = list.includes(0)
  if (!leads.length) return '当天'
  return `提前 ${leads.join('/')} 天${sameDay ? ' + 当天' : ''}`
}

export async function render(main) {
  const data = await api('/api/reminder/list')
  const reminders = data.reminders
  const to = data.to

  main.innerHTML = `
    <div class="page-head">
      <div>
        <h1 class="page-title">提醒</h1>
        <p class="page-sub">扫描粒度 10 分钟 · 支持每年/农历/多个提前天数 · 收件箱：${
          to ? esc(to) : '<a href="#/admin">未配置，去后台「参数与密钥」填写</a>'
        }</p>
      </div>
      <div class="page-actions">
        <button class="btn sm" id="scan">${icon('refresh')}立即扫描</button>
        <button class="btn sm" id="periodic">${icon('calendar')}定期提醒</button>
        <button class="btn sm primary" id="new">${icon('plus')}新建</button>
      </div>
    </div>
    <table>
      <thead><tr><th>标题</th><th>事件</th><th>重复 / 提前</th><th>下次发送</th><th>上次发送</th><th>状态</th><th></th></tr></thead>
      <tbody>
        ${
          reminders
            .map(
              (r) => `
          <tr>
            <td>${esc(r.title)}${r.note ? `<div class="small muted">${esc(r.note)}</div>` : ''}</td>
            <td>${
              r.calendarType === 'lunar'
                ? `<div>农历${esc(r.lunarText || '')}</div><div class="mono small muted">${dtLocal(r.eventAt)}</div>`
                : `<span class="mono small">${dtLocal(r.eventAt)}</span>`
            }</td>
            <td>${REPEAT[r.repeat] || esc(r.repeat)}<div class="small muted">${offsetText(r.offsets)}</div></td>
            <td class="mono small">${dtLocal(r.remindAt)}</td>
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
    const res = await run(main.querySelector('#scan'), () => api('/api/reminder/scan', { method: 'POST' }))
    if (!res.ok) return
    toast(`扫描完成：发送 ${res.data.sent} 封`)
    await rerender(render, main)
  }
  main.querySelector('#new').onclick = () => showForm(main, null)
  main.querySelector('#periodic').onclick = () =>
    showForm(main, null, { repeat: 'yearly', offsets: [7, 0] })
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

function showForm(main, r, preset = null) {
  const initialCalendar = r?.calendarType ?? 'solar'
  const initialRepeat = r?.repeat ?? preset?.repeat ?? 'none'
  const initialOffsets = r?.offsets ?? preset?.offsets ?? [0]
  const anchorAt = r?.anchorAt ?? r?.eventAt
  // “定期提醒”按生日场景预填 09:00；“新建”默认一小时后
  const presetAt = new Date()
  presetAt.setHours(9, 0, 0, 0)
  const solarValue = r
    ? inputDateTime(anchorAt)
    : inputDateTime(preset ? presetAt.getTime() : Date.now() + 3600_000)
  const lunarMonth = r?.lunarMonth ?? 1
  const lunarDay = r?.lunarDay ?? 1
  const lunarLeap = !!r?.lunarLeap
  const lunarTime = r ? timeOfDay(anchorAt) : '09:00'

  const { body } = showDialog(`
    <h2>${r ? '编辑提醒' : preset ? '新建定期提醒' : '新建提醒'}</h2>
    <div class="mb-2">
      <label class="field-label" for="f-title">标题</label>
      <input class="field" id="f-title" placeholder="例如：妈妈生日" value="${esc(r?.title ?? '')}" aria-describedby="f-msg">
    </div>
    <div class="mb-2">
      <label class="field-label" for="f-note">备注</label>
      <textarea class="field" id="f-note" rows="2" placeholder="备注（可选）">${esc(r?.note ?? '')}</textarea>
    </div>
    <div class="mb-2">
      <span class="field-label">历法</span>
      <div class="check-row">
        <label><input type="radio" name="f-cal" value="solar" ${initialCalendar === 'solar' ? 'checked' : ''}> 公历</label>
        <label><input type="radio" name="f-cal" value="lunar" ${initialCalendar === 'lunar' ? 'checked' : ''}> 农历</label>
      </div>
    </div>
    <div class="mb-2" id="f-solar-box">
      <label class="field-label" for="f-at">事件日期时间</label>
      <input class="field" id="f-at" type="datetime-local" value="${solarValue}" aria-describedby="f-msg">
    </div>
    <div class="mb-2" id="f-lunar-box" hidden>
      <span class="field-label">农历日期 / 时刻</span>
      <div class="input-group reminder-lunar">
        <select class="field" id="f-lunar-month" aria-label="农历月份">
          ${LUNAR_MONTHS.map((name, i) => `<option value="${i + 1}" ${lunarMonth === i + 1 ? 'selected' : ''}>${name}</option>`).join('')}
        </select>
        <select class="field" id="f-lunar-day" aria-label="农历日期">
          ${LUNAR_DAYS.map((name, i) => `<option value="${i + 1}" ${lunarDay === i + 1 ? 'selected' : ''}>${name}</option>`).join('')}
        </select>
        <label class="check"><input type="checkbox" id="f-lunar-leap" ${lunarLeap ? 'checked' : ''}> 闰月</label>
        <input class="field" id="f-lunar-time" type="time" value="${lunarTime}" aria-label="提醒时刻">
      </div>
    </div>
    <div class="mb-2">
      <label class="field-label" for="f-repeat">重复方式</label>
      <select class="field" id="f-repeat">
        ${Object.entries(REPEAT)
          .map(([k, v]) => `<option value="${k}" ${initialRepeat === k ? 'selected' : ''}>${v}</option>`)
          .join('')}
      </select>
    </div>
    <div class="mb-2">
      <span class="field-label">提前提醒（可多选）</span>
      <div class="check-row" id="f-offsets">
        ${OFFSET_PRESETS.map(
          (o) =>
            `<label><input type="checkbox" value="${o.days}" ${initialOffsets.includes(o.days) ? 'checked' : ''}> ${o.label}</label>`,
        ).join('')}
      </div>
      <p class="small muted">按天计算；同一天内补发，跨天不补。多个提前点会按从早到晚依次发送。</p>
    </div>
    <div class="mb-3">
      <label class="check"><input type="checkbox" id="f-enabled" ${!r || r.enabled ? 'checked' : ''}> 启用</label>
    </div>
    <div class="field-error" id="f-msg" role="alert"></div>
    <div class="dlg-foot">
      <button class="btn" id="f-cancel">取消</button>
      <button class="btn primary" id="f-save">保存</button>
    </div>`)

  const titleEl = body.querySelector('#f-title')
  const atEl = body.querySelector('#f-at')
  const repeatEl = body.querySelector('#f-repeat')
  const calEls = [...body.querySelectorAll('input[name="f-cal"]')]
  const solarBox = body.querySelector('#f-solar-box')
  const lunarBox = body.querySelector('#f-lunar-box')
  const lunarMonthEl = body.querySelector('#f-lunar-month')
  const lunarDayEl = body.querySelector('#f-lunar-day')
  const lunarLeapEl = body.querySelector('#f-lunar-leap')
  const lunarTimeEl = body.querySelector('#f-lunar-time')
  const offsetEls = [...body.querySelectorAll('#f-offsets input[type="checkbox"]')]
  const enabledEl = body.querySelector('#f-enabled')
  const msgEl = body.querySelector('#f-msg')

  const calValue = () => calEls.find((el) => el.checked)?.value ?? 'solar'
  const validEls = [titleEl, atEl, lunarTimeEl]

  const clearInvalid = () => validEls.forEach((el) => el.removeAttribute('aria-invalid'))
  const fail = (el, text) => {
    clearInvalid()
    msgEl.textContent = text
    if (el) {
      el.setAttribute('aria-invalid', 'true')
      el.focus()
    }
  }
  for (const el of validEls) {
    el.addEventListener('input', () => {
      msgEl.textContent = ''
      el.removeAttribute('aria-invalid')
    })
  }

  // 农历只支持每年；每天/每周不支持提前点
  const syncRepeat = () => {
    const lunar = calValue() === 'lunar'
    if (lunar) repeatEl.value = 'yearly'
    const simple = repeatEl.value === 'daily' || repeatEl.value === 'weekly'
    for (const opt of repeatEl.options) opt.disabled = lunar && opt.value !== 'yearly'
    for (const el of offsetEls) {
      el.disabled = simple
      if (simple) el.checked = el.value === '0'
    }
  }
  const syncCalendar = () => {
    const lunar = calValue() === 'lunar'
    solarBox.hidden = lunar
    lunarBox.hidden = !lunar
    syncRepeat()
  }
  calEls.forEach((el) => (el.onchange = syncCalendar))
  repeatEl.onchange = syncRepeat
  syncCalendar()

  body.querySelector('#f-cancel').onclick = () => closeModal()
  body.querySelector('#f-save').onclick = async () => {
    const btn = body.querySelector('#f-save')
    const title = titleEl.value.trim()
    const calendar = calValue()
    const repeat = repeatEl.value
    const offsets = offsetEls.filter((el) => el.checked).map((el) => Number(el.value))
    const enabled = enabledEl.checked
    msgEl.textContent = ''
    clearInvalid()

    if (!title) return fail(titleEl, '标题不能为空')
    if (!offsets.length) return fail(offsetEls[0], '请至少选择一个提前提醒时间')

    let payload
    if (calendar === 'lunar') {
      const time = lunarTimeEl.value
      const [h, m] = time.split(':').map(Number)
      if (!Number.isInteger(h) || !Number.isInteger(m)) return fail(lunarTimeEl, '请选择提醒时刻')
      payload = {
        title,
        note: body.querySelector('#f-note').value.trim(),
        calendar,
        repeat,
        offsets,
        enabled,
        lunarMonth: Number(lunarMonthEl.value),
        lunarDay: Number(lunarDayEl.value),
        lunarLeap: lunarLeapEl.checked,
        eventMinutes: h * 60 + m,
      }
    } else {
      const eventAt = toEpochMs(atEl.value)
      if (!eventAt) return fail(atEl, '请选择事件时间')
      payload = {
        title,
        note: body.querySelector('#f-note').value.trim(),
        calendar,
        repeat,
        offsets,
        enabled,
        eventAt,
      }
    }

    const res = await run(btn, () =>
      r
        ? api(`/api/reminder/list/${r.id}`, { method: 'PUT', body: JSON.stringify(payload) })
        : api('/api/reminder/list', { method: 'POST', body: JSON.stringify(payload) }),
    )
    if (!res.ok) return
    closeModal()
    toast('已保存')
    await rerender(render, main)
  }
}

export function destroy() {}
