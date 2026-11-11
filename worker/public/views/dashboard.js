import { api, esc, fmtTime, icon } from '../lib.js'

const CARDS = [
  ['今日资讯', 'newsToday', 'news', '#/news'],
  ['待发提醒', 'reminderDue', 'bell', '#/reminder'],
  ['自选股', 'stockWatch', 'stock', '#/stock'],
  ['笔记', 'note', 'note', '#/note'],
  ['曲目', 'music', 'music', '#/music'],
  ['藏书', 'book', 'book', '#/book'],
]

export async function render(main) {
  const d = await api('/api/admin/summary')
  const nodes = d.nodes ?? []
  const allOffline = nodes.length === 0 || nodes.every((n) => !n.online)
  const outdated = nodes.some((n) => n.online && n.outdated)
  const onlineNode = nodes.find((n) => n.online)

  let banner = ''
  if (allOffline) {
    banner = `<div class="alert danger">${icon('alert')}
      <span><strong>执行节点离线</strong>——抓取/同步/收盘任务与提醒外发已停（离线判定 30 分钟）。${nodes.length ? `最后心跳：${fmtTime(nodes[0].last_seen_at)}` : '从未有节点上线（检查宿主机 agent）'}</span></div>`
  } else if (outdated) {
    banner = `<div class="alert warning">${icon('refresh')}
      <span><strong>agent 版本落后</strong>——节点版本与最新发布不一致，等待 Watchtower 拉取或手动升级。</span></div>`
  }

  main.innerHTML = `
    <div class="page-head">
      <div>
        <h1 class="page-title">Dashboard</h1>
        <p class="page-sub">执行节点与今日概览</p>
      </div>
      <div class="page-actions">
        ${
          onlineNode
            ? `<span class="pill ok"><span class="dot"></span>${esc(onlineNode.node_id)} · v${esc(onlineNode.agent_version)}</span>`
            : '<span class="pill bad"><span class="dot"></span>无在线节点</span>'
        }
      </div>
    </div>
    ${banner}
    <div class="stats">
      ${CARDS.map(
        ([label, key, ico, href]) => `
        <a class="stat" href="${href}">
          <div class="stat-top">
            <span class="stat-icon">${icon(ico, 18)}</span>
          </div>
          <div class="stat-num">${esc(d.cards?.[key] ?? 0)}</div>
          <div class="stat-label">${label}</div>
        </a>`,
      ).join('')}
    </div>

    <div class="section-head"><h5>节点</h5></div>
    <table style="max-width: 640px">
      <thead><tr><th>节点</th><th>版本</th><th>在持任务</th><th>最后心跳</th><th>状态</th></tr></thead>
      <tbody>
        ${
          nodes
            .map(
              (n) => `
          <tr>
            <td class="mono">${esc(n.node_id)}</td>
            <td>${esc(n.agent_version)}</td>
            <td>${esc(n.heldJobs)}</td>
            <td class="small muted">${fmtTime(n.last_seen_at)}</td>
            <td>${
              n.online
                ? `<span class="pill ok"><span class="dot"></span>在线</span>`
                : `<span class="pill bad"><span class="dot"></span>离线</span>`
            }</td>
          </tr>`,
            )
            .join('') || '<tr><td colspan="5" class="muted">无节点记录</td></tr>'
        }
      </tbody>
    </table>`
}

export function destroy() {}
