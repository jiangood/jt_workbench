import { api, closeMoreMenu, esc, icon, loadScriptOnce, moreMenu, rerender, run, setupMoreMenus, showDialog, toast } from '../lib.js'

let watch = []
let chart = null
let chartCode = null
let chartMeta = null
let themeObserver = null

function pctHtml(value) {
  const p = Number(value)
  if (!Number.isFinite(p)) return '<span class="muted">—</span>'
  const cls = p > 0 ? 'danger-text' : p < 0 ? 'ok-text' : 'muted'
  const sign = p > 0 ? '+' : ''
  return `<span class="${cls}">${sign}${p.toFixed(2)}%</span>`
}

/** Canvas 读不到 CSS 变量，取计算值传给 Chart.js，主题切换才能跟着走 */
function chartColors() {
  const cs = getComputedStyle(document.documentElement)
  const read = (name) => cs.getPropertyValue(name).trim()
  return { line: read('--chart-line'), grid: read('--chart-grid'), tick: read('--chart-tick') }
}

function buildChart(canvas, meta) {
  const c = chartColors()
  return new window.Chart(canvas, {
    type: 'line',
    data: {
      labels: meta.labels,
      datasets: [
        {
          label: `${meta.code} 收盘价`,
          data: meta.closes,
          borderColor: c.line,
          backgroundColor: c.line,
          borderWidth: 1.5,
          pointRadius: 0,
          pointHoverRadius: 3,
          tension: 0.15,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false, // 由 .chart-box 固定高度，弹窗里不随宽度撑高
      plugins: { legend: { labels: { color: c.tick, boxWidth: 12 } } },
      scales: {
        x: {
          ticks: { maxTicksLimit: 10, maxRotation: 0, color: c.tick },
          grid: { color: c.grid },
          border: { color: c.grid },
        },
        y: {
          ticks: { color: c.tick },
          grid: { color: c.grid },
          border: { color: c.grid },
        },
      },
    },
  })
}

/** 主题切换后按新令牌重建图表 */
function watchTheme(canvas) {
  themeObserver?.disconnect()
  themeObserver = new MutationObserver(() => {
    if (!chart || !chartMeta) return
    chart.destroy()
    chart = buildChart(canvas, chartMeta)
  })
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
}

function destroyChart() {
  themeObserver?.disconnect()
  themeObserver = null
  chart?.destroy()
  chart = null
  chartCode = null
  chartMeta = null
}

export async function render(main) {
  await loadScriptOnce('/vendor/chart.umd.min.js')
  destroyChart()

  const [w, q] = await Promise.all([api('/api/stock/watch'), api('/api/stock/quote').catch(() => ({ quotes: [] }))])
  watch = w.watch
  const qm = Object.fromEntries((q.quotes ?? []).map((x) => [x.code, x]))

  main.innerHTML = `
    <div class="page-head">
      <div>
        <h1 class="page-title">自选股</h1>
        <p class="page-sub">行情 60s 缓存 · 日线按需拉取</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" id="add-stock">${icon('plus')}添加</button>
      </div>
    </div>
    <table>
      <thead><tr><th>代码</th><th>名称</th><th>分组</th><th class="text-end">现价</th><th class="text-end">涨跌</th><th class="text-end">今开</th><th class="text-end">最高/最低</th><th class="text-end">时间</th><th>K线</th><th></th></tr></thead>
      <tbody>
        ${
          watch
            .map((r) => {
              const x = qm[r.code]
              // preOpen：无成交价（盘前竞价 / 停牌）——价格回退昨收并弱化，涨跌列不显示百分比
              const preOpen = x?.preOpen === true
              const priceText = Number.isFinite(Number(x?.price)) ? Number(x.price).toFixed(2) : '—'
              return `<tr>
                <td class="mono">${esc(r.code)}</td><td>${esc(x?.name || r.name)}</td>
                <td>${r.groupName ? `<span class="badge">${esc(r.groupName)}</span>` : '<span class="muted small">未分组</span>'}</td>
                <td class="text-end mono${preOpen ? ' muted' : ''}">${priceText}</td>
                <td class="text-end">${!x ? '—' : preOpen ? '<span class="muted">未开盘</span>' : pctHtml(x.changePct)}</td>
                <td class="text-end mono">${!x || preOpen ? '—' : x.open.toFixed(2)}</td>
                <td class="text-end mono">${!x || preOpen ? '—' : x.high.toFixed(2) + ' / ' + x.low.toFixed(2)}</td>
                <td class="muted small">${esc(x?.time ?? '')}</td>
                <td><button class="btn sm" data-k="${esc(r.code)}">日线</button></td>
                <td class="text-end">${moreMenu(
                  `stock-${r.code}`,
                  [{ label: '删除自选', icon: 'trash', danger: true, attrs: { 'data-d': r.code } }],
                  { label: `更多操作 ${r.code}`, triggerClass: 'btn sm' },
                )}</td>
              </tr>`
            })
            .join('') || '<tr><td colspan="10" class="muted">暂无自选股，先添加一只</td></tr>'
        }
      </tbody>
    </table>`

  setupMoreMenus(main)
  main.querySelector('#add-stock').onclick = () => openAddDialog(main)
  main.querySelectorAll('[data-d]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm(`从自选股中移除 ${b.dataset.d}？`)) return
      const res = await run(b, () => api(`/api/stock/watch/${b.dataset.d}`, { method: 'DELETE' }))
      if (!res.ok) return
      toast('已移除')
      await rerender(render, main)
    }
  })
  main.querySelectorAll('[data-k]').forEach((b) => {
    b.onclick = () => showDaily(b.dataset.k, b)
  })
}

/** 添加弹窗：输入名称/代码 → 联想搜索 → 选择 → 填分组 → 确定 */
function openAddDialog(main) {
  const groups = [...new Set(watch.map((r) => r.groupName).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh'))
  const { close, body } = showDialog(
    `<h2>添加自选股</h2>
     <form id="stock-add-form" novalidate>
       <label class="form-label" for="stock-q">股票</label>
       <div class="combo">
         <input class="field" id="stock-q" placeholder="输入名称或代码，如 茅台 / 600519"
                role="combobox" aria-autocomplete="list" aria-expanded="false"
                aria-controls="stock-suggest" aria-describedby="stock-msg"
                autocomplete="off" spellcheck="false">
         <div class="combo-list" id="stock-suggest" role="listbox" aria-label="股票搜索结果" hidden></div>
       </div>
       <div class="field-error" id="stock-msg" role="alert"></div>
       <label class="form-label mt-2" for="stock-group">分组（可选）</label>
       <input class="field" id="stock-group" list="stock-group-list" maxlength="50"
              placeholder="选择或输入分组，如 白酒" autocomplete="off">
       <datalist id="stock-group-list">${groups.map((g) => `<option value="${esc(g)}"></option>`).join('')}</datalist>
       <div class="dlg-foot">
         <button class="btn sm" type="button" data-close>取消</button>
         <button class="btn primary sm" type="submit">确定</button>
       </div>
     </form>`,
    { label: '添加自选股' },
  )

  const form = body.querySelector('#stock-add-form')
  const input = body.querySelector('#stock-q')
  const list = body.querySelector('#stock-suggest')
  const msg = body.querySelector('#stock-msg')
  const groupEl = body.querySelector('#stock-group')

  let options = []
  let selected = null
  let active = -1
  let status = ''
  let seq = 0
  let timer = 0
  let blurTimer = 0

  const say = (text) => {
    msg.textContent = text ?? ''
    if (text) input.setAttribute('aria-invalid', 'true')
    else input.removeAttribute('aria-invalid')
  }

  const paint = () => {
    const open = options.length > 0 || Boolean(status)
    if (options.length) {
      list.innerHTML = options
        .map(
          (o, i) => `<div class="combo-opt" id="stock-opt-${i}" role="option" data-i="${i}" aria-selected="${i === active}"${o.added ? ' aria-disabled="true"' : ''}>
            <span class="mono">${esc(o.code)}</span>
            <span class="flex-grow-1">${esc(o.name)}</span>
            ${o.added ? '<span class="badge">已添加</span>' : ''}
          </div>`,
        )
        .join('')
    } else {
      list.innerHTML = `<div class="combo-empty">${esc(status || '未找到匹配的股票')}</div>`
    }
    list.hidden = !open
    input.setAttribute('aria-expanded', String(open))
    if (active >= 0) input.setAttribute('aria-activedescendant', `stock-opt-${active}`)
    else input.removeAttribute('aria-activedescendant')
    if (active >= 0) list.querySelector(`#stock-opt-${active}`)?.scrollIntoView({ block: 'nearest' })
  }

  const closeList = () => {
    seq += 1 // 作废进行中的搜索，避免失焦后又弹回来
    clearTimeout(timer)
    options = []
    active = -1
    status = ''
    list.hidden = true
    list.innerHTML = ''
    input.setAttribute('aria-expanded', 'false')
    input.removeAttribute('aria-activedescendant')
  }

  const choose = (i) => {
    const o = options[i]
    if (!o || o.added) return
    selected = o
    input.value = `${o.code} ${o.name}`
    say('')
    closeList()
    groupEl.focus()
  }

  const search = async (keyword) => {
    const mySeq = ++seq
    if (!keyword) {
      closeList()
      return
    }
    options = []
    active = -1
    status = '搜索中…'
    paint()
    try {
      const data = await api(`/api/stock/search?keyword=${encodeURIComponent(keyword)}`)
      if (mySeq !== seq) return
      options = data.items ?? []
      active = options.findIndex((o) => !o.added)
      status = options.length ? '' : '未找到匹配的股票'
      paint()
    } catch (err) {
      if (mySeq !== seq) return
      options = []
      active = -1
      status = err?.message || '搜索失败'
      paint()
    }
  }

  input.addEventListener('input', () => {
    selected = null
    say('')
    clearTimeout(timer)
    const keyword = input.value.trim()
    timer = setTimeout(() => search(keyword), 280)
  })

  input.addEventListener('blur', () => {
    clearTimeout(blurTimer)
    blurTimer = setTimeout(closeList, 150)
  })

  input.addEventListener('keydown', (e) => {
    const open = !list.hidden
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!open || !options.length) return
      e.preventDefault()
      const step = e.key === 'ArrowDown' ? 1 : -1
      let next = active < 0 ? (step > 0 ? -1 : 0) : active
      for (let n = 0; n < options.length; n += 1) {
        next = (next + step + options.length) % options.length
        if (!options[next].added) {
          active = next
          paint()
          return
        }
      }
      return
    }
    if (e.key === 'Enter' && open && active >= 0) {
      e.preventDefault()
      choose(active)
      return
    }
    if (e.key === 'Escape' && open) {
      e.preventDefault()
      closeList()
    }
  })

  // mousedown 阻止默认：点选项时输入框不失焦（否则 blur 先把列表关掉）
  list.addEventListener('mousedown', (e) => e.preventDefault())
  list.addEventListener('click', (e) => {
    const opt = e.target instanceof Element ? e.target.closest('[data-i]') : null
    if (opt) choose(Number(opt.dataset.i))
  })

  form.onsubmit = async (e) => {
    e.preventDefault()
    if (!selected) {
      say('请从搜索结果中选择股票')
      input.focus()
      return
    }
    const groupName = groupEl.value.trim()
    const res = await run(form.querySelector('button[type="submit"]'), () =>
      api('/api/stock/watch', {
        method: 'POST',
        body: JSON.stringify({ code: selected.code, name: selected.name, groupName }),
      }),
    )
    if (!res.ok) return
    close()
    toast('已加入自选')
    await rerender(render, main)
  }

  body.querySelector('[data-close]').onclick = close
  input.focus()
}

async function showDaily(code, btn) {
  const res = await run(btn, () => api(`/api/stock/daily/${code}?days=120`))
  if (!res.ok) return
  const bars = res.data.bars ?? []
  if (!bars.length) {
    toast(`${code} 暂无日线数据`, true)
    return
  }

  destroyChart()
  chartCode = code
  const name = watch.find((r) => r.code === code)?.name
  const { close, body } = showDialog(
    `<h2>${esc(code)}${name ? ` ${esc(name)}` : ''} 日线</h2>
     <div class="chart-box"><canvas id="stock-chart"></canvas></div>
     <p class="muted small mt-2" id="stock-chart-note"></p>
     <div class="dlg-foot">
       <button class="btn sm" type="button" data-close>关闭</button>
     </div>`,
    { xl: true, label: `${code} 日线` },
  )

  const canvas = body.querySelector('#stock-chart')
  chartMeta = { code, labels: bars.map((b) => b.day), closes: bars.map((b) => b.close) }
  const range = `${chartMeta.labels[0]} 至 ${chartMeta.labels.at(-1)}`
  body.querySelector('#stock-chart-note').textContent = `${range} · 共 ${chartMeta.labels.length} 个交易日`
  canvas.setAttribute('role', 'img')
  canvas.setAttribute('aria-label', `${code} 日线收盘价，${range}，共 ${chartMeta.labels.length} 个交易日`)

  chart = buildChart(canvas, chartMeta)
  watchTheme(canvas)

  // 弹窗关闭（按钮 / Esc / 路由切换）时释放图表，避免主题监听残留
  const dlg = document.getElementById('dlg')
  const onClose = () => {
    dlg.removeEventListener('close', onClose)
    destroyChart()
  }
  dlg.addEventListener('close', onClose)
  body.querySelector('[data-close]').onclick = close
}

export function destroy() {
  closeMoreMenu()
  destroyChart()
}
