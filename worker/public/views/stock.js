import { api, esc, icon, loadScriptOnce } from '../lib.js'

let watch = []
let chart = null
let chartCode = null

function pctHtml(p) {
  const cls = p > 0 ? 'danger-text' : p < 0 ? 'ok-text' : 'muted'
  const sign = p > 0 ? '+' : ''
  return `<span class="${cls}">${sign}${p.toFixed(2)}%</span>`
}

function destroyChart() {
  chart?.destroy()
  chart = null
  chartCode = null
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
        <div class="input-group" style="min-width: 320px">
          <input class="field" id="code" placeholder="代码 sh600519">
          <input class="field" id="name" placeholder="名称 贵州茅台" style="max-width: 130px">
          <button class="btn primary" id="add">添加</button>
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

  main.querySelector('#add').onclick = async () => {
    const code = main.querySelector('#code').value.trim()
    const name = main.querySelector('#name').value.trim()
    if (!code || !name) return
    await api('/api/stock/watch', { method: 'POST', body: JSON.stringify({ code, name }) })
    await render(main)
  }
  main.querySelectorAll('[data-d]').forEach((b) => {
    b.onclick = async () => {
      await api(`/api/stock/watch/${b.dataset.d}`, { method: 'DELETE' })
      await render(main)
    }
  })
  main.querySelectorAll('[data-k]').forEach((b) => {
    b.onclick = () => showDaily(main, b.dataset.k)
  })
}

async function showDaily(main, code) {
  const d = await api(`/api/stock/daily/${code}?days=120`)
  chartCode = code
  const wrap = main.querySelector('#chart-wrap')
  wrap.classList.remove('d-none')
  const labels = d.bars.map((b) => b.day)
  const closes = d.bars.map((b) => b.close)
  chart?.destroy()
  chart = new window.Chart(main.querySelector('#chart'), {
    type: 'line',
    data: {
      labels,
      datasets: [{ label: `${code} 收盘价`, data: closes, borderWidth: 1.5, pointRadius: 0, tension: 0.15 }],
    },
    options: { plugins: { legend: { display: true } }, scales: { x: { ticks: { maxTicksLimit: 10 } } } },
  })
  wrap.scrollIntoView({ behavior: 'smooth' })
}

export function destroy() {
  destroyChart()
}
