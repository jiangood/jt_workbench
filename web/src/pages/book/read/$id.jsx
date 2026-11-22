import React from 'react'
import {Button, Drawer, Dropdown, Empty, Modal, Segmented, Select, Spin, Tooltip, message} from 'antd'
import {
    ArrowLeftOutlined,
    BgColorsOutlined,
    CaretRightOutlined,
    CompressOutlined,
    DeleteOutlined,
    ExpandOutlined,
    FontSizeOutlined,
    MenuOutlined,
    MoreOutlined,
    PauseOutlined,
    SoundOutlined,
    StepBackwardOutlined,
    StepForwardOutlined,
} from '@ant-design/icons'
import ePub from 'epubjs'
import {HttpClient, UrlUtils, history} from '@jiangood/open-admin'
import './reader.css'

export const pageMeta = {layout: 'blank', title: '阅读'}

/* ---------------- 偏好 / 常量 ---------------- */

const PREFS_KEY = 'book:reader:prefs'
const POS_PREFIX = 'book:reader:pos:'
const TTS_SPEED_KEY = 'book:reader:ttsSpeed'
const TTS_MAX_CHARS = 500

const THEMES = {
    paper: {
        label: '白', bg: '#ffffff', fg: '#1f1f1f', sub: '#8c8c8c', border: '#ededed', panel: '#ffffff',
        epub: {},
    },
    sepia: {
        label: '米黄', bg: '#f6f0e0', fg: '#38301f', sub: '#8a7d60', border: '#e4dcc6', panel: '#faf5e6',
        epub: {color: '#38301f', background: '#f6f0e0'},
    },
    green: {
        label: '护眼', bg: '#dfe9da', fg: '#23321f', sub: '#6d7d66', border: '#cbd8c4', panel: '#e7efe2',
        epub: {color: '#23321f', background: '#dfe9da'},
    },
    dark: {
        label: '夜间', bg: '#1c1c1d', fg: '#d0d3d8', sub: '#8a8d92', border: '#2c2c2e', panel: '#242426',
        epub: {color: '#d0d3d8', background: '#1c1c1d'},
    },
}

const FONT_OPTIONS = [
    {value: 'default', label: '默认'},
    {value: 'serif', label: '衬线'},
    {value: 'sans', label: '无衬线'},
]

const WEIGHT_OPTIONS = [
    {value: 400, label: '常规'},
    {value: 500, label: '中等'},
    {value: 600, label: '加粗'},
]

const WIDTH_OPTIONS = [
    {value: 640, label: '窄'},
    {value: 800, label: '标准'},
    {value: 1000, label: '宽'},
]

const MODE_OPTIONS = [
    {value: 'paged', label: '分页'},
    {value: 'scroll', label: '滚动'},
]

const AUTO_OPTIONS = [
    {value: 0, label: '关闭'},
    {value: 10, label: '10 秒'},
    {value: 20, label: '20 秒'},
    {value: 30, label: '30 秒'},
    {value: 60, label: '60 秒'},
]

const FONT_STACKS = {
    default: '',
    serif: '"Songti SC", "Source Han Serif SC", "Noto Serif CJK SC", "Noto Serif SC", SimSun, Georgia, serif',
    sans: '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Arial, sans-serif',
}

const DEFAULT_PREFS = {
    theme: 'sepia',
    size: 21,
    family: 'default',
    weight: 400,
    width: 800,
    mode: 'paged',
}

function readStorage(key) {
    try {
        return localStorage.getItem(key)
    } catch {
        return null
    }
}

function writeStorage(key, value) {
    try {
        localStorage.setItem(key, value)
    } catch {
        /* 隐私模式 / 配额满：只影响记忆，不影响阅读 */
    }
}

function loadPrefs() {
    try {
        const raw = JSON.parse(readStorage(PREFS_KEY) || 'null')
        if (!raw || typeof raw !== 'object') return {...DEFAULT_PREFS}
        return {
            ...DEFAULT_PREFS,
            ...raw,
            theme: THEMES[raw.theme] ? raw.theme : DEFAULT_PREFS.theme,
            size: Math.max(14, Math.min(28, Number(raw.size) || DEFAULT_PREFS.size)),
            weight: [400, 500, 600].includes(Number(raw.weight)) ? Number(raw.weight) : 400,
            width: [640, 800, 1000].includes(Number(raw.width)) ? Number(raw.width) : 800,
            mode: raw.mode === 'scroll' ? 'scroll' : 'paged',
        }
    } catch {
        return {...DEFAULT_PREFS}
    }
}

function savePrefs(prefs) {
    writeStorage(PREFS_KEY, JSON.stringify(prefs))
}

/** 阅读位置本地兜底：{v: 文件版本, cfi} */
function readLocalPosition(id) {
    try {
        return JSON.parse(readStorage(POS_PREFIX + id) || 'null')
    } catch {
        return null
    }
}

function writeLocalPosition(id, value) {
    writeStorage(POS_PREFIX + id, JSON.stringify(value))
}

/** 文件版本：优先取旧约定 key 里的 uuid（换文件才变），否则退回整条 key */
function fileVersion(book) {
    const key = String(book?.r2Key || '')
    const m = key.match(/book\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\//)
    if (m) return m[1]
    return key || `book-${book?.id || ''}-${book?.size || 0}`
}

function flattenToc(items, depth = 0, out = []) {
    for (const item of items || []) {
        const label = String(item?.label ?? '').replace(/\s+/g, ' ').trim()
        if (label && item?.href) out.push({label, href: item.href, depth})
        if (item?.subitems?.length) flattenToc(item.subitems, depth + 1, out)
    }
    return out
}

function fmtSize(bytes) {
    if (!bytes) return '0 KB'
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** 将路径按段编码，保留分隔符 `/` */
function encodePathSegments(path) {
    return String(path || '').split('/').map(encodeURIComponent).join('/')
}

function postJson(path, body) {
    return fetch(UrlUtils.contextPath('/' + path), {
        method: 'POST',
        credentials: 'include',
        keepalive: true,
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(body),
    }).catch(() => null)
}

async function fetchJson(path) {
    try {
        const res = await fetch(UrlUtils.contextPath('/' + path), {credentials: 'include'})
        if (!res.ok) return null
        const type = res.headers.get('content-type') || ''
        if (!type.includes('json')) return null
        return await res.json()
    } catch {
        return null
    }
}

/** 节流上报：相同值不重复发，攒 wait 毫秒再发，离页时 flush */
function createReporter(send, wait, same = (a, b) => a === b) {
    let last
    let pending
    let timer = 0
    const flush = () => {
        if (timer) {
            clearTimeout(timer)
            timer = 0
        }
        if (pending === undefined) return
        const value = pending
        pending = undefined
        if (last !== undefined && same(value, last)) return
        last = value
        send(value)
    }
    return {
        report(value) {
            if (value === undefined || value === null) return
            if (pending !== undefined && same(value, pending)) return
            pending = value
            if (!timer) timer = window.setTimeout(flush, wait)
        },
        flush,
    }
}

/* ---------------- 阅读设置弹窗（Drawer） ---------------- */

function SettingRow({label, children}) {
    return <div className='reader-setting'>
        <span className='reader-setting-label'>{label}</span>
        <div className='reader-setting-body'>{children}</div>
    </div>
}

/* ---------------- 阅读页 ---------------- */

export default function BookReader({params}) {
    const id = params?.id

    const [book, setBook] = React.useState(null)
    const [error, setError] = React.useState('')
    const [loading, setLoading] = React.useState(true)
    const [loadingText, setLoadingText] = React.useState('正在加载书目…')
    const [loadPct, setLoadPct] = React.useState(0)
    const [ready, setReady] = React.useState(false)

    const [prefs, setPrefs] = React.useState(loadPrefs)
    const [chapter, setChapter] = React.useState('')
    const [progress, setProgress] = React.useState(0)
    const [toc, setToc] = React.useState([])
    const [tocCurrent, setTocCurrent] = React.useState(-1)
    const [tocOpen, setTocOpen] = React.useState(false)
    const [settingsOpen, setSettingsOpen] = React.useState(false)
    const [immersive, setImmersive] = React.useState(false)
    const [autoSec, setAutoSec] = React.useState(0)

    const [ttsOpen, setTtsOpen] = React.useState(false)
    const [ttsPreparing, setTtsPreparing] = React.useState(false)
    const [ttsPlaying, setTtsPlaying] = React.useState(false)
    const [ttsSegments, setTtsSegments] = React.useState([])
    const [ttsIndex, setTtsIndex] = React.useState(0)
    const [ttsStatus, setTtsStatus] = React.useState('未开始')
    const [ttsSpeed, setTtsSpeed] = React.useState(() => {
        const v = Number(readStorage(TTS_SPEED_KEY) || readStorage('book:reader:ttsRate'))
        return Number.isFinite(v) && v > 0 ? v : 1
    })

    const viewRef = React.useRef(null)
    const renditionRef = React.useRef(null)
    const epubRef = React.useRef(null)
    const lastLocRef = React.useRef(null)
    const currentSectionRef = React.useRef({index: -1, href: ''})
    const locationsReadyRef = React.useRef(false)
    const totalSectionsRef = React.useRef(0)
    const prefsRef = React.useRef(prefs)
    const uiOpenRef = React.useRef(false)
    const reportersRef = React.useRef(null)
    const ttsSpeedRef = React.useRef(ttsSpeed)
    const ttsSegmentsRef = React.useRef([])
    const ttsIndexRef = React.useRef(0)
    const ttsChapterRef = React.useRef(null)
    const ttsSessionRef = React.useRef(0) // 播放会话序号：cancel 后递增，旧会话回调作废
    const ttsKeepAliveRef = React.useRef(null)

    prefsRef.current = prefs
    ttsSpeedRef.current = ttsSpeed
    ttsSegmentsRef.current = ttsSegments
    ttsIndexRef.current = ttsIndex
    uiOpenRef.current = tocOpen || settingsOpen || ttsOpen

    const theme = THEMES[prefs.theme] || THEMES.sepia

    React.useEffect(() => {
        savePrefs(prefs)
    }, [prefs])

    React.useEffect(() => {
        document.title = book?.title ? `${book.title} · 阅读` : '阅读'
    }, [book])

    /* ---------- 载入书目 ---------- */
    React.useEffect(() => {
        let cancelled = false
        setLoading(true)
        setLoadingText('正在加载书目…')
        HttpClient.get(`admin/book/info/${id}`).then(rs => {
            if (!cancelled) setBook(rs.data)
        }).catch(e => {
            if (!cancelled) {
                setError(e?.message || '书目加载失败')
                setLoading(false)
            }
        })
        return () => {
            cancelled = true
        }
    }, [id])

    /* ---------- 当前字号 / 主题写到 epub iframe ---------- */
    const applyContentStyle = React.useCallback(contents => {
        const doc = contents?.document
        if (!doc) return
        const p = prefsRef.current
        const t = THEMES[p.theme] || THEMES.sepia
        try {
            doc.documentElement.style.fontSize = `${p.size}px`
            const paint = (prop, value) => {
                doc.documentElement.style[prop] = value
                if (doc.body) doc.body.style[prop] = value
            }
            paint('color', t.epub.color || '')
            paint('background', t.epub.background || '')
            if (doc.body) {
                doc.body.style.fontFamily = FONT_STACKS[p.family] || ''
                doc.body.style.fontWeight = Number(p.weight) === 400 ? '' : String(p.weight)
            }
        } catch {
            /* iframe 尚未就绪：relocated 后会再刷一次 */
        }
    }, [])

    const applyEpubStyle = React.useCallback((rendition = renditionRef.current) => {
        if (!rendition) return
        const p = prefsRef.current
        const t = THEMES[p.theme] || THEMES.sepia
        try {
            rendition.themes.override('color', t.epub.color || '')
            rendition.themes.override('background', t.epub.background || '')
            rendition.themes.fontSize(`${p.size}px`)
            if (p.family === 'default') rendition.themes.removeOverride('font-family')
            else rendition.themes.font(p.family === 'serif' ? FONT_STACKS.serif : FONT_STACKS.sans)
            if (Number(p.weight) === 400) rendition.themes.removeOverride('font-weight')
            else rendition.themes.override('font-weight', String(p.weight), true)
        } catch {
            /* 主题接口异常按原书样式显示 */
        }
        try {
            rendition.views().forEach(view => {
                if (view?.document) applyContentStyle({document: view.document})
            })
        } catch {
            /* 视图还没渲染 */
        }
    }, [applyContentStyle])

    React.useEffect(() => {
        applyEpubStyle()
    }, [prefs, applyEpubStyle])

    /* ---------- 沉浸 / 自动翻页 ---------- */
    React.useEffect(() => {
        if (!ready || !autoSec) return undefined
        const timer = window.setInterval(() => {
            if (document.hidden || uiOpenRef.current) return
            const rendition = renditionRef.current
            if (!rendition) return
            const loc = rendition.currentLocation?.()
            if (loc?.atEnd) {
                setAutoSec(0)
                return
            }
            rendition.next().catch(() => {
            })
        }, autoSec * 1000)
        return () => window.clearInterval(timer)
    }, [ready, autoSec])

    /* ---------- 打开 EPUB ---------- */
    React.useEffect(() => {
        if (!book) return undefined
        if (!id) {
            setError('链接里缺少图书 id')
            setLoading(false)
            return undefined
        }
        if (!book.r2Key) {
            setError('这本书还没有上传 EPUB 文件，回书架点「上传」后即可阅读。')
            setLoading(false)
            return undefined
        }

        const localVersion = fileVersion(book)
        const savedPosition = readLocalPosition(id)

        let disposed = false
        let locationTimer = 0
        let saveTimer = 0
        let paintTimer = 0
        let themeTimer = 0
        const wheelDocs = []
        const cleanupFns = []

        // 打开即记一次「最近阅读」，待读 → 阅读中；失败不影响阅读
        HttpClient.post(`admin/book/reading/${id}`, null, null, {toastError: false, toastSuccess: false}).catch(() => {
        })

        const run = async () => {
            try {
                setLoading(true)
                setLoadPct(0)
                setLoadingText('正在准备阅读…')

                // 服务端确保 EPUB 已解包并返回入口 OPF 路径（首次会下载+解压，之后命中本地缓存）
                const openRs = await fetchJson(`admin/book/open/${encodeURIComponent(id)}`)
                if (disposed) return
                const openData = openRs?.data || openRs
                if (openRs?.success === false || !openData?.opfPath) {
                    throw new Error(openRs?.message || openData?.message || '准备阅读失败，请稍后重试')
                }

                const version = openData.version || localVersion
                const serverCfi = book.readCfiVersion === version && book.readCfi ? book.readCfi : null
                const localCfi = savedPosition && savedPosition.v === version ? savedPosition.cfi : null
                const startCfi = serverCfi || localCfi || null

                const progressReporter = createReporter(pct => postJson(`admin/book/progress/${id}`, {progress: pct}), 2000)
                const positionReporter = createReporter(
                    ({cfi}) => postJson(`admin/book/position/${id}`, {cfi, version}),
                    1500,
                    (a, b) => a?.cfi === b?.cfi,
                )
                reportersRef.current = {progress: progressReporter, position: positionReporter}

                const rateLocation = loc => {
                    try {
                        if (locationsReadyRef.current && loc?.start?.cfi && epubRef.current?.locations?.length() > 0) {
                            return epubRef.current.locations.percentageFromCfi(loc.start.cfi) || 0
                        }
                        if (Number.isInteger(loc?.start?.index) && totalSectionsRef.current > 0) {
                            return Math.min(1, (loc.start.index + (loc.atEnd ? 1 : 0)) / totalSectionsRef.current)
                        }
                    } catch {
                        /* 位置统计未就绪 */
                    }
                    return 0
                }

                const paintProgress = () => {
                    const ratio = rateLocation(lastLocRef.current)
                    setProgress(Math.round(ratio * 100))
                    progressReporter.report(Math.round(ratio * 100))
                }

                const opfUrl = UrlUtils.contextPath(
                    `/admin/book/resource/${encodeURIComponent(id)}/${encodeURIComponent(version)}/${encodePathSegments(openData.opfPath)}`)

                setLoadingText('正在打开…')
                const epub = ePub(opfUrl, {openAs: 'opf'})
                epubRef.current = epub
                const openBroken = new Promise((_, reject) => {
                    epub.on('openFailed', err => reject(err instanceof Error ? err : new Error('这本书解析失败（不是有效的 EPUB 文件）')))
                })

                const mode = prefsRef.current.mode
                const rendition = epub.renderTo(viewRef.current, mode === 'scroll'
                    ? {width: '100%', height: '100%', spread: 'none', flow: 'scrolled-doc', manager: 'continuous'}
                    : {width: '100%', height: '100%', spread: 'none'})
                renditionRef.current = rendition
                applyEpubStyle(rendition)

                const go = dir => {
                    const current = renditionRef.current
                    if (!current) return
                    try {
                        const task = dir === 'next' ? current.next() : current.prev()
                        task?.catch?.(() => {
                        })
                    } catch {
                        /* 到书首 / 书末 */
                    }
                }

                const toggleImmersive = () => setImmersive(v => !v)

                // 滚轮翻页：分页模式没有可滚动内容，滚轮就是翻页；滚动模式交给浏览器
                let wheelAcc = 0
                let wheelAt = 0
                let wheelLock = 0
                const onWheel = e => {
                    if (prefsRef.current.mode === 'scroll' || e.ctrlKey || e.metaKey) return
                    if (uiOpenRef.current) return
                    const now = Date.now()
                    if (now - wheelAt > 300) wheelAcc = 0
                    wheelAt = now
                    wheelAcc += e.deltaY
                    if (now < wheelLock) {
                        e.preventDefault()
                        return
                    }
                    if (Math.abs(wheelAcc) < 24) return
                    const dir = wheelAcc > 0 ? 'next' : 'prev'
                    wheelAcc = 0
                    wheelLock = now + 400
                    e.preventDefault()
                    go(dir)
                }

                // 左右滑动翻页；点击不再翻页，点击中间区域进入沉浸
                const wirePointer = target => {
                    if (!target?.addEventListener) return
                    let startX = 0
                    let startY = 0
                    let startAt = 0
                    let tracking = false
                    let moved = false

                    const point = e => e.changedTouches?.[0] || e.touches?.[0] || e
                    const enabled = () => !disposed && !uiOpenRef.current
                    const onStart = e => {
                        if (!enabled()) return
                        if (e.pointerType === 'mouse' && e.button !== 0) return
                        if (e.touches && e.touches.length > 1) return
                        const p = point(e)
                        startX = p.clientX
                        startY = p.clientY
                        startAt = Date.now()
                        tracking = true
                        moved = false
                    }
                    const onMove = e => {
                        if (!tracking) return
                        const p = point(e)
                        if (Math.abs(p.clientX - startX) > 10 || Math.abs(p.clientY - startY) > 10) moved = true
                    }
                    const onEnd = e => {
                        if (!tracking) return
                        tracking = false
                        if (!enabled()) return
                        const p = point(e)
                        const dx = p.clientX - startX
                        const dy = p.clientY - startY
                        const dt = Date.now() - startAt
                        if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.2 && dt < 900) {
                            if (dx < 0) go('next')
                            else go('prev')
                            return
                        }
                        if (moved || dt > 500) return
                        try {
                            const sel = target.getSelection?.() || target.ownerDocument?.getSelection?.()
                            if (sel && !sel.isCollapsed) return
                        } catch {
                            /* 跨域 / 异常忽略 */
                        }
                        // 翻页用左右滑动，点击左/右区域不再翻页：点击中间区域切换沉浸阅读
                        const width = target.defaultView?.innerWidth
                            || (target === viewRef.current ? viewRef.current?.clientWidth : 0)
                            || 1
                        const ratio = startX / width
                        if (ratio >= 0.3 && ratio <= 0.7) toggleImmersive()
                    }
                    const opts = {passive: true}
                    target.addEventListener('pointerdown', onStart, opts)
                    target.addEventListener('pointermove', onMove, opts)
                    target.addEventListener('pointerup', onEnd, opts)
                    target.addEventListener('pointercancel', () => {
                        tracking = false
                    }, opts)
                    return () => {
                        try {
                            target.removeEventListener('pointerdown', onStart, opts)
                            target.removeEventListener('pointermove', onMove, opts)
                            target.removeEventListener('pointerup', onEnd, opts)
                        } catch {
                            /* 文档已销毁 */
                        }
                    }
                }

                /* ---- EPUB 图片兜底：相对路径 / 大小写 / 编码不一致时按 archive 逐张重解析 ---- */
                const resolveEpubImage = async (raw, chapterHref) => {
                    const chapterDir = String(chapterHref || '').includes('/')
                        ? chapterHref.slice(0, chapterHref.lastIndexOf('/') + 1) : ''
                    const tidy = path => {
                        const out = []
                        for (const part of path.split('/')) {
                            if (!part || part === '.') continue
                            if (part === '..') out.pop()
                            else out.push(part)
                        }
                        return out.join('/')
                    }
                    const bare = raw.split(/[?#]/)[0]
                    const variants = new Set([tidy(chapterDir + bare), tidy(bare)])
                    try {
                        variants.add(tidy(chapterDir + decodeURIComponent(bare)))
                    } catch {
                        /* 非法百分号编码：按原样试 */
                    }
                    const archive = epubRef.current?.archive
                    if (!archive) return null
                    for (const rel of variants) {
                        if (!rel || !epubRef.current) continue
                        const abs = epubRef.current.resolve(rel, false)
                        if (!abs) continue
                        try {
                            const url = await archive.createUrl(abs)
                            if (typeof url === 'string' && url) return url
                        } catch {
                            /* 不在 zip 里：试下一个候选 */
                        }
                    }
                    return null
                }

                const fixContentImages = contents => {
                    const doc = contents?.document
                    if (!doc) return
                    try {
                        contents.addStylesheetRules?.({
                            img: {'max-height': 'calc(100vh - 16px) !important', 'object-fit': 'contain'},
                            svg: {'max-height': 'calc(100vh - 16px) !important'},
                            'img[data-rd-img="missing"]': {
                                'min-height': '64px',
                                'min-width': '64px',
                                background: 'rgba(127,127,127,.12)',
                                'border-radius': '4px',
                            },
                        })
                    } catch {
                        /* 老版本没有 addStylesheetRules */
                    }
                    const chapterHref = epubRef.current?.spine?.get(contents.sectionIndex)?.href || ''
                    for (const el of Array.from(doc.querySelectorAll('img, image'))) {
                        const isSvg = el.tagName.toLowerCase() === 'image'
                        const raw = String(el.getAttribute(isSvg ? 'xlink:href' : 'src') || el.getAttribute('href') || '').trim()
                        if (!raw || /^(?:blob:|data:|https?:)/i.test(raw)) continue
                        // archive 模式下按 zip 条目兜底解析；unpacked 模式资源已按真实路径服务，交给浏览器正常加载
                        if (!epubRef.current?.archive) continue
                        resolveEpubImage(raw, chapterHref).then(url => {
                            if (disposed) return
                            if (!url) {
                                el.setAttribute('data-rd-img', 'missing')
                                return
                            }
                            if (isSvg) {
                                el.setAttribute('href', url)
                                el.setAttribute('xlink:href', url)
                            } else {
                                el.setAttribute('src', url)
                            }
                            el.setAttribute('data-rd-img', 'ok')
                        })
                    }
                }

                const scheduleEpubStyle = () => {
                    if (themeTimer) return
                    themeTimer = window.setTimeout(() => {
                        themeTimer = 0
                        if (!disposed) applyEpubStyle()
                    }, 150)
                }

                rendition.hooks.content.register(contents => {
                    const doc = contents?.document
                    if (!doc) return
                    try {
                        if (doc.defaultView?.frameElement) doc.defaultView.frameElement.style.touchAction = 'pan-y'
                        contents.addStylesheetRules?.({
                            html: {'touch-action': 'pan-y'},
                            body: {'touch-action': 'pan-y'},
                        })
                    } catch {
                        /* 跨域 / 异常：指针事件仍由 wirePointer 处理，这里兜底忽略 */
                    }
                    doc.addEventListener('wheel', onWheel, {passive: false})
                    wheelDocs.push(doc)
                    applyContentStyle(contents)
                    fixContentImages(contents)
                    wirePointer(doc)
                })

                viewRef.current?.addEventListener('wheel', onWheel, {passive: false})
                cleanupFns.push(() => viewRef.current?.removeEventListener('wheel', onWheel))
                cleanupFns.push(() => wheelDocs.forEach(doc => doc.removeEventListener('wheel', onWheel)))
                cleanupFns.push(wirePointer(viewRef.current))

                /* ---- 目录：把 href 映射到 spine 序号，用于高亮当前章 ---- */
                const nav = await Promise.race([epub.loaded.navigation.catch(() => null), openBroken])
                const tocItems = flattenToc(nav?.toc)
                setToc(tocItems)
                const spineIndex = href => {
                    if (!href) return -1
                    const clean = String(href).split('#')[0]
                    try {
                        let section = epub.spine.get(href) || epub.spine.get(clean)
                        if (!section) {
                            const name = clean.split('/').pop()
                            section = epub.spine.spineItems.find(item =>
                                String(item.href).split('#')[0].split('/').pop() === name)
                        }
                        return Number.isInteger(section?.index) ? section.index : -1
                    } catch {
                        return -1
                    }
                }
                const tocIndexed = tocItems
                    .map(item => ({...item, index: spineIndex(item.href)}))
                    .filter(item => item.index >= 0)
                    .sort((a, b) => a.index - b.index)
                totalSectionsRef.current = epub.spine?.spineItems?.length || 0

                const paintLocation = loc => {
                    if (disposed) return
                    if (loc) lastLocRef.current = loc
                    if (paintTimer) return
                    paintTimer = window.setTimeout(() => {
                        paintTimer = 0
                        const current = lastLocRef.current
                        if (!current) return
                        const index = Number.isInteger(current.start?.index) ? current.start.index : 0
                        let hit = null
                        for (const item of tocIndexed) {
                            if (item.index <= index) hit = item
                            else break
                        }
                        setChapter(hit?.label || (totalSectionsRef.current ? `第 ${index + 1} 节` : ''))
                        setTocCurrent(hit ? tocIndexed.indexOf(hit) : -1)
                        setProgress(Math.round(rateLocation(current) * 100))
                    }, 120)
                }

                rendition.on('relocated', loc => {
                    if (disposed) return
                    lastLocRef.current = loc
                    const idx = Number.isInteger(loc?.start?.index) ? loc.start.index : -1
                    let href = ''
                    try {
                        href = String(loc?.start?.href || epubRef.current?.spine?.get(idx)?.href || '').split('#')[0]
                    } catch {
                        href = ''
                    }
                    currentSectionRef.current = {index: idx, href}
                    paintLocation(loc)
                    paintProgress()
                    scheduleEpubStyle()
                    const cfi = loc?.start?.cfi
                    if (!cfi) return
                    if (saveTimer) clearTimeout(saveTimer)
                    saveTimer = window.setTimeout(() => {
                        saveTimer = 0
                        if (disposed || !cfi) return
                        writeLocalPosition(id, {v: version, cfi})
                        positionReporter.report({cfi})
                    }, 600)
                })

                const onKey = e => {
                    if (uiOpenRef.current) return
                    const tag = e.target?.tagName?.toLowerCase()
                    if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target?.isContentEditable) return
                    if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
                        e.preventDefault()
                        go('prev')
                    } else if (e.key === 'ArrowRight' || e.key === 'PageDown') {
                        e.preventDefault()
                        go('next')
                    } else if (e.key === 'Escape') {
                        setImmersive(false)
                    }
                }
                window.addEventListener('keydown', onKey)
                cleanupFns.push(() => window.removeEventListener('keydown', onKey))
                rendition.on('keydown', e => {
                    if (uiOpenRef.current) return
                    if (e.key === 'ArrowLeft') go('prev')
                    if (e.key === 'ArrowRight') go('next')
                })

                /* ---- 恢复上次阅读位置（云端优先，本地兜底） ---- */
                setLoadingText('正在恢复阅读位置…')
                let restored = false
                if (startCfi) {
                    try {
                        await rendition.display(startCfi)
                        restored = true
                    } catch {
                        /* 旧位置失效：回第一页 */
                    }
                }
                if (!restored) await rendition.display()
                if (disposed) return

                paintLocation(rendition.currentLocation?.() || null)
                applyEpubStyle(rendition)
                setReady(true)
                setLoading(false)

                // 整本位置统计（约 1200 等份）：异步跑，完成后百分比更精确
                epub.ready
                    .then(() => epub.locations.generate(1200))
                    .then(() => {
                        locationsReadyRef.current = true
                        if (!disposed) paintProgress()
                    })
                    .catch(() => {
                    })

                locationTimer = window.setTimeout(() => {
                    if (!disposed) paintProgress()
                }, 1200)
            } catch (err) {
                if (disposed || err?.name === 'AbortError') return
                setError(err?.message || '打开 EPUB 失败')
                setLoading(false)
            }
        }

        run()

        const flushAll = () => {
            const r = reportersRef.current
            if (!r) return
            try {
                r.progress.flush()
            } catch {
                /* 忽略 */
            }
            try {
                r.position.flush()
            } catch {
                /* 忽略 */
            }
        }
        const onPageHide = () => flushAll()
        window.addEventListener('pagehide', onPageHide)

        return () => {
            disposed = true
            flushAll()
            window.removeEventListener('pagehide', onPageHide)
            if (locationTimer) clearTimeout(locationTimer)
            if (saveTimer) clearTimeout(saveTimer)
            if (paintTimer) clearTimeout(paintTimer)
            if (themeTimer) clearTimeout(themeTimer)
            cleanupFns.forEach(fn => {
                try {
                    fn()
                } catch {
                    /* 已销毁 */
                }
            })
            wheelDocs.length = 0
            try {
                renditionRef.current?.destroy()
            } catch {
                /* 已销毁 */
            }
            renditionRef.current = null
            try {
                epubRef.current?.destroy()
            } catch {
                /* 已销毁 */
            }
            epubRef.current = null
            locationsReadyRef.current = false
            lastLocRef.current = null
            reportersRef.current = null
        }
    }, [book, id, applyEpubStyle, applyContentStyle])

    /* ---------- 交互 ---------- */

    const openBookmark = href => {
        setTocOpen(false)
        try {
            renditionRef.current?.display(href)?.catch?.(() => {
            })
        } catch {
            /* 目录项失效 */
        }
    }

    const changePrefs = patch => setPrefs(prev => ({...prev, ...patch}))

    const changeWidth = width => {
        changePrefs({width})
        window.setTimeout(() => {
            try {
                renditionRef.current?.resize()
            } catch {
                /* 等下一次窗口变化自然重排 */
            }
        }, 120)
    }

    /** 切换分页 / 滚动：epub.js 换 manager 要重建实例，先存位置再刷新页面最稳 */
    const changeMode = mode => {
        if (mode === prefs.mode) return
        const cfi = lastLocRef.current?.start?.cfi
        if (cfi && id) writeLocalPosition(id, {v: fileVersion(book), cfi})
        try {
            reportersRef.current?.position.flush()
            reportersRef.current?.progress.flush()
        } catch {
            /* 忽略 */
        }
        changePrefs({mode})
        window.setTimeout(() => window.location.reload(), 200)
    }

    const goPrev = () => {
        try {
            renditionRef.current?.prev()?.catch?.(() => {
            })
        } catch {
            /* 书首 */
        }
    }

    const goNext = () => {
        try {
            renditionRef.current?.next()?.catch?.(() => {
            })
        } catch {
            /* 书末 */
        }
    }


    const cycleTheme = () => {
        const order = Object.keys(THEMES)
        const next = order[(order.indexOf(prefs.theme) + 1) % order.length]
        changePrefs({theme: next})
    }


function splitTtsText(text, max) {
    if (!text) return []
    const cleaned = String(text).replace(/\r\n/g, '\n').replace(/\u00a0/g, ' ').trim()
    if (!cleaned) return []
    const paras = cleaned.split(/\n+/)
    const out = []
    let buf = ''
    const pushBuf = () => {
        const s = buf.trim()
        if (s) out.push(s)
        buf = ''
    }
    for (const raw of paras) {
        const p = raw.replace(/\s+/g, ' ').trim()
        if (!p) continue
        const candidate = buf ? (buf + '\n' + p) : p
        if (candidate.length <= max) {
            buf = candidate
            continue
        }
        pushBuf()
        if (p.length <= max) {
            buf = p
            continue
        }
        let rest = p
        while (rest.length > max) {
            let cut = -1
            for (const mark of ['。', '！', '？', '；', '.', '!', '?', ';', '，', ',', ' ']) {
                const idx = rest.lastIndexOf(mark, max)
                if (idx > cut) cut = idx
            }
            if (cut < max * 0.5) cut = max
            else cut += 1
            const part = rest.slice(0, cut).trim()
            if (part) out.push(part)
            rest = rest.slice(cut).trim()
        }
        if (rest) buf = rest
    }
    pushBuf()
    return out
}

function pickTtsVoice() {
    const synth = window.speechSynthesis
    if (!synth) return null
    const voices = synth.getVoices() || []
    if (!voices.length) return null
    const zh = voices.filter(v => /^zh([-_]|$)/i.test(v.lang || ''))
    if (zh.length) return zh.find(v => v.default) || zh.find(v => v.localService) || zh[0]
    return voices.find(v => v.default) || voices[0]
}

    /* ---------- 听书（浏览器内置 TTS：前端切段 + speechSynthesis） ---------- */

    const stopKeepAlive = () => {
        if (ttsKeepAliveRef.current) {
            window.clearInterval(ttsKeepAliveRef.current)
            ttsKeepAliveRef.current = null
        }
    }

    const startKeepAlive = () => {
        stopKeepAlive()
        // Chrome 存在长句朗读中途停下的缺陷，周期 pause/resume 保活
        ttsKeepAliveRef.current = window.setInterval(() => {
            const synth = window.speechSynthesis
            if (!synth || !synth.speaking || synth.paused) return
            try {
                synth.pause()
                synth.resume()
            } catch {
                /* ignore */
            }
        }, 10000)
    }

    const stopTtsAudio = () => {
        const synth = window.speechSynthesis
        if (synth) {
            try {
                synth.cancel()
            } catch {
                /* ignore */
            }
        }
        stopKeepAlive()
        ttsSessionRef.current++
        setTtsPlaying(false)
    }

    const getCurrentChapterInfo = () => {
        const book = epubRef.current
        const rendition = renditionRef.current
        if (!book || !rendition) return null
        let href = currentSectionRef.current?.href || ''
        let index = currentSectionRef.current?.index
        try {
            const loc = rendition.currentLocation && rendition.currentLocation()
            if (loc && loc.start) {
                if (loc.start.href) href = loc.start.href
                if (typeof loc.start.index === 'number') index = loc.start.index
            }
        } catch { /* ignore */ }
        let section = null
        try {
            if (href) section = book.spine.get(href)
        } catch { /* ignore */ }
        if (!section && typeof index === 'number' && index >= 0) {
            try { section = book.spine.get(index) } catch { /* ignore */ }
        }
        if (!section) return null
        const secIndex = typeof section.index === 'number' ? section.index : index
        const secHref = section.href || href || String(secIndex ?? '')
        return {section, index: secIndex ?? 0, href: secHref}
    }

    const extractSectionText = async section => {
        if (!section) return ''
        try {
            const loaded = await section.load(epubRef.current.load.bind(epubRef.current))
            let text = ''
            if (loaded && loaded.body) {
                text = loaded.body.innerText || loaded.body.textContent || ''
            } else if (loaded && loaded.documentElement) {
                text = loaded.documentElement.textContent || ''
            } else if (typeof loaded === 'string') {
                const doc = new DOMParser().parseFromString(loaded, 'text/html')
                text = doc.body ? (doc.body.innerText || doc.body.textContent || '') : ''
            } else if (loaded && loaded.textContent) {
                text = loaded.textContent
            }
            try { section.unload && section.unload() } catch { /* ignore */ }
            return String(text || '').replace(/\u00a0/g, ' ').trim()
        } catch {
            return ''
        }
    }

    const ensureTtsSegments = async (force = false) => {
        const info = getCurrentChapterInfo()
        if (!info) {
            setTtsStatus('未定位到当前章节，请翻页后重试')
            return null
        }
        const chapterKey = `${info.index}:${info.href}`
        if (!force && ttsChapterRef.current === chapterKey && ttsSegmentsRef.current.length > 0) {
            return {chapterKey, segments: ttsSegmentsRef.current}
        }
        setTtsPreparing(true)
        setTtsStatus('正在提取当前章节文本…')
        const text = await extractSectionText(info.section)
        const segs = splitTtsText(text, TTS_MAX_CHARS)
        if (!segs.length) {
            setTtsPreparing(false)
            setTtsSegments([])
            ttsSegmentsRef.current = []
            ttsChapterRef.current = chapterKey
            setTtsIndex(0)
            ttsIndexRef.current = 0
            setTtsStatus('当前章节没有可朗读的文本')
            return null
        }
        stopTtsAudio()
        setTtsSegments(segs)
        ttsSegmentsRef.current = segs
        ttsChapterRef.current = chapterKey
        setTtsIndex(0)
        ttsIndexRef.current = 0
        setTtsPreparing(false)
        setTtsStatus(`就绪 ${segs.length} 段 · 第 1 段`)
        return {chapterKey, segments: segs}
    }

    const playTtsAt = async index => {
        const ensured = await ensureTtsSegments()
        const segments = ensured?.segments || ttsSegmentsRef.current
        if (!segments || !segments.length) return
        if (index < 0) {
            setTtsStatus('已经是第一段')
            return
        }
        if (index >= segments.length) {
            stopTtsAudio()
            setTtsStatus('本章已播完')
            return
        }
        const synth = window.speechSynthesis
        if (!synth) {
            setTtsStatus('当前浏览器不支持语音合成')
            return
        }
        stopTtsAudio()
        const session = ++ttsSessionRef.current
        setTtsIndex(index)
        ttsIndexRef.current = index
        setTtsPlaying(true)
        setTtsStatus(`第 ${index + 1} / ${segments.length} 段`)
        const speak = segIndex => {
            if (ttsSessionRef.current !== session) return
            const u = new SpeechSynthesisUtterance(segments[segIndex])
            u.lang = 'zh-CN'
            u.rate = Math.min(2, Math.max(0.5, ttsSpeedRef.current || 1))
            const voice = pickTtsVoice()
            if (voice) u.voice = voice
            u.onend = () => {
                if (ttsSessionRef.current !== session) return
                if (segIndex + 1 >= segments.length) {
                    stopKeepAlive()
                    setTtsPlaying(false)
                    setTtsStatus('本章已播完')
                    return
                }
                setTtsIndex(segIndex + 1)
                ttsIndexRef.current = segIndex + 1
                setTtsStatus(`第 ${segIndex + 2} / ${segments.length} 段`)
                speak(segIndex + 1)
            }
            u.onerror = e => {
                if (ttsSessionRef.current !== session) return
                if (e?.error === 'canceled' || e?.error === 'interrupted') return
                stopKeepAlive()
                setTtsPlaying(false)
                setTtsStatus(e?.error === 'not-allowed' ? '浏览器阻止了语音播放，请检查权限' : '语音播放出错，请重试')
            }
            try {
                synth.speak(u)
            } catch {
                stopKeepAlive()
                setTtsPlaying(false)
                setTtsStatus('语音播放失败')
            }
        }
        startKeepAlive()
        speak(index)
    }

    const toggleTtsPlay = () => {
        const synth = window.speechSynthesis
        if (ttsPlaying) {
            try {
                synth?.pause()
            } catch {
                /* ignore */
            }
            stopKeepAlive()
            setTtsPlaying(false)
            setTtsStatus(`已暂停 · 第 ${(ttsIndexRef.current || 0) + 1} 段`)
            return
        }
        // 暂停态直接恢复（保留段内进度），否则从当前段头重新朗读
        if (synth?.paused) {
            try {
                synth.resume()
            } catch {
                /* ignore */
            }
            setTtsPlaying(true)
            setTtsStatus(`第 ${(ttsIndexRef.current || 0) + 1} 段`)
            startKeepAlive()
            return
        }
        playTtsAt(ttsIndexRef.current || 0)
    }

    const openTts = () => {
        setTtsOpen(true)
        if (!ttsSegmentsRef.current.length) ensureTtsSegments().catch(() => {})
    }

    const changeTtsSpeed = v => {
        setTtsSpeed(v)
        writeStorage(TTS_SPEED_KEY, String(v))
        // 语速对下一个 utterance 生效，切换后从当前段重新朗读
        const current = ttsIndexRef.current || 0
        const wasPlaying = ttsPlaying
        stopTtsAudio()
        setTtsIndex(current)
        ttsIndexRef.current = current
        if (ttsSegmentsRef.current.length) {
            setTtsStatus(`语速已切换为 ${v}×`)
            if (wasPlaying || ttsOpen) {
                window.setTimeout(() => { playTtsAt(current).catch(() => {}) }, 0)
            }
        }
    }

    const removeCurrentPage = () => {
        if (!ready) {
            message.warning('书籍尚未加载完成')
            return
        }
        const {index, href} = currentSectionRef.current || {}
        if (index < 0 && !href) {
            message.warning('未定位到当前页，请翻页后重试')
            return
        }
        const name = chapter ? `「${chapter}」` : '当前内容页'
        Modal.confirm({
            title: '删除当前页？',
            content: `将从 EPUB 中移除${name}（可用于删除广告页/无关页面）。此操作会修改原书文件，并重置阅读进度和阅读位置，无法撤销。`,
            okText: '删除',
            okButtonProps: {danger: true},
            cancelText: '取消',
            autoFocusButton: 'cancel',
            onOk: async () => {
                try {
                    await HttpClient.post(`admin/book/removeSection/${id}`, {href, index})
                    message.success('已删除，正在重新加载')
                    window.setTimeout(() => window.location.reload(), 400)
                } catch {
                    // HttpClient 默认提示错误
                }
            },
        })
    }


    React.useEffect(() => () => {
        stopKeepAlive()
        const synth = window.speechSynthesis
        if (synth) {
            try {
                synth.cancel()
            } catch {
                /* ignore */
            }
        }
    }, [])

    /* ---------- 渲染 ---------- */

    const rootStyle = {
        '--rd-bg': theme.bg,
        '--rd-fg': theme.fg,
        '--rd-sub': theme.sub,
        '--rd-border': theme.border,
        '--rd-panel': theme.panel,
        '--rd-width': `${prefs.width}px`,
    }

    const drawerStyles = {
        header: {background: theme.panel, color: theme.fg, borderBottom: `1px solid ${theme.border}`},
        body: {background: theme.panel, color: theme.fg},
        content: {background: theme.panel},
    }

    const moreItems = [
        {key: 'tts', icon: <SoundOutlined/>, label: '语音朗读'},
        {key: 'immersive', icon: <CompressOutlined/>, label: '沉浸阅读'},
        ...(ready ? [{type: 'divider'}, {key: 'remove-page', icon: <DeleteOutlined/>, label: '删除当前页', danger: true}] : []),
    ]

    const onMoreClick = ({key}) => {
        if (key === 'tts') openTts()
        else if (key === 'immersive') setImmersive(true)
        else if (key === 'remove-page') removeCurrentPage()
    }

    const title = book?.title || book?.filename || '阅读'
    const subtitle = [book?.author, chapter].filter(Boolean).join(' · ')

    return <div className='reader-root' style={rootStyle}>
        {!immersive && <header className='reader-topbar'>
            <div className='reader-topbar-left'>
                <Tooltip title='返回书架'>
                    <Button type='text' icon={<ArrowLeftOutlined/>} onClick={() => history.push('/book')}/>
                </Tooltip>
                <div className='reader-book-meta'>
                    <div className='reader-book-title'>{title}</div>
                    <div className='reader-book-sub'>{subtitle || '未知作者'}</div>
                </div>
            </div>
            <div className='reader-topbar-right'>
                <span className='reader-percent'>{progress}%</span>
                <Tooltip title='目录'>
                    <Button type='text' icon={<MenuOutlined/>} onClick={() => setTocOpen(true)}/>
                </Tooltip>
                <Tooltip title='阅读设置'>
                    <Button type='text' icon={<FontSizeOutlined/>} onClick={() => setSettingsOpen(true)}/>
                </Tooltip>
                <Tooltip title='切换背景'>
                    <Button type='text' icon={<BgColorsOutlined/>} onClick={cycleTheme}/>
                </Tooltip>
                <Dropdown menu={{items: moreItems, onClick: onMoreClick}} trigger={['click']}>
                    <Button type='text' icon={<MoreOutlined/>}/>
                </Dropdown>
            </div>
        </header>}

        {immersive && <>
            <div className='reader-immersive-hint'>点屏幕中间恢复工具栏</div>
            <div className='reader-fabs'>
                <Tooltip title='目录' placement='left'>
                    <button className='reader-fab' type='button' onClick={() => setTocOpen(true)}><MenuOutlined/></button>
                </Tooltip>
                <Tooltip title='阅读设置' placement='left'>
                    <button className='reader-fab' type='button' onClick={() => setSettingsOpen(true)}><FontSizeOutlined/>
                    </button>
                </Tooltip>
                <Tooltip title='切换背景' placement='left'>
                    <button className='reader-fab' type='button' onClick={cycleTheme}><BgColorsOutlined/></button>
                </Tooltip>
                <Tooltip title='退出沉浸' placement='left'>
                    <button className='reader-fab' type='button' onClick={() => setImmersive(false)}><ExpandOutlined/>
                    </button>
                </Tooltip>
            </div>
        </>}

        <div className='reader-stage'>
            <div className='reader-view' ref={viewRef}/>

            {loading && <div className='reader-mask'>
                <Spin/>
                <div className='reader-mask-title'>{title}</div>
                <div className='reader-mask-text'>{loadingText}</div>
                {loadPct > 0 && loadPct < 100 && <div className='reader-mask-bar'>
                    <div style={{width: `${loadPct}%`}}/>
                </div>}
            </div>}

            {!loading && error && <div className='reader-mask'>
                <div className='reader-error-box'>
                    <h2>无法打开这本书</h2>
                    <p>{error}</p>
                    <Button type='primary' onClick={() => history.push('/book')}>返回书架</Button>
                    <Button style={{marginLeft: 8}} onClick={() => window.location.reload()}>重试</Button>
                </div>
            </div>}
        </div>

        <div className='reader-progress-line'>
            <div style={{width: `${progress}%`}}/>
        </div>

        <Drawer title='目录' placement='left' width={Math.min(window.innerWidth * 0.9, 380)}
                open={tocOpen} onClose={() => setTocOpen(false)} styles={drawerStyles}>
            {toc.length === 0
                ? <Empty description='这本书没有目录信息，可按方向键、滚轮或左右滑动翻页' image={Empty.PRESENTED_IMAGE_SIMPLE}/>
                : <ol className='reader-toc-list'>
                    {toc.map((item, index) => <li key={`${item.href}-${index}`}>
                        <button type='button' className='reader-toc-btn'
                                data-depth={Math.min(item.depth || 0, 3)}
                                aria-current={index === tocCurrent ? 'true' : undefined}
                                onClick={() => openBookmark(item.href)}>
                            {item.label}
                        </button>
                    </li>)}
                </ol>}
        </Drawer>

        <Drawer title='阅读设置' width={Math.min(window.innerWidth * 0.92, 400)}
                open={settingsOpen} onClose={() => setSettingsOpen(false)} styles={drawerStyles}>
            <SettingRow label='背景'>
                <div className='reader-theme-dots'>
                    {Object.entries(THEMES).map(([key, item]) => <button
                        key={key} type='button' className='reader-theme-dot' title={item.label}
                        aria-label={item.label} aria-pressed={prefs.theme === key}
                        style={{background: item.bg}} onClick={() => changePrefs({theme: key})}/>)}
                </div>
            </SettingRow>
            <SettingRow label='字号'>
                <Button size='small' onClick={() => changePrefs({size: Math.max(14, prefs.size - 1)})}>A−</Button>
                <span className='reader-size-value'>{prefs.size}</span>
                <Button size='small' onClick={() => changePrefs({size: Math.min(28, prefs.size + 1)})}>A+</Button>
            </SettingRow>
            <SettingRow label='字体'>
                <Segmented size='small' value={prefs.family} options={FONT_OPTIONS}
                           onChange={v => changePrefs({family: v})}/>
            </SettingRow>
            <SettingRow label='字重'>
                <Segmented size='small' value={prefs.weight} options={WEIGHT_OPTIONS}
                           onChange={v => changePrefs({weight: v})}/>
            </SettingRow>
            <SettingRow label='宽度'>
                <Segmented size='small' value={prefs.width} options={WIDTH_OPTIONS}
                           onChange={changeWidth}/>
            </SettingRow>
            <SettingRow label='模式'>
                <Segmented size='small' value={prefs.mode} options={MODE_OPTIONS}
                           onChange={changeMode}/>
            </SettingRow>
            <SettingRow label='自动翻页'>
                <Select size='small' style={{width: 120}} value={autoSec} options={AUTO_OPTIONS}
                        onChange={v => setAutoSec(v)}/>
            </SettingRow>
            <SettingRow label='显示'>
                <Button size='small' icon={<SoundOutlined/>} onClick={openTts}>语音朗读</Button>
                <Button size='small' icon={<CompressOutlined/>} onClick={() => {
                    setSettingsOpen(false)
                    setImmersive(true)
                }}>沉浸</Button>
            </SettingRow>
            <p className='reader-tip' style={{marginTop: 16}}>
                分页模式：方向键 / 滚轮 / 左右滑动翻页；点屏幕中间进入沉浸阅读。<br/>
                阅读进度与位置会自动保存，换设备可继续读。
            </p>
        </Drawer>

        <Drawer title='语音朗读' width={Math.min(window.innerWidth * 0.92, 380)}
                open={ttsOpen} onClose={() => {
            stopTtsAudio()
            setTtsOpen(false)
        }} styles={drawerStyles}>
            <div className='reader-tts-status'>{ttsPreparing ? '正在准备…' : ttsStatus}</div>
            <div className='reader-tts-controls'>
                <Button shape='circle' icon={<StepBackwardOutlined/>} disabled={ttsPreparing || ttsSegments.length === 0}
                        onClick={() => playTtsAt(ttsIndex - 1)}/>
                <Button type='primary' shape='circle' disabled={ttsPreparing}
                        icon={ttsPlaying ? <PauseOutlined/> : <CaretRightOutlined/>}
                        onClick={toggleTtsPlay}/>
                <Button shape='circle' icon={<StepForwardOutlined/>} disabled={ttsPreparing || ttsSegments.length === 0}
                        onClick={() => playTtsAt(ttsIndex + 1)}/>
            </div>
            <div className='reader-tts-row'>
                <span>语速</span>
                <Select size='small' style={{width: 100}} value={ttsSpeed}
                        options={[0.8, 1, 1.2, 1.5, 2].map(v => ({value: v, label: `${v}×`}))}
                        onChange={changeTtsSpeed}/>
            </div>
            <p className='reader-tip' style={{marginTop: 18}}>
                语音由浏览器内置 TTS 朗读（无需服务端合成），将朗读当前章节，点击播放即可开始。
            </p>
        </Drawer>
    </div>
}
