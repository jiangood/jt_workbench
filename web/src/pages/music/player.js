import {UrlUtils} from '@jiangood/open-admin'

/**
 * 音乐播放器单例（对应旧 SPA 的 lib.js player）。
 *
 * <audio> 与状态挂在模块级而非组件内：切换菜单 / 重绘页面时组件会卸载，
 * 但 audio 元素常驻 document.body，音乐不中断。队列 / 模式持久化到 localStorage。
 */

const QUEUE_KEY = 'wb-player'
const LIST_CACHE_KEY = 'wb-music-list'

/** 播放模式：顺序（播完即停）→ 列表循环 → 单曲循环 → 随机 */
export const PLAY_MODES = [
    {key: 'order', label: '顺序播放', icon: 'order'},
    {key: 'list', label: '列表循环', icon: 'repeat'},
    {key: 'one', label: '单曲循环', icon: 'repeatOne'},
    {key: 'shuffle', label: '随机播放', icon: 'shuffle'},
]

const listeners = new Set()
let queue = []
let index = -1
let modeKey = 'order'
let playerReady = false

/** 复用页面里唯一的 <audio>；不存在则建一个挂到 body（常驻） */
function audioEl() {
    let el = document.getElementById('player')
    if (!el) {
        el = document.createElement('audio')
        el.id = 'player'
        el.preload = 'metadata'
        document.body.appendChild(el)
    }
    return el
}

const modeDef = (key = modeKey) => PLAY_MODES.find(m => m.key === key) || PLAY_MODES[0]

function notify() {
    listeners.forEach(fn => {
        try { fn() } catch { /* 单个订阅者出错不影响其他 */ }
    })
}

function persist() {
    try {
        localStorage.setItem(QUEUE_KEY, JSON.stringify({mode: modeKey, index, queue}))
    } catch { /* 隐私模式 / 配额满：忽略 */ }
}

function readPersisted() {
    try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || 'null') } catch { return null }
}

export function readListCache() {
    try {
        const list = JSON.parse(localStorage.getItem(LIST_CACHE_KEY) || 'null')
        return Array.isArray(list) ? list : null
    } catch { return null }
}

export function writeListCache(list) {
    try { localStorage.setItem(LIST_CACHE_KEY, JSON.stringify(list)) } catch { /* 忽略 */ }
}

export function fmtDuration(seconds) {
    const s = Math.round(Number(seconds))
    if (!Number.isFinite(s) || s <= 0) return ''
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** 统一队列条目结构（后端 id 为字符串 UUID） */
function normalizeTrack(t) {
    if (t?.id == null) return null
    const d = Number(t.duration)
    return {
        id: String(t.id),
        title: String(t.title || t.filename || '未命名曲目'),
        artist: String(t.artist || ''),
        duration: Number.isFinite(d) && d > 0 ? d : null,
        format: String(t.format || ''),
    }
}

/** 播放地址：走后端流式接口（支持 Range），带时间戳避免浏览器缓存旧文件 */
function playUrl(t) {
    return UrlUtils.contextPath(`/admin/music/audio/${encodeURIComponent(t.id)}?t=${encodeURIComponent(t.id)}`)
}

function playIndex(i, {autoplay = true} = {}) {
    if (i < 0 || i >= queue.length) return
    const audio = audioEl()
    index = i
    const t = queue[i]
    if (audio.getAttribute('src') !== playUrl(t)) audio.src = playUrl(t)
    if (autoplay) audio.play().catch(() => {})
    persist()
    notify()
}

/** nextTrack(auto=true 表示自然播完：单曲循环重放、顺序播放末尾停住） */
function nextTrack(auto = false) {
    if (!queue.length) return
    if (modeKey === 'one' && auto) return playIndex(index)
    if (modeKey === 'shuffle') {
        if (queue.length === 1) return playIndex(0)
        let n = index
        while (n === index) n = Math.floor(Math.random() * queue.length)
        return playIndex(n)
    }
    if (index + 1 < queue.length) return playIndex(index + 1)
    if (modeKey === 'list' || !auto) return playIndex(0)
    // 顺序播放到末尾：停在最后一首
}

function prevTrack() {
    if (!queue.length) return
    const audio = audioEl()
    if (audio && audio.currentTime > 3) {
        audio.currentTime = 0
        if (audio.paused) audio.play().catch(() => {})
        return
    }
    if (index > 0) playIndex(index - 1)
    else playIndex(modeKey === 'list' ? queue.length - 1 : 0)
}

function stopPlayback() {
    const audio = audioEl()
    if (audio) {
        audio.pause()
        audio.removeAttribute('src')
        audio.load()
    }
    queue = []
    index = -1
    persist()
    notify()
}

function removeAt(i) {
    if (i < 0 || i >= queue.length) return
    const wasCurrent = i === index
    queue.splice(i, 1)
    if (!queue.length) return stopPlayback()
    if (i < index) index--
    else if (wasCurrent) index = Math.min(index, queue.length - 1)
    persist()
    notify()
    if (wasCurrent) playIndex(index)
}

/** 追加到播放列表；队列空时直接开播。返回 'added' | 'exists' | 'playing' | 'invalid' */
function enqueue(track) {
    const t = normalizeTrack(track)
    if (!t) return 'invalid'
    if (queue.some(x => x.id === t.id)) return 'exists'
    if (index < 0) {
        queue = [t]
        playIndex(0)
        return 'playing'
    }
    queue.push(t)
    persist()
    notify()
    return 'added'
}

function playQueue(tracks, startAt = 0, opts = {}) {
    const list = (tracks || []).map(normalizeTrack).filter(Boolean)
    if (!list.length) return
    if (opts.mode && PLAY_MODES.some(m => m.key === opts.mode)) modeKey = opts.mode
    queue = list
    const start = opts.random ? Math.floor(Math.random() * list.length) : startAt
    playIndex(Math.min(Math.max(start, 0), list.length - 1))
}

function setMode(key) {
    if (!PLAY_MODES.some(m => m.key === key)) return
    modeKey = key
    persist()
    notify()
}

function cycleMode() {
    const i = PLAY_MODES.findIndex(m => m.key === modeKey)
    setMode(PLAY_MODES[(i + 1) % PLAY_MODES.length].key)
}

function updateTrack(id, patch) {
    const target = String(id)
    let changed = false
    queue = queue.map(t => {
        if (t.id !== target) return t
        changed = true
        return normalizeTrack({...t, ...patch}) || t
    })
    if (!changed) return
    persist()
    notify()
}

/** 列表刷新后给队列补元数据（时长），标题 / 艺术家不覆盖（用户可能手改过） */
function syncMeta(list) {
    const fresh = new Map()
    for (const t of list || []) {
        const n = normalizeTrack(t)
        if (n) fresh.set(n.id, n)
    }
    if (!fresh.size || !queue.length) return
    let changed = false
    queue = queue.map(t => {
        const f = fresh.get(t.id)
        if (!f) return t
        const duration = f.duration ?? t.duration
        if (duration === t.duration) return t
        changed = true
        return {...t, duration}
    })
    if (!changed) return
    persist()
    notify()
}

/** 初始化：绑全局 audio 事件 + 恢复上次队列（不自动播放） */
export function initPlayer() {
    if (playerReady) return
    playerReady = true
    const audio = audioEl()
    audio.addEventListener('ended', () => nextTrack(true))
    audio.addEventListener('play', notify)
    audio.addEventListener('pause', notify)
    audio.addEventListener('error', () => notify())

    const saved = readPersisted()
    if (saved && Array.isArray(saved.queue) && saved.queue.length) {
        queue = saved.queue.map(normalizeTrack).filter(Boolean)
        if (PLAY_MODES.some(m => m.key === saved.mode)) modeKey = saved.mode
        index = Number.isInteger(saved.index) && saved.index >= 0 && saved.index < queue.length ? saved.index : 0
        const t = queue[index]
        if (t) {
            audio.src = playUrl(t)
            audio.dataset.id = String(t.id)
        }
    }
    notify()
}

export const player = {
    get currentId() { return index >= 0 && queue[index] ? queue[index].id : null },
    get queue() { return queue.slice() },
    get index() { return index },
    get mode() { return modeKey },
    get modeLabel() { return modeDef().label },
    get current() { return index >= 0 && queue[index] ? queue[index] : null },
    get isPlaying() {
        const a = audioEl()
        return !!a && !!a.dataset.id && !a.paused && !a.ended
    },
    get audio() { return audioEl() },
    resume() {
        const a = audioEl()
        if (a.getAttribute('src')) a.play().catch(() => {})
    },
    pause() { audioEl()?.pause() },
    toggle() {
        if (this.isPlaying) this.pause()
        else this.resume()
    },
    play(id, tracks) {
        const pos = queue.findIndex(t => t.id === String(id))
        if (pos >= 0) return playIndex(pos)
        // 没在队列里：用传入列表或单曲队列替换
        if (Array.isArray(tracks) && tracks.length) return playQueue(tracks, Math.max(tracks.findIndex(t => String(t.id) === String(id)), 0))
        const t = normalizeTrack({id})
        if (t) { queue = [t]; playIndex(0) }
    },
    playQueue,
    enqueue,
    next() { nextTrack(false) },
    prev: prevTrack,
    setMode,
    cycleMode,
    removeAt,
    updateTrack,
    syncMeta,
    stop: stopPlayback,
    onChange(fn) {
        listeners.add(fn)
        return () => listeners.delete(fn)
    },
}
