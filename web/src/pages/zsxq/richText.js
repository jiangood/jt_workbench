/** 知识星球自定义 <e .../> 富文本标记；属性值通常经过 URL 编码。 */
const RICH_TAG_RE = /<e\b([^>]*?)(?:\/\s*>|>([\s\S]*?)<\/e\s*>)/gi
const ATTR_RE = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g

const HTML_ENTITIES = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
}

function decodeEntities(value) {
    return String(value).replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/gi, (match, entity) => {
        if (entity[0] !== '#') return HTML_ENTITIES[entity.toLowerCase()] ?? match
        const hex = entity[1]?.toLowerCase() === 'x'
        const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10)
        if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return match
        try {
            return String.fromCodePoint(code)
        } catch {
            return match
        }
    })
}

/** 解码 title/href 等属性：先解 URL 编码，再兼容 HTML 实体转义。 */
function decodeAttribute(value) {
    try {
        return decodeEntities(decodeURIComponent(value))
    } catch {
        // 坏百分号编码不能影响整条帖子，保留实体解码后的原文
        return decodeEntities(value)
    }
}

function parseAttributes(source) {
    const attrs = {}
    ATTR_RE.lastIndex = 0
    let match
    while ((match = ATTR_RE.exec(source))) {
        const name = match[1].toLowerCase()
        attrs[name] = match[2] ?? match[3] ?? match[4] ?? ''
    }
    return attrs
}

/** 富文本链接只允许 http(s)，拒绝 javascript:/data: 等危险协议。 */
function safeExternalUrl(value) {
    const url = value.trim()
    if (/^https?:\/\//i.test(url)) return url
    if (url.startsWith('//')) return `https:${url}`
    return ''
}

function richToken(attrs, inner) {
    const title = decodeAttribute(attrs.title || attrs.name || attrs.text || attrs.value || '')
    const body = decodeEntities(inner || '').trim()
    const label = title || body
    const href = safeExternalUrl(decodeAttribute(attrs.href || attrs.url || ''))

    if (href) return {type: 'link', value: label || href, href}
    // 没有安全链接时仍显示标题，避免露出标签源码
    if (label) return {type: 'text', value: label}
    return null
}

/**
 * 将星球正文拆成纯文本与安全链接片段。
 *
 * 例如 《<e type="web" href="https%3A..." title="%E6%BB%A1%E4%BB%93%E7%BB%BF" style="book" />》
 * 会拆为文本「《」、链接「满仓绿」、文本「」」。
 */
export function parseZsxqText(raw) {
    const source = String(raw ?? '')
    const parts = []
    let cursor = 0
    RICH_TAG_RE.lastIndex = 0
    let match

    while ((match = RICH_TAG_RE.exec(source))) {
        const before = decodeEntities(source.slice(cursor, match.index))
        if (before) parts.push({type: 'text', value: before})

        const token = richToken(parseAttributes(match[1] || ''), match[2])
        if (token) parts.push(token)
        cursor = RICH_TAG_RE.lastIndex
    }

    const rest = decodeEntities(source.slice(cursor))
    // 摘要截断或旧数据可能留下未闭合的 <e ...>，尽量还原标题，不再露出标签源码
    const unfinished = rest.match(/<e\b([^>]*)(?:>([\s\S]*))?$/i)
    if (unfinished) {
        const before = rest.slice(0, unfinished.index)
        if (before) parts.push({type: 'text', value: before})
        const token = richToken(parseAttributes(unfinished[1]), unfinished[2])
        if (token) parts.push(token)
    } else if (rest) {
        parts.push({type: 'text', value: rest})
    }
    return parts
}

/** 首页等不能嵌套链接的场景：只取还原后的可读文本。 */
export function zsxqPlainText(raw) {
    return parseZsxqText(raw).map(part => part.value).join('')
}
