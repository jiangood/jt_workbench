import {
  api,
  closeMoreMenu,
  esc,
  fmtTime,
  icon,
  moreMenu,
  rerender,
  run,
  scrollToTop,
  setupMoreMenus,
  showDialog,
  toast,
} from '../lib.js'

const PAGE_SIZE = 20
const COMMENT_PAGE_SIZE = 20
/** 备份轮询：每批 5 个文件 + 10 张图，回包里的 remaining 归零就停 */
const BACKUP_FILES = 5
const BACKUP_IMAGES = 10
const BACKUP_MAX_ROUNDS = 12

let page = 1
// 只看星主：列表与评论请求同时带 ownerOnly=1，关闭后恢复
let ownerOnly = false
// 删除状态筛选：all（含已删除，默认）/ active / deleted
let stateFilter = 'all'
const STATE_LABELS = { all: '全部', active: '正常', deleted: '已删除' }
let pollTimer = 0
// 低频配置（token / 星球勾选）收在弹窗里：页面重绘时保持弹窗打开，数据刷新后原地更新
let configOpen = false
// 视图存活 + 渲染代数：备份循环 / 评论请求在切页或重绘后立刻停手
let alive = true
let renderGen = 0
let backingUp = false
/** 双栏模式：左栏帖子列表 / 右栏评论面板；右栏当前选中（未选 = 空态提示） */
let selectedTopicId = null
/** 当前页的帖子缓存：重绘后恢复选中态时取作者 / 赞数用 */
let lastTopics = []
/** 各话题已拉取的评论缓存（topicId → {page, pages, total, items}）；翻页 / 切筛选后清空 */
const commentState = new Map()

const stopPoll = () => {
  if (pollTimer) clearTimeout(pollTimer)
  pollTimer = 0
}

/** 星球列表空态：按 token / 拉取任务状态给不同引导 */
function emptyGroupsHint(g) {
  if (!g.hasToken) {
    return '还没有星球列表：先填写知识星球 token 并保存，会自动拉取你加入的星球。'
  }
  const r = g.refresh
  if (r?.status === 'pending' || r?.status === 'leased') {
    return '正在从知识星球拉取你加入的星球…（需要至少一个在线节点，稍等片刻）'
  }
  if (r?.status === 'failed') return `拉取失败：${esc(r.result || '未知错误')}。检查 token 后点「刷新星球列表」重试。`
  if (r?.status === 'done') return '星球列表为空：账号下没有可同步的星球，或 token 已失效。'
  return '点「刷新星球列表」，用上面配置的 token 拉取你加入的星球。'
}

/** 附件大小：0 / 缺失时不显示 */
function fmtBytes(n) {
  const size = Number(n) || 0
  if (size <= 0) return ''
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

/** 回溯游标是「YYYY-MM-DDTHH:mm:ss.SSS+0800」：能解析就只显示日期 */
function fmtCursor(cursor) {
  if (!cursor) return ''
  const ts = Date.parse(cursor)
  if (!Number.isFinite(ts)) return String(cursor).slice(0, 10)
  return new Date(ts).toLocaleDateString()
}

/** 历史回溯状态：多星球列出来，超过 3 个收成「等 N 个星球」 */
function progressText(progress, groups) {
  const list = Array.isArray(progress) ? progress.filter(Boolean) : []
  if (!list.length) return '未开始'
  const nameOf = (id) => {
    const hit = groups.find((g) => String(g.id) === String(id))
    return hit?.name || String(id)
  }
  const parts = list.map((p) => {
    const who = list.length > 1 ? `${esc(nameOf(p.groupId))} ` : ''
    if (p.done) return `${who}已完成`
    if (p.cursor) {
      const date = fmtCursor(p.cursor)
      return date ? `${who}已到 ${esc(date)}` : `${who}回溯中`
    }
    const note = p.note ? esc(String(p.note).slice(0, 40)) : '未开始'
    return `${who}${note}`
  })
  return (parts.length > 3 ? [...parts.slice(0, 3), `等 ${parts.length} 个星球`] : parts).join(' · ')
}

// ---------- 正文渲染：解析星球 <e type="..."/> 标记，避免裸标签/编码串直接展示 ----------

function decodeZsxqValue(value) {
  if (!value) return ''
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function safeHref(href) {
  const raw = decodeZsxqValue(href || '')
  try {
    const u = new URL(raw, 'https://wx.zsxq.com')
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.href
  } catch {}
  return ''
}

function parseZsxqAttrs(raw) {
  const attrs = {}
  const re = /([a-zA-Z_:-]+)\s*=\s*"([^"]*)"/g
  let m
  while ((m = re.exec(raw))) attrs[m[1]] = m[2]
  return attrs
}

/** 把星球富文本标记转成可读 HTML；纯文本段落逐段转义，链接仅允许 http/https */
function renderZsxqText(text) {
  if (!text) return ''
  const src = String(text)
  const re = /<e\b([^>]*?)\s*\/>/g
  let out = ''
  let last = 0
  let m
  while ((m = re.exec(src))) {
    out += esc(src.slice(last, m.index))
    out += renderZsxqTag(parseZsxqAttrs(m[1] || ''))
    last = re.lastIndex
  }
  out += esc(src.slice(last))
  return out
}

function renderZsxqTag(attrs) {
  const type = attrs.type || ''
  const title = decodeZsxqValue(attrs.title || '')
  const href = safeHref(attrs.href)
  const label = title || decodeZsxqValue(attrs.name || attrs.text || '')

  if (type === 'mention') {
    const name = label.replace(/^@/, '')
    return `<span class="zsxq-mention">${esc(name ? `@${name}` : '@某人')}</span>`
  }

  if (type === 'hashtag') {
    const tag = label.replace(/^#|#$/g, '')
    return `<span class="zsxq-hashtag">#${esc(tag || '话题')}#</span>`
  }

  if (type === 'web') {
    if (attrs.style === 'book') {
      const name = label || '书籍'
      return href
        ? `<a class="zsxq-book" href="${esc(href)}" target="_blank" rel="noopener">《${esc(name)}》</a>`
        : `<span class="zsxq-book">《${esc(name)}》</span>`
    }
    const text = label || (href ? href.replace(/^https?:\/\//, '').slice(0, 60) : '链接')
    return href
      ? `<a class="zsxq-link" href="${esc(href)}" target="_blank" rel="noopener">${esc(text)}</a>`
      : `<span class="muted">${esc(text || '[链接]')}</span>`
  }

  if (type === 'text') return esc(label)

  // 未识别标记：尽量展示可读文本，避免把原始标签/编码漏到页面
  if (label) return esc(label)
  if (href) return `<a class="zsxq-link" href="${esc(href)}" target="_blank" rel="noopener">${esc(href)}</a>`
  return ''
}

/** 帖子 / 评论元信息：作者 + 星主徽标 + 时间，评论数等附加项靠右 */
function authorLine(authorName, isOwner, at, extra = '') {
  return `<div class="zsxq-meta small">
      <span class="zsxq-meta-main">
        <span class="fw-semibold">${esc(authorName || '未知作者')}</span>
        ${isOwner ? '<span class="badge ok">星主</span>' : ''}
        ${at ? `<span class="muted">${fmtTime(at)}</span>` : ''}
      </span>
      ${extra ? `<span class="zsxq-meta-extra">${extra}</span>` : ''}
    </div>`
}

/** 附件：「名称（大小）」+ 下载链接；没有 fileId 的旧数据只显示名字，避免 404 */
function fileLine(f) {
  const id = f.fileId ?? f.file_id ?? null
  const canDownload = id != null && /^\d+$/.test(String(id))
  const name = f.name || '未命名附件'
  const size = fmtBytes(f.size)
  const backed = f.r2Key ? ' <span class="badge muted">已备份</span>' : ''
  const label = `${esc(name)}${size ? ` <span class="muted">(${esc(size)})</span>` : ''}`
  if (!canDownload) return `<div class="small">${icon('paperclip', 14)} ${label}${backed}</div>`
  return `<div class="small">${icon('paperclip', 14)}
      <a href="/api/zsxq/files/${esc(id)}" download title="下载 ${esc(name)}">${label} ${icon('download', 12)}</a>${backed}</div>`
}

function imageStrip(images, maxHeight) {
  const list = Array.isArray(images) ? images : []
  const usable = list.filter((im) => im && im.u)
  if (!usable.length) return ''
  return `<div class="flex wrap mt-2">
      ${usable
        .map(
          (im) => `<img class="rounded" loading="lazy" style="max-height: ${maxHeight}px"
             src="/api/zsxq/img?u=${encodeURIComponent(im.u)}" alt="">`,
        )
        .join('')}
    </div>`
}

/** 一条评论：作者 / 星主 / 时间 / 正文 / 图片（图片走懒代理） */
function commentHtml(cm) {
  const body = cm.text ? renderZsxqText(cm.text) : ''
  return `<div class="zsxq-comment">
      ${authorLine(cm.authorName, cm.isOwner, cm.createTime)}
      ${body ? `<div class="small pre zsxq-body">${body}</div>` : '<div class="small muted">（无文字内容）</div>'}
      ${imageStrip(cm.images, 120)}
    </div>`
}

/** 一条帖子：元信息 + 正文（解析 <e> 标记） + 图片 + 附件；点卡片切换右栏评论 */
function topicHtml(t) {
  // 星球帖无固定标题字段时 talkText 已是完整正文；去掉重复标题行，只保留正文
  const bodyText = t.talkText || t.title || ''
  const body = bodyText ? renderZsxqText(bodyText) : ''
  const hasMedia = (t.images?.length ?? 0) > 0 || (t.files?.length ?? 0) > 0
  const extra = [
    t.deleted ? '<span class="badge bad">已删除</span>' : '',
    `<span class="badge muted zsxq-count">${Number(t.commentsCount) || 0} 评论</span>`,
  ]
    .filter(Boolean)
    .join('')
  return `<div class="zsxq-topic${t.deleted ? ' is-deleted' : ''}" data-topic="${esc(t.id)}">
      ${authorLine(t.authorName, t.isOwner, t.createTime, extra)}
      <div class="pre mt-1 zsxq-body${body ? '' : ' muted'}">${
        body || (hasMedia ? '（分享了图片或附件）' : '（无文字内容）')
      }</div>
      ${imageStrip(t.images, 140)}
      ${(t.files ?? []).length ? `<div class="mt-2">${t.files.map(fileLine).join('')}</div>` : ''}
      ${
        t.deleted
          ? `<div class="small muted mt-1">${icon('trash', 12)} 已在知识星球删除，本地归档的正文 / 评论 / 附件继续保留</div>`
          : ''
      }
    </div>`
}

export async function render(main) {
  stopPoll()
  alive = true
  renderGen += 1
  const gen = renderGen

  const stateQuery = stateFilter === 'all' ? '' : `&state=${stateFilter}`
  const [d, g] = await Promise.all([
    api(
      `/api/zsxq/topics?page=${page}&pageSize=${PAGE_SIZE}${ownerOnly ? '&ownerOnly=1' : ''}${stateQuery}`,
    ),
    api('/api/zsxq/groups'),
  ])
  if (gen !== renderGen) return

  const groups = g.groups ?? []
  const job = d.job ?? {}
  const selected = new Set(job.groupIds ?? [])
  const refreshing = g.refresh?.status === 'pending' || g.refresh?.status === 'leased'
  const total = Number(d.total) || 0
  const pages = Math.max(1, Number(d.pages) || 1)
  lastTopics = d.topics ?? []
  // 筛选后总数变少：页码越界时回到最后一页重取一次（pages >= 1，不会递归下去）
  if (total > 0 && page > pages) {
    page = pages
    return render(main)
  }
  if (!total) page = 1

  const statusText = [
    job.enabled ? `同步已启用${selected.size ? ` · ${selected.size} 个星球` : ''}` : '同步未启用',
    g.hasToken ? '' : 'token 未配置',
    refreshing ? '正在拉取星球列表…' : '',
    job.lastRunAt ? `上次 ${fmtTime(job.lastRunAt)}` : '',
  ]
    .filter(Boolean)
    .join(' · ')

  main.innerHTML = `
    <div class="page-head">
      <div>
        <h1 class="page-title">知识星球</h1>
        <p class="page-sub">共 ${esc(total)} 条 · ${esc(STATE_LABELS[stateFilter] ?? '全部')}${
          ownerOnly ? ' · 只看星主' : ''
        } · ${esc(statusText)}</p>
      </div>
      <div class="page-actions">
        <select class="field field-sm zsxq-state-filter" id="state-filter" aria-label="按删除状态筛选">
          <option value="all" ${stateFilter === 'all' ? 'selected' : ''}>全部</option>
          <option value="active" ${stateFilter === 'active' ? 'selected' : ''}>正常</option>
          <option value="deleted" ${stateFilter === 'deleted' ? 'selected' : ''}>已删除</option>
        </select>
        <label class="check" title="只看星主发的帖子">
          <input type="checkbox" id="owner-only" ${ownerOnly ? 'checked' : ''}>
          <span>只看星主</span>
        </label>
        <button class="btn sm${g.hasToken ? '' : ' primary'}" id="open-config" aria-haspopup="dialog">${icon(
          'gear',
          14,
        )} 同步配置</button>
        <button class="btn sm primary" id="sync-now" ${job.enabled ? '' : 'disabled'}>立即同步</button>
        ${moreMenu('zsxq', [{ label: '备份星主附件', icon: 'download' }], { label: '更多操作' })}
      </div>
    </div>
    <p class="small muted mt-1" id="zsxq-progress">历史回溯：${progressText(job.progress, groups)}</p>

    ${
      lastTopics.length
        ? `<div class="zsxq-split">
        <div class="list" id="zsxq-topic-list">${lastTopics.map(topicHtml).join('')}</div>
        <aside class="zsxq-pane-comments" id="zsxq-comment-pane" aria-label="评论面板">
          <div class="zsxq-pane-head">
            <span class="fw-semibold" id="zsxq-comment-title">评论</span>
            <span class="small muted" id="zsxq-comment-sub">在左侧选择一条帖子</span>
          </div>
          <div class="zsxq-comment-list" id="zsxq-comment-list"></div>
        </aside>
      </div>`
        : `<div class="empty">${
            stateFilter === 'deleted'
              ? '暂无已删除话题：节点会定期探测，删帖被确认后自动标记到这里'
              : ownerOnly
                ? '只看星主时暂无帖子（星主帖由新版采集任务标记，可先「立即同步」）'
                : '暂无话题（在「同步配置」里勾选星球并启用同步，由节点定时拉取）'
          }</div>`
    }
    <nav class="mt-3 flex center">
      <button class="btn sm" id="prev" ${page <= 1 ? 'disabled' : ''}>上一页</button>
      <span class="small muted">第 ${page} / ${pages} 页${total ? ` · 共 ${total} 条` : ''}</span>
      <button class="btn sm" id="next" ${page >= pages ? 'disabled' : ''}>下一页</button>
    </nav>`

  // 翻页后回顶，别让用户停在上一页底部
  const go = async (delta) => {
    page += delta
    resetSelection()
    await rerender(render, main)
    scrollToTop()
  }
  main.querySelector('#prev').onclick = () => go(-1)
  main.querySelector('#next').onclick = () => go(1)

  main.querySelector('#owner-only').onchange = async (e) => {
    ownerOnly = e.target.checked
    page = 1
    resetSelection()
    await rerender(render, main)
    scrollToTop()
  }

  main.querySelector('#state-filter').onchange = async (e) => {
    stateFilter = e.target.value in STATE_LABELS ? e.target.value : 'all'
    page = 1
    resetSelection()
    await rerender(render, main)
    scrollToTop()
  }

  main.querySelector('#open-config').onclick = () => openConfig(main, g, job)
  // 弹窗开着时重绘（保存 / 拉取结果）：复用同一弹窗，刷新内容而不是关掉
  if (configOpen) openConfig(main, g, job)

  // 首次进入且从未拉取过星球列表：token 就绪时自动请求一次（失败后 refresh 非空，不会反复触发）
  if (g.hasToken && !g.refresh) void queueRefresh(main, null, true)

  main.querySelector('#sync-now').onclick = async () => {
    const btn = main.querySelector('#sync-now')
    const res = await run(btn, () => api('/api/zsxq/sync', { method: 'POST' }))
    if (res.ok) toast('已排入同步队列，节点下次轮询开始同步')
  }

  // 双栏：点左侧帖子卡片 → 右栏显示它的评论（点链接 / 附件不触发）
  const topicList = main.querySelector('#zsxq-topic-list')
  if (topicList) {
    topicList.addEventListener('click', (e) => {
      if (e.target.closest('a')) return
      const card = e.target.closest('.zsxq-topic')
      if (card) selectTopic(card.dataset.topic, { scroll: true })
    })
  }

  // 重绘（备份完成 / 星球列表拉完等）后恢复选中；选中的帖子不在当前页则回空态
  if (selectedTopicId && lastTopics.some((t) => String(t.id) === String(selectedTopicId))) {
    selectTopic(selectedTopicId)
  } else {
    selectedTopicId = null
    renderCommentPane()
  }

  setupMoreMenus(main)
  const backupItem = main.querySelector('#more-zsxq .more-item')
  if (backupItem) backupItem.onclick = () => void backupOwner(main)
}

/** 翻页 / 切筛选后清掉选中与评论缓存，右栏回到空态 */
function resetSelection() {
  selectedTopicId = null
  commentState.clear()
}

/** 右栏评论面板：按选中话题渲染缓存 / 加载态 / 空态 */
function renderCommentPane() {
  const title = document.getElementById('zsxq-comment-title')
  const sub = document.getElementById('zsxq-comment-sub')
  const list = document.getElementById('zsxq-comment-list')
  if (!title || !sub || !list) return
  const t = lastTopics.find((x) => String(x.id) === String(selectedTopicId))
  if (!selectedTopicId || !t) {
    title.textContent = '评论'
    sub.textContent = '在左侧选择一条帖子'
    list.innerHTML = '<div class="small muted">点左侧任意一条帖子，评论会显示在这里</div>'
    return
  }
  const st = commentState.get(selectedTopicId) ?? { page: 0, pages: 1, total: 0, items: [] }
  title.textContent = `评论 ${st.total}`
  sub.textContent = t.authorName || '未知作者'
  // 首次选中还没拉到数据：加载中 / 失败给重试入口（fetchCommentPage 完成后会重绘本面板）
  if (st.page === 0) {
    if (st.error) {
      list.innerHTML =
        '<div class="small muted">评论加载失败</div><button class="btn sm" type="button" data-retry-comments>重试</button>'
      const retry = list.querySelector('[data-retry-comments]')
      retry.onclick = () => {
        st.error = false
        list.innerHTML = '<div class="small muted">加载评论…</div>'
        void fetchCommentPage(selectedTopicId, 1)
      }
    } else {
      list.innerHTML = '<div class="small muted">加载评论…</div>'
    }
    return
  }
  list.innerHTML =
    st.items.map(commentHtml).join('') || '<div class="small muted">暂无评论</div>'
  if (st.page < st.pages) {
    list.insertAdjacentHTML(
      'beforeend',
      '<button class="btn sm" type="button" data-more-comments>加载更多评论</button>',
    )
    const more = list.querySelector('[data-more-comments]')
    more.onclick = async () => {
      more.disabled = true
      more.classList.add('is-busy')
      await fetchCommentPage(selectedTopicId, st.page + 1)
    }
  }
}

/** 选中左侧帖子 → 右栏显示它的评论；已拉取过的直接用缓存，不再发请求 */
function selectTopic(id, { scroll = false } = {}) {
  if (!id) return
  selectedTopicId = String(id)
  document.querySelectorAll('#zsxq-topic-list .zsxq-topic').forEach((c) => {
    c.classList.toggle('is-active', c.dataset.topic === selectedTopicId)
  })
  const st = commentState.get(selectedTopicId) ?? { page: 0, pages: 1, total: 0, items: [] }
  commentState.set(selectedTopicId, st)
  renderCommentPane()
  if (st.page === 0) void fetchCommentPage(selectedTopicId, 1)
  // 窄屏双栏堆叠成上下块时，选中后滚到评论面板，别让用户自己找
  if (scroll && window.matchMedia('(max-width: 900px)').matches) {
    document.getElementById('zsxq-comment-pane')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
}

/** 卡片上的评论数徽标随拉取结果更新 */
function updateTopicCount(id, total) {
  const badge = document.querySelector(
    `#zsxq-topic-list .zsxq-topic[data-topic="${esc(id)}"] .zsxq-count`,
  )
  if (badge) badge.textContent = `${total} 评论`
}

/** 拉一页评论进缓存并刷新右栏；ownerOnly 与列表同口径 */
async function fetchCommentPage(id, next) {
  const gen = renderGen
  const query = `page=${next}&pageSize=${COMMENT_PAGE_SIZE}${ownerOnly ? '&ownerOnly=1' : ''}`

  let data
  try {
    data = await api(`/api/zsxq/topics/${encodeURIComponent(id)}/comments?${query}`)
  } catch (err) {
    if (gen !== renderGen) return
    // 失败回退页码：再点「加载更多评论」可重试同一页；首屏失败在右栏给重试按钮
    const st = commentState.get(id)
    if (st && st.page >= next) st.page = next - 1
    if (st && next === 1) st.error = true
    const stillSelected = String(selectedTopicId) === String(id)
    if (stillSelected && next === 1) {
      renderCommentPane()
    } else {
      const more = document.querySelector('#zsxq-comment-list [data-more-comments]')
      if (more) {
        more.disabled = false
        more.classList.remove('is-busy')
      }
      toast(err?.message || '加载评论失败', true)
    }
    return
  }
  // 切页 / 重绘了：别往已经不在文档里的旧节点写
  if (gen !== renderGen) return

  const st = commentState.get(id) ?? { page: 0, pages: 1, total: 0, items: [] }
  st.page = next
  st.pages = Math.max(1, Number(data.pages) || 1)
  st.total = Number(data.total) || 0
  const comments = Array.isArray(data.comments) ? data.comments : []
  st.items = next === 1 ? comments : [...st.items, ...comments]
  commentState.set(id, st)
  updateTopicCount(id, st.total)
  if (String(selectedTopicId) === String(id)) renderCommentPane()
}

/**
 * 星主附件备份：循环调 POST /api/zsxq/backup，直到 remaining 归零 / 连续两批没有新成功 / 轮数上限。
 * 幂等靠服务端：附件按 fileId 落 R2、图片按 sha1 URL 落 R2，重复跑只会 skipped。
 * 切页或重绘（renderGen 变了）立即停手，参考 views/music.js 的补全循环。
 */
async function backupOwner(main) {
  if (backingUp) {
    toast('备份正在进行中…')
    return
  }
  backingUp = true
  const mine = renderGen
  const stop = () => !alive || mine !== renderGen
  let okFiles = 0
  let okImages = 0
  let failed = 0
  let stalls = 0

  try {
    for (let round = 0; round < BACKUP_MAX_ROUNDS; round++) {
      if (stop()) return
      const r = await api('/api/zsxq/backup', {
        method: 'POST',
        body: JSON.stringify({ files: BACKUP_FILES, images: BACKUP_IMAGES }),
        timeout: 120_000,
      })
      if (stop()) return

      const f = r?.files ?? {}
      const im = r?.images ?? {}
      const roundOk = (Number(f.ok) || 0) + (Number(im.ok) || 0)
      okFiles += Number(f.ok) || 0
      okImages += Number(im.ok) || 0
      failed += (Number(f.failed) || 0) + (Number(im.failed) || 0)
      const remaining = (Number(r?.remaining?.files) || 0) + (Number(r?.remaining?.images) || 0)

      toast(
        `备份中：文件 ${okFiles} 个 · 图片 ${okImages} 张${failed ? ` · 失败 ${failed}` : ''} · 剩余 ${remaining}`,
      )
      if (remaining <= 0) break
      if (roundOk === 0) {
        stalls += 1
        if (stalls >= 2) break
      } else {
        stalls = 0
      }
    }
    if (stop()) return
    toast(
      `备份完成：文件 ${okFiles} 个 · 图片 ${okImages} 张${
        failed ? ` · 失败 ${failed}（稍后可再点一次重试）` : ''
      }`,
      failed > 0,
    )
  } catch (err) {
    if (!stop()) toast(err?.message || '备份失败', true)
  } finally {
    backingUp = false
    if (!stop()) await rerender(render, main)
  }
}

/** 同步配置弹窗：token / 星球勾选 / 启用开关都是低频操作，页面只留一个入口 */
function openConfig(main, g, job) {
  // 只在首次打开时挂 close 监听（Esc / 点遮罩 / 路由切换都要复位状态）
  if (!configOpen) {
    configOpen = true
    const dlg = document.getElementById('dlg')
    const onClose = () => {
      dlg.removeEventListener('close', onClose)
      configOpen = false
    }
    dlg.addEventListener('close', onClose)
  }

  const groups = g.groups ?? []
  const selected = new Set(job.groupIds ?? [])
  const refreshing = g.refresh?.status === 'pending' || g.refresh?.status === 'leased'
  const groupChecks = groups
    .map(
      (x) => `<label class="check"><input type="checkbox" name="group" value="${esc(x.id)}" ${selected.has(x.id) ? 'checked' : ''}>
        <span>${esc(x.name || x.id)}</span><span class="small muted mono">${esc(x.id)}</span></label>`,
    )
    .join('')

  const { close, body } = showDialog(
    `<h2>同步配置</h2>
     <p class="small muted">token 存于 D1，只在本页维护；Worker 下发 zsxq_sync 任务时注入 payload，节点侧无需环境变量。</p>

     <label class="form-label" for="token">知识星球 token</label>
     <div class="flex wrap center">
       <input class="field field-sm" id="token" type="password" autocomplete="off" style="max-width: 320px"
              placeholder="${g.hasToken ? '已配置，留空不修改' : '粘贴知识星球 token'}"
              aria-label="知识星球 token">
       <button class="btn sm" id="save-token">保存 token</button>
       ${g.hasToken ? '<button class="btn sm warn" id="clear-token">清除</button>' : ''}
     </div>
     <p class="small muted mt-1">${g.hasToken ? 'token 已配置' : 'token 未配置'} · wx.zsxq.com 登录后从请求头取；附件下载与星主备份也用它</p>

     <div class="section-head" style="margin: var(--sp-4) 0 var(--sp-2)">
       <h3 class="section-title">同步星球</h3>
       <button class="btn sm" id="refresh-groups">${refreshing ? '正在拉取…' : '刷新星球列表'}</button>
     </div>
     ${
       groups.length
         ? `<div class="check-row" id="group-list" style="max-height: 220px; overflow: auto">${groupChecks}</div>`
         : `<div class="small muted" id="group-empty">${emptyGroupsHint(g)}</div>`
     }
     <label class="check mt-2"><input type="checkbox" id="sync-enabled" ${job.enabled ? 'checked' : ''}> 启用同步</label>
     <p class="small muted mt-1">每小时 20 分自动同步，保存后立刻排一轮。</p>
     <p class="small muted mt-1">历史回溯：${progressText(job.progress, groups)}</p>
     ${job.enabled && job.result ? `<p class="small muted">最近一次同步：${esc(String(job.result).slice(0, 160))}</p>` : ''}

     <div class="dlg-foot">
       <button class="btn sm" type="button" data-close>取消</button>
       <button class="btn sm primary" id="save-group">保存同步配置</button>
     </div>`,
    { label: '知识星球同步配置' },
  )

  body.querySelector('[data-close]').onclick = close
  body.querySelector('#refresh-groups').onclick = (e) => queueRefresh(main, e.currentTarget)

  // token 就地维护：保存后自动拉一次星球列表，操作连贯
  body.querySelector('#save-token').onclick = async () => {
    const btn = body.querySelector('#save-token')
    const input = body.querySelector('#token')
    const token = input.value.trim()
    if (!token) return toast('先粘贴知识星球 token', true)
    const res = await run(btn, () =>
      api('/api/zsxq/token', { method: 'POST', body: JSON.stringify({ token }) }),
    )
    if (!res.ok) return
    input.value = ''
    await queueRefresh(main, null, false, 'token 已保存，正在拉取星球列表…')
  }

  const clearToken = body.querySelector('#clear-token')
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

  body.querySelector('#save-group').onclick = async () => {
    const btn = body.querySelector('#save-group')
    const groupIds = [...body.querySelectorAll('#group-list input[name="group"]:checked')].map((i) => i.value)
    const enabled = body.querySelector('#sync-enabled').checked
    if (enabled && !groupIds.length) return toast('至少勾选一个要同步的星球', true)
    const res = await run(btn, () =>
      api('/api/zsxq/job', { method: 'POST', body: JSON.stringify({ groupIds, enabled }) }),
    )
    if (!res.ok) return
    toast(enabled ? '已保存：节点下次轮询即同步' : '已保存：同步任务已停用')
    // 先复位再关：close 事件是异步派发的，别让紧接着的重绘又把弹窗打开
    configOpen = false
    close()
    await rerender(render, main)
  }
}

/** 请求节点拉一次星球列表（token 由 Worker 下发时注入） */
async function queueRefresh(main, btn, auto = false, message = auto ? '正在拉取星球列表…' : '已请求节点拉取星球列表') {
  const res = await run(btn, () => api('/api/zsxq/groups/refresh', { method: 'POST' }))
  if (!res.ok) return
  if (auto) {
    const hint = document.getElementById('group-empty')
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
      if (g.groups?.length) toast(`已获取 ${g.groups.length} 个星球：点「同步配置」勾选后保存`)
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
  configOpen = false
  alive = false
  renderGen += 1
  resetSelection()
  lastTopics = []
  closeMoreMenu()
}
