import { api, esc, icon, loadScriptOnce, rerender, run, toast } from '../lib.js'

let watch = []
let chart = null
let chartCode = null
let chartMeta = null
let themeObserver = null

function pctHtml(p) {
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
        <div>
          <div class="input-group add-stock-row">
            <label class="sr-only" for="code">股票代码</label>
            <input class="field" id="code" placeholder="代码 sh600519" aria-describedby="add-msg">
            <label class="sr-only" for="name">股票名称</label>
            <input class="field" id="name" placeholder="名称 贵州茅台" aria-describedby="add-msg">
            <button class="btn primary" id="add">添加</button>
          </div>
          <div class="field-error" id="add-msg" role="alert"></div>
        </div>
      </div>
    </div>
    <table>
      <thead><tr><th>代码</th><th>名称</th><th class="text-end">现价</th><th class="text-end">涨跌</th><th class="text-end">今开</th><th class="text-end">最高/最低</th><th class="text-end">时间</th><th>K线</th><th></th></tr></thead>
      <tbody>
        ${
          watch
            .map((r) => {
              const x = qm[r.code]
              return `<tr>
                <td class="mono">${esc(r.code)}</td><td>${esc(x?.name || r.name)}</td>
                <td class="text-end mono">${x?.price?.toFixed(2) ?? '—'}</td>
                <td class="text-end">${x ? pctHtml(x.changePct) : '—'}</td>
                <td class="text-end mono">${x?.open?.toFixed(2) ?? '—'}</td>
                <td class="text-end mono">${x ? x.high.toFixed(2) + ' / ' + x.low.toFixed(2) : '—'}</td>
                <td class="muted small">${esc(x?.time ?? '')}</td>
                <td><button class="btn sm" data-k="${esc(r.code)}">日线</button></td>
                <td><button class="btn sm danger" data-d="${esc(r.code)}" aria-label="删除">${icon('trash', 14)}</button></td>
              </tr>`
            })
            .join('') || '<tr><td colspan="9" class="muted">暂无自选股，先添加一只</td></tr>'
        }
      </tbody>
    </table>
    <div id="chart-wrap" class="card mt-3 d-none">
      <div class="card-body"><canvas id="chart" height="90"></canvas></div>
    </div>`

  const codeEl = main.querySelector('#code')
  const nameEl = main.querySelector('#name')
  const addMsg = main.querySelector('#add-msg')
  const sayAdd = (text, field) => {
    addMsg.textContent = text
    codeEl.removeAttribute('aria-invalid')
    nameEl.removeAttribute('aria-invalid')
    if (!text || !field) return
    field.setAttribute('aria-invalid', 'true')
    field.focus()
  }
  codeEl.addEventListener('input', () => sayAdd(''))
  nameEl.addEventListener('input', () => sayAdd(''))

  main.querySelector('#add').onclick = async () => {
    const btn = main.querySelector('#add')
    const code = codeEl.value.trim()
    const name = nameEl.value.trim()
    if (!code) return sayAdd('请填写股票代码', codeEl)
    if (!name) return sayAdd('请填写股票名称', nameEl)
    sayAdd('')
    const res = await run(btn, () => api('/api/stock/watch', { method: 'POST', body: JSON.stringify({ code, name }) }))
    if (!res.ok) return
    toast('已加入自选')
    await rerender(render, main)
  }
  main.querySelectorAll('[data-d]').forEach((b) => {
    b.onclick = async () => {
      const res = await run(b, () => api(`/api/stock/watch/${b.dataset.d}`, { method: 'DELETE' }))
      if (!res.ok) return
      toast('已移除')
      await rerender(render, main)
    }
  })
  main.querySelectorAll('[data-k]').forEach((b) => {
    b.onclick = () => showDaily(main, b.dataset.k, b)
  })
}

async function showDaily(main, code, btn) {
  const res = await run(btn, () => api(`/api/stock/daily/${code}?days=120`))
  if (!res.ok) return
  const bars = res.data.bars ?? []
  if (!bars.length) {
    toast(`${code} 暂无日线数据`, true)
    return
  }
  chartCode = code
  const wrap = main.querySelector('#chart-wrap')
  wrap.classList.remove('d-none')

  const canvas = main.querySelector('#chart')
  chartMeta = { code, labels: bars.map((b) => b.day), closes: bars.map((b) => b.close) }
  const range = `${chartMeta.labels[0]} 至 ${chartMeta.labels.at(-1)}`
  canvas.setAttribute('role', 'img')
  canvas.setAttribute('aria-label', `${code} 日线收盘价，${range}，共 ${chartMeta.labels.length} 个交易日`)

  chart?.destroy()
  chart = buildChart(canvas, chartMeta)
  watchTheme(canvas)

  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  wrap.scrollIntoView({ behavior: still ? 'auto' : 'smooth' })
}

export function destroy() {
  destroyChart()
}
