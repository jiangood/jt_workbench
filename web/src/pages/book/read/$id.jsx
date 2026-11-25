import React from 'react'
import {Button, Drawer, Empty, Segmented, Select, Spin, Tooltip} from 'antd'
import {
    ArrowLeftOutlined,
    BgColorsOutlined,
    FontSizeOutlined,
    MenuOutlined,
} from '@ant-design/icons'
import ePub from 'epubjs'
import {HttpClient, UrlUtils, history} from '@jiangood/open-admin'
import './reader.css'

export const pageMeta = {layout: 'blank', title: '阅读'}

/* ---------------- 偏好 / 常量 ---------------- */

const PREFS_KEY = 'book:reader:prefs'
const POS_PREFIX = 'book:reader:pos:'

// 虚拟页按正文字符数切分：不随手机字号、屏宽或阅读设置变化，跨设备进度一致。
const PAGE_CHARS = 1200
const TEXT_INDEX_CACHE = new WeakMap()

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

/** 正文位置索引：跳过空白文本与脚本样式，按 DOM 顺序累计字符数。 */
function getTextIndex(doc) {
    const cached = TEXT_INDEX_CACHE.get(doc)
    if (cached) return cached
    const body = doc?.body
    if (!body) return null

    const nodes = []
    const prefixes = []
    const byNode = new Map()
    const view = doc.defaultView
    const showText = view?.NodeFilter?.SHOW_TEXT ?? 4
    const walker = doc.createTreeWalker(body, showText, null)
    let total = 0
    let node = walker.nextNode()
    while (node) {
        const value = node.nodeValue || ''
        const hidden = node.parentElement?.closest?.('script, style, noscript')
        if (value.trim() && !hidden) {
            byNode.set(node, nodes.length)
            prefixes.push(total)
            nodes.push(node)
            total += value.length
        }
        node = walker.nextNode()
    }
    const index = {body, nodes, prefixes, byNode, total}
    TEXT_INDEX_CACHE.set(doc, index)
    return index
}

/** 将 DOM 边界换算为章节内字符偏移；CFI 与视口锚点共用同一把标尺。 */
function textOffsetFromBoundary(doc, container, offset) {
    const index = getTextIndex(doc)
    if (!index || !container) return null
    if (container.nodeType === 3) {
        const nodeIndex = index.byNode.get(container)
        if (nodeIndex === undefined) return null
        return index.prefixes[nodeIndex] + Math.max(0, Math.min(Number(offset) || 0, container.length))
    }
    if (container === index.body && (Number(offset) || 0) <= 0) return 0
    if (container === index.body && (Number(offset) || 0) >= container.childNodes.length) return index.total
    try {
        const point = doc.createRange()
        point.selectNodeContents(index.body)
        point.setEnd(container, Math.max(0, Number(offset) || 0))
        let total = 0
        const endToEnd = doc.defaultView?.Range?.END_TO_END ?? 2
        for (const node of index.nodes) {
            const nodeRange = doc.createRange()
            nodeRange.selectNodeContents(node)
            if (point.compareBoundaryPoints(endToEnd, nodeRange) < 0) break
            total += node.length
        }
        return total
    } catch {
        return null
    }
}

function offsetFromCfi(contents, cfi) {
    try {
        const range = contents?.range?.(cfi)
        return range ? textOffsetFromBoundary(contents.document, range.startContainer, range.startOffset) : null
    } catch {
        return null
    }
}

function collapsedCfi(contents, range) {
    const point = range.cloneRange()
    point.collapse(true)
    return contents.cfiFromRange(point)
}

/**
 * 取视口上沿的第一个正文位置。epub.js 默认映射按空格断句，中文长段落只能精确到段落；
 * 手机端改用 caret 命中文字，可连续精确到字符，避免进度一跳一大截。
 */
function viewportAnchor(rendition) {
    try {
        const manager = rendition?.manager
        const container = manager?.container
        const views = manager?.views?.displayed?.() || []
        if (!container || !views.length) return null

        const box = container.getBoundingClientRect()
        const axis = manager.settings?.axis || views.find(view => view.settings?.axis)?.settings?.axis || 'vertical'
        const horizontal = axis === 'horizontal'
        const startSide = horizontal ? 'left' : 'top'
        const endSide = horizontal ? 'right' : 'bottom'
        const sizeSide = horizontal ? 'width' : 'height'
        const edge = box[startSide] + 1
        const view = views.find(item => {
            const rect = item.element?.getBoundingClientRect?.()
            return item.contents?.document && rect && rect[endSide] > edge && rect[startSide] < edge
        })
        if (!view) return null

        const contents = view.contents
        const doc = contents.document
        const index = getTextIndex(doc)
        if (!index) return null
        const frame = (view.iframe || view.element).getBoundingClientRect()
        const makeAnchor = (offset, atEnd = false) => {
            const range = doc.createRange()
            if (atEnd) {
                range.selectNodeContents(index.body)
                range.collapse(false)
            } else {
                range.setStart(index.body, 0)
                range.collapse(true)
            }
            return {index: view.section.index, cfi: collapsedCfi(contents, range), offset}
        }

        const scrollPos = Math.abs(horizontal ? container.scrollLeft : container.scrollTop)
        const scrollSize = horizontal ? container.scrollWidth : container.scrollHeight
        const viewportSize = horizontal ? container.clientWidth : container.clientHeight
        if (scrollPos <= 1 && !view.section.prev()) return makeAnchor(0)
        if (scrollPos + viewportSize >= scrollSize - 2 && !view.section.next()) return makeAnchor(index.total, true)

        const cross = horizontal ? frame.height / 2 : frame.width / 2
        let along = Math.max(0, edge - frame[startSide] + 1)
        const maxScan = Math.min(frame[sizeSide], Math.max(48, box[sizeSide] / 3))
        for (let scanned = 0; scanned <= maxScan; scanned += 4, along += 4) {
            const x = horizontal ? along : cross
            const y = horizontal ? cross : along
            let range = doc.defaultView?.caretRangeFromPoint?.(x, y)
            if (!range && doc.defaultView?.caretPositionFromPoint) {
                const pos = doc.defaultView.caretPositionFromPoint(x, y)
                if (pos?.offsetNode) {
                    range = doc.createRange()
                    range.setStart(pos.offsetNode, pos.offset)
                }
            }
            if (!range?.startContainer) continue
            const offset = textOffsetFromBoundary(doc, range.startContainer, range.startOffset)
            if (offset === null) continue
            return {index: view.section.index, cfi: collapsedCfi(contents, range), offset}
        }
    } catch {
        /* 固定布局 / 浏览器不支持 caret 命中：回退 epub.js 的位置映射 */
    }
    return null
}

/** 扫描一遍 spine 统计真实正文长度，避免短章节被 epub.js 的等份位置统计放大权重。 */
async function buildReadingIndex(epub, isDisposed = () => false) {
    const sections = []
    let total = 0
    let loaded = 0
    for (const section of epub?.spine?.spineItems || []) {
        if (isDisposed()) return null
        if (!section.linear) {
            sections.push(null)
            continue
        }
        const start = total
        try {
            // 直接请求章节文档，不碰 Section 的加载/卸载状态，避免与连续阅读器的渲染竞争。
            const doc = await epub.request(section.url)
            if (isDisposed()) return null
            total += getTextIndex(doc)?.total || 0
        } catch {
            /* 损坏章节不计入正文；阅读器仍会显示它，但不会挤占正常章节的进度权重 */
        }
        sections.push({start, length: total - start})
        // 大书在手机端也留出渲染间隙，避免连续解析章节时长时间卡住主线程。
        if (++loaded % 8 === 0) await new Promise(resolve => window.setTimeout(resolve, 0))
    }
    return {
        sections,
        total,
        totalPages: Math.max(1, Math.ceil(total / PAGE_CHARS)),
    }
}

function postJson(path, body) {
    return fetch(UrlUtils.contextPath('/' + path), {
        method: 'POST',
        credentials: 'include',
        keepalive: true,
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(body),
    }).then(res => res.ok).catch(() => false)
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

/** 串行节流上报：相同值不重复发，攒 wait 毫秒再发，离页时 flush；失败自动重试。 */
function createReporter(send, wait, same = (a, b) => a === b) {
    let last
    let pending
    let timer = 0
    let flying = false
    const schedule = () => {
        if (!timer && pending !== undefined) timer = window.setTimeout(flush, wait)
    }
    const flush = () => {
        if (timer) {
            clearTimeout(timer)
            timer = 0
        }
        if (flying || pending === undefined) return
        const value = pending
        pending = undefined
        if (last !== undefined && same(value, last)) return
        flying = true
        Promise.resolve(send(value)).then(ok => {
            if (ok) last = value
            else if (pending === undefined) pending = value
        }).catch(() => {
            if (pending === undefined) pending = value
        }).finally(() => {
            flying = false
            schedule()
        })
    }
    return {
        report(value) {
            if (value === undefined || value === null) return
            if (pending !== undefined && same(value, pending)) return
            pending = value
            schedule()
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
    const [pageInfo, setPageInfo] = React.useState({page: 0, total: 0})
    const [toc, setToc] = React.useState([])
    const [tocCurrent, setTocCurrent] = React.useState(-1)
    const [tocOpen, setTocOpen] = React.useState(false)
    const [settingsOpen, setSettingsOpen] = React.useState(false)
    const [autoSec, setAutoSec] = React.useState(0)

    const viewRef = React.useRef(null)
    const renditionRef = React.useRef(null)
    const epubRef = React.useRef(null)
    const lastLocRef = React.useRef(null)
    const readingIndexRef = React.useRef(null)
    const totalSectionsRef = React.useRef(0)
    const prefsRef = React.useRef(prefs)
    const uiOpenRef = React.useRef(false)
    const reportersRef = React.useRef(null)

    prefsRef.current = prefs
    uiOpenRef.current = tocOpen || settingsOpen

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

    /* ---------- 自动翻页 ---------- */
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
        let latestPosition = null
        let saveTimer = 0
        let paintTimer = 0
        let themeTimer = 0
        const cleanupFns = []

        const persistLatest = () => {
            if (!latestPosition) return
            writeLocalPosition(id, latestPosition)
            reportersRef.current?.position.report({cfi: latestPosition.cfi, progress: latestPosition.progress})
        }

        // 打开即记一次「最近阅读」，待读 → 阅读中；失败不影响阅读
        HttpClient.post(`admin/book/reading/${id}`, null, null, {toastError: false, toastSuccess: false}).catch(() => {
        })

        const run = async () => {
            try {
                setLoading(true)
                setLoadPct(0)
                setPageInfo({page: 0, total: 0})
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

                const positionReporter = createReporter(
                    ({cfi, progress}) => postJson(`admin/book/position/${id}`, {cfi, version, progress}),
                    1500,
                    (a, b) => a?.cfi === b?.cfi && a?.progress === b?.progress,
                )
                reportersRef.current = {position: positionReporter}

                const opfUrl = UrlUtils.contextPath(
                    `/admin/book/resource/${encodeURIComponent(id)}/${encodeURIComponent(version)}/${encodePathSegments(openData.opfPath)}`)

                setLoadingText('正在打开…')
                const epub = ePub(opfUrl, {openAs: 'opf'})
                epubRef.current = epub
                const openBroken = new Promise((_, reject) => {
                    epub.on('openFailed', err => reject(err instanceof Error ? err : new Error('这本书解析失败（不是有效的 EPUB 文件）')))
                })

                const rendition = epub.renderTo(viewRef.current, {
                    width: '100%',
                    height: '100%',
                    spread: 'none',
                    flow: 'scrolled-doc',
                    manager: 'continuous',
                })
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
                        /* 跨域 / 异常：忽略滚动样式兜底 */
                    }
                    applyContentStyle(contents)
                    fixContentImages(contents)
                })

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
                        if (disposed) return
                        const current = lastLocRef.current
                        const anchor = viewportAnchor(rendition)
                        const index = Number.isInteger(anchor?.index)
                            ? anchor.index
                            : (Number.isInteger(current?.start?.index) ? current.start.index : 0)
                        const cfi = anchor?.cfi || current?.start?.cfi
                        let sectionOffset = anchor?.offset
                        if (sectionOffset == null && cfi) {
                            const view = rendition.manager?.views?.displayed?.().find(item => item.section.index === index)
                            sectionOffset = offsetFromCfi(view?.contents, cfi)
                        }

                        const readingIndex = readingIndexRef.current
                        const metric = readingIndex?.sections?.[index]
                        let pct = Number.isFinite(book.progress) ? Math.max(0, Math.min(100, book.progress)) : 0
                        if (metric && sectionOffset != null && readingIndex.total > 0) {
                            const globalOffset = Math.max(0, Math.min(
                                readingIndex.total,
                                metric.start + Math.max(0, Math.min(metric.length, sectionOffset)),
                            ))
                            pct = Math.round(globalOffset / readingIndex.total * 100)
                            setProgress(pct)
                            setPageInfo({
                                page: Math.min(readingIndex.totalPages, Math.floor(globalOffset / PAGE_CHARS) + 1),
                                total: readingIndex.totalPages,
                            })
                        }

                        let hit = null
                        for (const item of tocIndexed) {
                            if (item.index <= index) hit = item
                            else break
                        }
                        setChapter(hit?.label || (totalSectionsRef.current ? `第 ${index + 1} 节` : ''))
                        setTocCurrent(hit ? tocIndexed.indexOf(hit) : -1)

                        if (cfi) {
                            latestPosition = {v: version, cfi, progress: pct}
                            if (saveTimer) clearTimeout(saveTimer)
                            saveTimer = window.setTimeout(() => {
                                saveTimer = 0
                                if (!disposed) persistLatest()
                            }, 600)
                        }
                    }, 120)
                }

                rendition.on('relocated', loc => {
                    if (disposed) return
                    lastLocRef.current = loc
                    paintLocation(loc)
                    scheduleEpubStyle()
                })
                rendition.on('resized', () => paintLocation(lastLocRef.current))

                // 手机触摸滚动不一定会触发 epub.js 的 relocated；直接监听外层滚动容器补算视口锚点。
                const scroller = rendition.manager?.container
                const onScroll = () => paintLocation(lastLocRef.current)
                scroller?.addEventListener('scroll', onScroll, {passive: true})
                cleanupFns.push(() => scroller?.removeEventListener('scroll', onScroll))

                const onKey = e => {
                    if (uiOpenRef.current) return
                    const tag = e.target?.tagName?.toLowerCase()
                    if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target?.isContentEditable) return
                    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === 'PageUp'
                        || (e.key === ' ' && e.shiftKey)) {
                        e.preventDefault()
                        go('prev')
                    } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'PageDown'
                        || e.key === ' ') {
                        e.preventDefault()
                        go('next')
                    }
                }
                window.addEventListener('keydown', onKey)
                cleanupFns.push(() => window.removeEventListener('keydown', onKey))
                rendition.on('keydown', e => {
                    if (uiOpenRef.current) return
                    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === 'PageUp'
                        || (e.key === ' ' && e.shiftKey)) go('prev')
                    if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'PageDown'
                        || e.key === ' ') go('next')
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

                // 后台按正文字符数建立全书索引；完成后页数与百分比连续更新，不再每 1200 字跳一次。
                buildReadingIndex(epub, () => disposed).then(index => {
                    if (disposed || !index) return
                    readingIndexRef.current = index
                    paintLocation(lastLocRef.current)
                }).catch(() => {
                    /* 索引失败时保留 CFI 续读，页数显示占位 */
                })
            } catch (err) {
                if (disposed || err?.name === 'AbortError') return
                setError(err?.message || '打开 EPUB 失败')
                setLoading(false)
            }
        }

        run()

        const flushAll = () => {
            persistLatest()
            try {
                reportersRef.current?.position.flush()
            } catch {
                /* 忽略 */
            }
        }
        const onPageHide = () => flushAll()
        const onVisibilityChange = () => {
            if (document.visibilityState === 'hidden') flushAll()
        }
        window.addEventListener('pagehide', onPageHide)
        document.addEventListener('visibilitychange', onVisibilityChange)

        return () => {
            disposed = true
            flushAll()
            window.removeEventListener('pagehide', onPageHide)
            document.removeEventListener('visibilitychange', onVisibilityChange)
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
            readingIndexRef.current = null
            lastLocRef.current = null
            latestPosition = null
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

    /** 修改阅读宽度：重排后位置由 epub.js 自行保持 */
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

    const cycleTheme = () => {
        const order = Object.keys(THEMES)
        const next = order[(order.indexOf(prefs.theme) + 1) % order.length]
        changePrefs({theme: next})
    }

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

    const title = book?.title || book?.filename || '阅读'
    const subtitle = [book?.author, chapter].filter(Boolean).join(' · ')

    return <div className='reader-root' style={rootStyle}>
        <header className='reader-topbar'>
            <div className='reader-topbar-left'>
                <Tooltip title='返回书架'>
                    <Button type='text' icon={<ArrowLeftOutlined/>} onClick={() => history.push('/book/shelf')}/>
                </Tooltip>
                <div className='reader-book-meta'>
                    <div className='reader-book-title'>{title}</div>
                    <div className='reader-book-sub'>{subtitle || '未知作者'}</div>
                </div>
            </div>
            <div className='reader-topbar-right'>
                <span
                    className='reader-percent'
                    title='已读页数 / 总页数'
                    aria-label={pageInfo.total > 0 ? `已读 ${pageInfo.page} / ${pageInfo.total} 页，进度 ${progress}%` : '正在计算页数'}
                >
                    {pageInfo.total > 0 ? `${pageInfo.page} / ${pageInfo.total} 页` : '— / — 页'}
                </span>
                <Tooltip title='目录'>
                    <Button type='text' icon={<MenuOutlined/>} onClick={() => setTocOpen(true)}/>
                </Tooltip>
                <Tooltip title='阅读设置'>
                    <Button type='text' icon={<FontSizeOutlined/>} onClick={() => setSettingsOpen(true)}/>
                </Tooltip>
                <Tooltip title='切换背景'>
                    <Button type='text' icon={<BgColorsOutlined/>} onClick={cycleTheme}/>
                </Tooltip>
            </div>
        </header>

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
                    <Button type='primary' onClick={() => history.push('/book/shelf')}>返回书架</Button>
                    <Button style={{marginLeft: 8}} onClick={() => window.location.reload()}>重试</Button>
                </div>
            </div>}
        </div>

        <Drawer title='目录' placement='left' width={Math.min(window.innerWidth * 0.9, 380)}
                open={tocOpen} onClose={() => setTocOpen(false)} styles={drawerStyles}>
            {toc.length === 0
                ? <Empty description='这本书没有目录信息，向上/向下滚动即可继续阅读' image={Empty.PRESENTED_IMAGE_SIMPLE}/>
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
            <SettingRow label='自动滚动'>
                <Select size='small' style={{width: 120}} value={autoSec} options={AUTO_OPTIONS}
                        onChange={v => setAutoSec(v)}/>
            </SettingRow>
            <p className='reader-tip' style={{marginTop: 16}}>
                上下滚动阅读：滚轮 / 触控板 / 触摸滑动，方向键上下或翻页键滚动一屏。<br/>
                页数按正文位置划分，不随手机排版变化；阅读进度与位置会自动保存，换设备可继续读。
            </p>
        </Drawer>
    </div>
}
