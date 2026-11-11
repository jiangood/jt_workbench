/**
 * 多文件上传队列：面板挂在 shell（index.html #uploads），切页继续传、面板常驻。
 *
 * 为什么不用 fetch：fetch 没有上传进度事件（xhr.upload.onprogress 才有）；
 * fetch + ReadableStream + duplex:'half' 在 Safari 不可用。
 *
 * 语义（已定）：
 * - 严格串行：任意时刻只有一个 XHR 在跑，其余显示排队位次。
 * - 面板一律手动关闭：还有排队 / 在传项时关闭按钮 disabled，另给「取消全部」。
 * - 失败不逐条 toast，整批结束由调用方 onSettled 汇总一次。
 * - 队列状态机：queued → preparing(可选) → uploading → processing → done/failed/canceled
 *   processing 是必需的：书架上传落库后还要同步豆瓣，只显示字节进度会像卡死。
 */

import { icon } from './lib.js'

/** Workers 免费版请求体上限：超了必然失败，不如本地直接标红 */
const MAX_SIZE = 100 * 1024 * 1024
/** 传输停滞判定：这么久没有新字节就提示「网络卡住」 */
const STALL_MS = 60_000

let seq = 0
let active = null
let panel = null
let raf = 0
let stallTimer = 0
/** 当前面板里的所有行（含已结束、等待用户手动关闭的） */
const items = []

const PENDING = new Set(['queued', 'preparing', 'uploading', 'processing'])
const isPending = (item) => PENDING.has(item.state)

/* ---------------- 格式化 ---------------- */

function fmtBytes(n) {
  if (!n) return '0 B'
  if (n < 1024) return `${n} B`
  if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1048576).toFixed(1)} MB`
}

/** ETA：跑满 1s 且已推进 >1% 才算，否则数字闪得慌 */
function etaText(item) {
  if (!item.startedAt || !item.total) return ''
  const elapsed = (performance.now() - item.startedAt) / 1000
  if (elapsed < 1 || item.loaded / item.total < 0.01) return ''
  const rate = item.loaded / elapsed
  if (!rate) return ''
  const left = (item.total - item.loaded) / rate
  if (!Number.isFinite(left) || left <= 0) return ''
  return left >= 60 ? ` · 剩 ${Math.ceil(left / 60)} 分` : ` · 剩 ${Math.ceil(left)} 秒`
}

/* ---------------- 面板骨架 ---------------- */

function ensurePanel() {
  if (panel) return panel
  const root = document.getElementById('uploads')
  if (!root) return null
  panel = {
    root,
    title: root.querySelector('#up-title'),
    list: root.querySelector('#up-list'),
    cancel: root.querySelector('#up-cancel'),
    close: root.querySelector('#up-close'),
    toggle: root.querySelector('#up-toggle'),
    live: root.querySelector('#up-live'),
    nodes: new Map(),
  }

  panel.cancel.onclick = () => cancelAll()
  panel.close.onclick = () => {
    if (hasPending()) return
    hide()
  }
  panel.toggle.onclick = () => {
    const collapsed = root.dataset.collapsed !== '1'
    setCollapsed(collapsed)
  }
  panel.list.onclick = (e) => {
    const retry = e.target.closest('[data-retry]')
    if (retry) return retryItem(Number(retry.dataset.retry))
    const cancel = e.target.closest('[data-cancel]')
    if (cancel) return cancelItem(Number(cancel.dataset.cancel))
    const drop = e.target.closest('[data-drop]')
    if (drop) return dropItem(Number(drop.dataset.drop))
  }
  return panel
}

/** app.js 启动时调一次：把 shell 里的面板接上线（重复调用无副作用） */
export function initUploads() {
  ensurePanel()
}

function setCollapsed(collapsed) {
  if (!panel) return
  panel.root.dataset.collapsed = collapsed ? '1' : '0'
  panel.toggle.setAttribute('aria-expanded', String(!collapsed))
  panel.toggle.setAttribute('aria-label', collapsed ? '展开上传列表' : '收起上传列表')
}

function hasPending() {
  return items.some(isPending)
}

/* ---------------- 队列 ---------------- */

/**
 * 入队一批文件。opts：
 * - title            面板标题（如「上传音乐」）
 * - url(qs, file)    生成上传地址；qs 已含 filename / params / prepare 的返回值
 * - params           本批固定查询参数（bookId / noteId / category …）
 * - prepare(file)    可选，上传前的浏览器端解析（epub OPF / audio tag），返回额外查询参数
 * - contentType(file) 可选，缺省用 file.type
 * - processingLabel  可选，「处理中」那一段的文案（书架用「匹配豆瓣信息…」）
 * - validate(file)   可选，返回错误文案则直接标红、不发请求
 * - onSettled(summary) 本批全部结束（或全部取消）后回调，summary = { total, ok, failed, canceled }
 */
export function enqueue(files, opts = {}) {
  const list = [...files]
  if (!list.length) return null
  const ui = ensurePanel()
  if (!ui) return null

  purgeSettled()

  const batch = { opts, total: list.length, pending: 0, ok: 0, failed: 0, canceled: 0 }
  for (const file of list) {
    const item = {
      id: ++seq,
      file,
      state: 'queued',
      loaded: 0,
      total: file.size,
      error: '',
      stalled: false,
      settled: false,
      prepared: {},
      startedAt: 0,
      lastTick: 0,
      xhr: null,
      batch,
      opts,
    }
    const bad = opts.validate?.(file) || precheck(file)
    if (bad) {
      item.state = 'failed'
      item.error = bad
      item.settled = true
      batch.failed += 1
    } else {
      batch.pending += 1
    }
    items.push(item)
  }

  ui.root.hidden = false
  setCollapsed(matchMedia('(max-width: 640px)').matches)
  ui.live.textContent = `${opts.title || '上传'}：开始 ${list.length} 个文件`
  startStallWatch()
  paint()
  pump()

  // 全部倒在校验上：没有请求要发，也要正常收尾
  if (!batch.pending) batch.opts.onSettled?.({ total: batch.total, ok: 0, failed: batch.failed, canceled: 0 })
  return batch
}

function precheck(file) {
  if (!file.size) return '空文件（0 字节）'
  if (file.size > MAX_SIZE) return `超过 100 MB 上限（${fmtBytes(file.size)}）`
  return null
}

/** 去掉上一批的已结束行：新批次入队时先清，避免「这批完成数」对不上 */
function purgeSettled() {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i]
    if (isPending(item)) continue
    items.splice(i, 1)
    panel?.nodes.get(item.id)?.row.remove()
    panel?.nodes.delete(item.id)
  }
}

function pump() {
  if (active) return
  const next = items.find((item) => item.state === 'queued')
  if (!next) {
    stopStallWatchIfIdle()
    paint()
    return
  }
  active = next
  void runItem(next)
}

async function runItem(item) {
  try {
    if (item.opts.prepare) {
      setState(item, 'preparing')
      let extra = {}
      try {
        extra = (await item.opts.prepare(item.file)) || {}
      } catch {
        /* 解析失败就用文件名兜底，不挡上传 */
      }
      if (item.state !== 'preparing') return // 解析期间被取消
      item.prepared = extra
    }
    if (item.state === 'canceled') return
    await send(item)
  } finally {
    active = null
    paint()
    pump()
  }
}

function send(item) {
  return new Promise((resolve) => {
    const { opts, file } = item
    const qs = new URLSearchParams()
    for (const [key, value] of Object.entries({ ...opts.params, ...item.prepared })) {
      if (value !== null && value !== undefined && value !== '') qs.set(key, String(value))
    }
    qs.set('filename', file.name)

    let url
    try {
      url = opts.url(qs, file)
    } catch (err) {
      complete(item, 'failed', err?.message || '上传参数有误')
      return resolve()
    }

    const xhr = new XMLHttpRequest()
    item.xhr = xhr
    item.loaded = 0
    item.total = file.size
    item.startedAt = performance.now()
    item.lastTick = item.startedAt
    setState(item, 'uploading')

    xhr.open('POST', url)
    xhr.setRequestHeader('content-type', opts.contentType?.(file) || file.type || 'application/octet-stream')
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return
      item.loaded = e.loaded
      item.total = e.total || file.size
      item.lastTick = performance.now()
      item.stalled = false
      paint()
    }
    // 字节发完到响应回来之间是服务端处理（书架还要同步豆瓣），单独一个态
    xhr.upload.onload = () => {
      if (item.state === 'uploading') setState(item, 'processing')
    }
    xhr.onload = () => {
      let env = null
      try {
        env = JSON.parse(xhr.responseText)
      } catch {
        env = null
      }
      if (xhr.status === 401) {
        location.href = '/login'
        complete(item, 'failed', '登录已过期')
      } else if (xhr.status >= 200 && xhr.status < 300 && (!env || env.code === 0)) {
        complete(item, 'done')
      } else {
        complete(item, 'failed', env?.message || `上传失败（HTTP ${xhr.status}）`)
      }
      resolve()
    }
    xhr.onerror = () => {
      complete(item, 'failed', '网络错误，请检查连接')
      resolve()
    }
    xhr.onabort = () => {
      complete(item, 'canceled')
      resolve()
    }
    try {
      xhr.send(file)
    } catch (err) {
      complete(item, 'failed', err?.message || '无法发起上传')
      resolve()
    }
  })
}

function setState(item, state) {
  if (item.settled) return
  item.state = state
  paint()
}

/** 单项落定（幂等：取消与 abort 可能先后触发） */
function complete(item, state, error) {
  if (item.settled) return
  item.settled = true
  item.state = state
  if (error) item.error = error
  item.xhr = null

  const batch = item.batch
  batch.pending -= 1
  if (state === 'done') batch.ok += 1
  else if (state === 'canceled') batch.canceled += 1
  else batch.failed += 1

  paint()
  if (batch.pending === 0) {
    stopStallWatchIfIdle()
    if (panel) {
      panel.live.textContent = !batch.failed
        ? `上传结束：${batch.ok} 个文件已上传`
        : `上传结束：${batch.ok} 个成功，${batch.failed} 个失败`
    }
    batch.opts.onSettled?.({ total: batch.total, ok: batch.ok, failed: batch.failed, canceled: batch.canceled })
  }
}

/* ---------------- 取消 / 重试 / 清理 ---------------- */

function cancelItem(id) {
  const item = items.find((row) => row.id === id)
  if (!item || !isPending(item)) return
  if (item.state === 'uploading' && item.xhr) {
    item.xhr.abort() // 流式写入 R2，请求中断即不落地
    return
  }
  // processing：字节已经发完，服务端可能正在落库，不提供取消（按钮也不显示）
  complete(item, 'canceled')
  paint()
  if (!active) pump()
}

export function cancelAll() {
  for (const item of [...items]) {
    // processing：字节已发完、服务端可能正在落库，中断也没用，等它自己结束
    if (!isPending(item) || item.state === 'processing') continue
    if (item.state === 'uploading' && item.xhr) item.xhr.abort()
    else complete(item, 'canceled')
  }
  paint()
  if (!active) pump()
}

function retryItem(id) {
  const item = items.find((row) => row.id === id)
  if (!item || item.state !== 'failed') return
  item.state = 'queued'
  item.settled = false
  item.error = ''
  item.stalled = false
  item.loaded = 0
  item.prepared = {}
  item.startedAt = 0
  item.xhr = null
  item.batch.pending += 1
  item.batch.failed -= 1
  startStallWatch()
  paint()
  pump()
}

function dropItem(id) {
  const i = items.findIndex((row) => row.id === id)
  if (i < 0 || isPending(items[i])) return
  const [item] = items.splice(i, 1)
  panel?.nodes.get(item.id)?.row.remove()
  panel?.nodes.delete(item.id)
  paint()
}

function hide() {
  const ui = ensurePanel()
  if (!ui) return
  ui.root.hidden = true
  setCollapsed(false)
  items.length = 0
  for (const rec of ui.nodes.values()) rec.row.remove()
  ui.nodes.clear()
  stopStallWatch()
}

/* ---------------- 传输停滞 ---------------- */

function startStallWatch() {
  if (stallTimer) return
  stallTimer = setInterval(() => {
    let dirty = false
    for (const item of items) {
      if (item.state !== 'uploading' || item.stalled) continue
      if (item.lastTick && performance.now() - item.lastTick > STALL_MS) {
        item.stalled = true
        dirty = true
      }
    }
    if (dirty) paint()
  }, 5000)
}

function stopStallWatchIfIdle() {
  if (hasPending()) return
  stopStallWatch()
}

function stopStallWatch() {
  clearInterval(stallTimer)
  stallTimer = 0
}

/* ---------------- 渲染（按行复用节点，只改进度条宽度和文字） ---------------- */

function paint() {
  if (!panel || raf) return
  raf = requestAnimationFrame(() => {
    raf = 0
    paintNow()
  })
}

function rowFor(item) {
  const ui = ensurePanel()
  let rec = ui.nodes.get(item.id)
  if (rec) return rec

  const row = document.createElement('li')
  row.className = 'up-row'
  row.dataset.id = String(item.id)
  row.innerHTML = `
    <div class="up-line">
      <span class="up-name"></span>
      <span class="up-meta"></span>
      <span class="up-acts"></span>
    </div>
    <div class="up-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><i></i></div>`
  row.querySelector('.up-name').textContent = item.file.name
  row.querySelector('.up-bar').setAttribute('aria-label', `${item.file.name} 上传进度`)

  rec = {
    row,
    meta: row.querySelector('.up-meta'),
    acts: row.querySelector('.up-acts'),
    bar: row.querySelector('.up-bar'),
    fill: row.querySelector('.up-bar > i'),
    state: '',
  }
  ui.nodes.set(item.id, rec)
  ui.list.append(row)
  return rec
}

function paintNow() {
  const ui = ensurePanel()
  if (!ui) return
  // 行被用户逐条移除后没东西可显示了：直接收起面板，别留个空壳
  if (!items.length) {
    hide()
    return
  }

  const pending = hasPending()
  const done = items.filter((i) => i.state === 'done').length
  const failed = items.filter((i) => i.state === 'failed').length
  const totalBytes = items.reduce((n, i) => n + (i.file.size || 0), 0)
  const sentBytes = items.reduce((n, i) => n + Math.min(i.loaded || 0, i.file.size || 0), 0)

  if (pending) {
    ui.title.textContent = `上传中 ${done}/${items.length} · ${fmtBytes(sentBytes)} / ${fmtBytes(totalBytes)}`
  } else if (failed) {
    ui.title.textContent = `已结束：${done} 个成功，${failed} 个失败`
  } else if (done) {
    ui.title.textContent = `已上传 ${done} 个文件`
  } else {
    ui.title.textContent = '已取消上传'
  }

  ui.cancel.hidden = !pending
  ui.close.disabled = pending
  ui.close.title = pending ? '上传中无法关闭' : '关闭上传面板'

  for (const item of items) {
    const rec = rowFor(item)
    rec.row.dataset.state = item.state
    const pct = item.total ? Math.min(100, Math.round((item.loaded / item.total) * 100)) : 0

    rec.meta.textContent = metaText(item, pct)
    rec.meta.classList.toggle('danger-text', item.state === 'failed')

    rec.bar.classList.toggle('is-indeterminate', item.state === 'preparing' || item.state === 'processing')
    rec.bar.classList.toggle('is-done', item.state === 'done')
    if (item.state === 'uploading') {
      rec.bar.setAttribute('aria-valuenow', String(pct))
      rec.bar.removeAttribute('aria-valuetext')
      rec.fill.style.width = `${pct}%`
    } else if (item.state === 'preparing' || item.state === 'processing') {
      rec.bar.removeAttribute('aria-valuenow')
      rec.bar.setAttribute('aria-valuetext', item.state === 'preparing' ? '解析中' : '服务端处理中')
      rec.fill.style.width = '40%'
    } else if (item.state === 'done') {
      rec.bar.setAttribute('aria-valuenow', '100')
      rec.bar.removeAttribute('aria-valuetext')
      rec.fill.style.width = '100%'
    } else {
      rec.fill.style.width = `${pct}%`
    }

    // 按钮只在状态变化时重建，避免每帧塞 innerHTML
    if (rec.state !== item.state) {
      rec.state = item.state
      rec.acts.innerHTML = actsHtml(item)
    }
  }
}

function metaText(item, pct) {
  switch (item.state) {
    case 'queued': {
      const pos = items.filter((i) => i.state === 'queued').indexOf(item) + 1
      return pos > 0 ? `排队 · 第 ${pos} 位` : '排队中'
    }
    case 'preparing':
      return '解析中…'
    case 'uploading':
      return item.stalled
        ? '网络卡住，可取消'
        : `${pct}% · ${fmtBytes(item.loaded)}/${fmtBytes(item.file.size)}${etaText(item)}`
    case 'processing':
      return item.opts.processingLabel || '处理中…'
    case 'done':
      return `${fmtBytes(item.file.size)} · 已完成`
    case 'failed':
      return item.error || '失败'
    default:
      return '已取消'
  }
}

function actsHtml(item) {
  const name = item.file.name
  if (item.state === 'failed') {
    return `<button class="btn sm" type="button" data-retry="${item.id}">重试</button>
      <button class="icon-btn up-x" type="button" data-drop="${item.id}" aria-label="移除 ${name}">${icon('close', 14)}</button>`
  }
  if (item.state === 'processing') return ''
  if (isPending(item)) {
    return `<button class="icon-btn up-x" type="button" data-cancel="${item.id}" aria-label="取消 ${name}">${icon('close', 14)}</button>`
  }
  if (item.state === 'done') return `<span class="up-check" aria-hidden="true">✓</span>`
  return `<button class="icon-btn up-x" type="button" data-drop="${item.id}" aria-label="移除 ${name}">${icon('close', 14)}</button>`
}
