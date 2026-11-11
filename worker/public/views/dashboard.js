/** 首页：卡片流（资讯 / 提醒 / 自选股 / 笔记 / 知识星球）+ 底部状态条
 *  参考旧工作台首页（D:\ws\workbench\web\src\pages\index.jsx）：
 *  纯计数换成「能直接读的一屏」，空状态给出下一步入口，资讯点开即读。 */

import { api, esc, fmtTime, icon, loadScriptOnce, run, showDialog } from '../lib.js'

const REPEAT = { none: '单次', daily: '每天', weekly: '每周', monthly: '每月' }
const DAY_MS = 86400_000

const pad = (n) => String(n).padStart(2, '0')

function startOfDay(value) {
  const d = new Date(value)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** 短时间：当天只显示时分，跨天补月-日 */
function fmtShort(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  return d.toDateString() === new Date().toDateString() ? time : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`
}

/** 行情时间来自新浪字符串（yyyy-MM-dd HH:mm:ss），不走 new Date 解析避免兼容问题 */
function quoteTimeText(value) {
  const m = String(value ?? '').match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/)
  return m ? `${m[2]}-${m[3]} ${m[4]}:${m[5]}` : String(value ?? '')
}

/** 提醒倒计时：待发送 / 今天 / N 天后（发送语义由 tick 扫描决定，这里只做展示） */
function remindTone(ts) {
  if (!ts) return { text: '—', cls: 'muted' }
  const now = Date.now()
  const days = Math.round((startOfDay(ts) - startOfDay(now)) / DAY_MS)
  if (ts < now) return { text: '待发送', cls: 'bad' }
  if (days === 0) return { text: '今天', cls: 'bad' }
  if (days <= 3) return { text: `${days} 天后`, cls: 'warn' }
  return { text: `${days} 天后`, cls: 'muted' }
}

function cardHead(title, badge, href, linkText) {
  return `<div class="home-card-head">
    <h2>${title}${badge || ''}</h2>
    <a class="home-card-link" href="${href}">${linkText || '查看全部'} →</a>
  </div>`
}

/** 空状态：图标 + 一句提示 + 下一步入口（借鉴旧首页的 EmptyHint + CardLink） */
function emptyBox(iconName, text, actionText, href) {
  return `<a class="home-empty" href="${href}">
    <span class="home-empty-icon">${icon(iconName, 20)}</span>
    <span>${text}</span>
    <small>${actionText} →</small>
  </a>`
}

export async function render(main) {
  // 汇总与行情互不阻塞：行情源挂了不该让首页整体报错
  const [summary, quote] = await Promise.allSettled([
    api('/api/admin/summary'),
    api('/api/stock/quote'),
  ])
  if (summary.status !== 'fulfilled') throw summary.reason

  const d = summary.value
  const quotes = quote.status === 'fulfilled' ? quote.value.quotes ?? [] : []
  const quoteFailed = quote.status === 'rejected' && (d.cards?.stockWatch ?? 0) > 0
  const quoteMap = new Map(quotes.map((q) => [q.code, q]))

  const nodes = d.nodes ?? []
  const onlineNodes = nodes.filter((n) => n.online)
  const allOffline = nodes.length === 0 || onlineNodes.length === 0
  const outdated = nodes.some((n) => n.online && n.outdated)

  let banner = ''
  if (allOffline) {
    banner = `<div class="alert danger">${icon('alert')}
      <span><strong>执行节点离线</strong>——抓取/同步/收盘任务与提醒外发已停（离线判定 30 分钟）。${nodes.length ? `最后心跳：${fmtTime(nodes[0].last_seen_at)}` : '从未有节点上线（检查宿主机 agent）'}</span></div>`
  } else if (outdated) {
    banner = `<div class="alert warning">${icon('refresh')}
      <span><strong>agent 版本落后</strong>——节点版本与最新发布不一致，等待 Watchtower 拉取或手动升级。</span></div>`
  }

  const nodePill = onlineNodes.length
    ? `<span class="pill ok"><span class="dot"></span>${esc(onlineNodes[0].node_id)} · v${esc(onlineNodes[0].agent_version || '?')}${onlineNodes.length > 1 ? ` +${onlineNodes.length - 1}` : ''}</span>`
    : '<span class="pill bad"><span class="dot"></span>无在线节点</span>'

  const news = d.news ?? {}
  const newsItems = news.latest ?? []
  const newsUnread = Number(news.unread ?? 0)
  const newsList = newsItems.length
    ? newsItems
        .map((n) => {
          const unread = !n.readFlag
          return `<button type="button" class="home-news-item${unread ? '' : ' is-read'}" data-news="${esc(n.id)}" aria-haspopup="dialog">
            <span class="home-news-dot${unread ? ' is-unread' : ''}"></span>
            <span class="home-news-title" title="${esc(n.title || '')}">${esc(n.title || '(无标题)')}</span>
            <span class="home-news-meta">${esc(n.sourceName || '')}${n.publishedAt ? ` · ${fmtShort(n.publishedAt)}` : ''}</span>
          </button>`
        })
        .join('')
    : emptyBox('news', '暂无资讯，等待执行节点抓取', '管理订阅源', '#/news')

  const reminders = d.reminders ?? {}
  const upcoming = reminders.upcoming ?? []
  const reminderList = upcoming.length
    ? upcoming
        .map((r) => {
          const tone = remindTone(r.remindAt)
          return `<a class="home-row" href="#/reminder">
            <span class="home-row-main">
              <span class="home-row-title">${esc(r.title)}</span>
              <span class="home-row-meta">${esc(fmtShort(r.remindAt))} · ${REPEAT[r.repeat] || esc(r.repeat || '单次')}</span>
            </span>
            <span class="badge ${tone.cls}">${tone.text}</span>
          </a>`
        })
        .join('')
    : emptyBox('bell', '未来暂无提醒', '新建提醒', '#/reminder')

  const watch = d.stocks?.watch ?? []
  const stockList = watch.length
    ? watch
        .map((w) => {
          const q = quoteMap.get(w.code)
          const pct = Number(q?.changePct)
          const tone = !Number.isFinite(pct) || pct === 0 ? 'muted' : pct > 0 ? 'up' : 'down'
          return `<a class="home-row" href="#/stock">
            <span class="home-row-main">
              <span class="home-row-title">${esc(w.name || w.code)}</span>
              <span class="home-row-meta">${esc(w.code)}</span>
            </span>
            <span class="home-row-side">
              <span class="home-row-price">${q && Number.isFinite(Number(q.price)) ? Number(q.price).toFixed(2) : '—'}</span>
              <span class="home-row-change ${tone}">${
                Number.isFinite(pct) ? `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%` : '—'
              }</span>
            </span>
          </a>`
        })
        .join('')
    : emptyBox('stock', '暂无自选股', '添加自选股', '#/stock')

  const stocksFoot = watch.length
    ? `<div class="home-card-foot">${icon('clock', 14)}${
        quotes.length ? `行情 ${esc(quoteTimeText(quotes[0].time))}` : quoteFailed ? '行情暂不可用' : '行情待更新'
      }</div>`
    : ''

  const notes = d.notes ?? {}
  const noteList = (notes.latest ?? []).length
    ? notes.latest
        .map(
          (n) => `<a class="home-row" href="#/note?id=${esc(n.id)}">
            <span class="home-row-main">
              <span class="home-row-title">${esc(n.title || '无标题')}</span>
              <span class="home-row-meta">${esc(n.preview || '暂无内容')}</span>
            </span>
            <span class="home-row-side small muted">${esc(fmtShort(n.updatedAt))}</span>
          </a>`,
        )
        .join('')
    : emptyBox('note', '还没有笔记，去记录一个想法', '新建笔记', '#/note')

  const zsxq = d.zsxq ?? {}
  const topicList = (zsxq.latest ?? []).length
    ? zsxq.latest
        .map(
          (t) => `<a class="home-row" href="#/zsxq">
            <span class="home-row-main">
              <span class="home-topic-text">${esc(t.title || t.preview || '(无正文)')}</span>
            </span>
            <span class="home-row-side small muted">${esc(fmtShort(t.createTime))}</span>
          </a>`,
        )
        .join('')
    : emptyBox('star', zsxq.enabled ? '暂无归档话题，等待节点同步' : '未启用同步', '去知识星球', '#/zsxq')

  const zsxqText = zsxq.total
    ? `已归档 ${zsxq.total} 条`
    : zsxq.enabled
      ? zsxq.hasToken
        ? '待同步'
        : '待配置 token'
      : '未启用'

  const updatedAt = `${pad(new Date().getHours())}:${pad(new Date().getMinutes())}`

  main.innerHTML = `
    <div class="page-head">
      <div>
        <h1 class="page-title">Dashboard</h1>
        <p class="page-sub">今日概览 · 资讯与提醒直接可读</p>
      </div>
      <div class="page-actions">${nodePill}</div>
    </div>
    ${banner}
    <div class="home-grid">
      <section class="card home-card home-card-wide">
        ${cardHead('资讯', `<span class="badge ${newsUnread > 0 ? 'warn' : 'muted'}" id="news-unread" data-count="${newsUnread}">未读 ${newsUnread}</span>`, '#/news', '查看全部')}
        <div class="home-news">${newsList}</div>
      </section>

      <section class="card home-card">
        ${cardHead('近期提醒', `<span class="badge ${reminders.due > 0 ? 'bad' : 'muted'}">待发 ${esc(reminders.due ?? 0)}</span>`, '#/reminder', '查看全部')}
        <div class="home-body">${reminderList}</div>
        <div class="home-card-foot">${icon('clock', 14)}扫描粒度 10 分钟</div>
      </section>

      <section class="card home-card">
        ${cardHead('自选股', `<span class="badge muted">${esc(d.cards?.stockWatch ?? 0)} 只</span>`, '#/stock', '查看全部')}
        <div class="home-body">${stockList}</div>
        ${stocksFoot}
      </section>

      <section class="card home-card">
        ${cardHead('最近笔记', `<span class="badge muted">共 ${esc(notes.total ?? 0)} 条</span>`, '#/note', '查看全部')}
        <div class="home-body">${noteList}</div>
      </section>

      <section class="card home-card">
        ${cardHead('知识星球', `<span class="badge muted">${esc(zsxq.total ?? 0)}</span>`, '#/zsxq', '查看全部')}
        <div class="home-body">${topicList}</div>
      </section>
    </div>

    <div class="statusbar">
      <span class="statusbar-item">${icon('star', 14)}知识星球 <strong>${esc(zsxqText)}</strong></span>
      <span class="statusbar-item">${icon('book', 14)}藏书 <strong>${esc(d.library?.book ?? 0)}</strong> · 曲目 <strong>${esc(d.library?.music ?? 0)}</strong></span>
      <span class="statusbar-item">${icon('clock', 14)}行情 <strong>${esc(quotes.length ? quoteTimeText(quotes[0].time) : quoteFailed ? '暂不可用' : '暂无')}</strong></span>
      <span class="statusbar-spacer"></span>
      <span class="statusbar-item">更新于 ${updatedAt}</span>
      <button class="btn sm" id="refresh">${icon('refresh', 14)}刷新</button>
    </div>`

  main.querySelector('#refresh').onclick = (e) => run(e.currentTarget, () => render(main))
  main.querySelectorAll('[data-news]').forEach((btn) => {
    btn.onclick = () => openNews(main, btn)
  })
}

/** 资讯详情弹窗：正文原文返回，浏览器端 DOMPurify 消毒后注入 */
async function openNews(main, btn) {
  const id = btn.dataset.news
  const res = await run(null, () => api(`/api/news/items/${id}`))
  if (!res.ok) return
  const item = res.data.item

  let body = ''
  if (item.contentHtml) {
    try {
      await loadScriptOnce('/vendor/purify.min.js')
      body = window.DOMPurify.sanitize(item.contentHtml)
    } catch {
      body = ''
    }
  }

  const meta = [
    item.sourceName ? esc(item.sourceName) : '',
    item.author ? esc(item.author) : '',
    item.publishedAt ? esc(fmtTime(item.publishedAt)) : '',
    item.link ? `<a href="${esc(item.link)}" target="_blank" rel="noopener">查看原文</a>` : '',
  ]
    .filter(Boolean)
    .join(' · ')

  showDialog(
    `<h2>${esc(item.title || '资讯详情')}</h2>
     <div class="small muted mb-3">${meta}</div>
     ${body ? `<div class="article-body">${body}</div>` : '<p class="muted">暂无正文，请查看原文。</p>'}`,
    { xl: true, label: '资讯详情' },
  )

  if (!item.readFlag) markNewsRead(main, btn, id)
}

/** 打开即已读：本地乐观更新圆点与未读徽标；标记失败不影响阅读 */
async function markNewsRead(main, btn, id) {
  const dot = btn.querySelector('.home-news-dot')
  if (!dot?.classList.contains('is-unread')) return
  try {
    await api('/api/news/read', { method: 'POST', body: JSON.stringify({ ids: [Number(id)] }) })
  } catch {
    return
  }
  dot.classList.remove('is-unread')
  btn.classList.add('is-read')

  const badge = main.querySelector('#news-unread')
  if (!badge) return
  const next = Math.max(0, Number(badge.dataset.count || 0) - 1)
  badge.dataset.count = String(next)
  badge.textContent = `未读 ${next}`
  badge.classList.toggle('warn', next > 0)
  badge.classList.toggle('muted', next === 0)
}

export function destroy() {}
