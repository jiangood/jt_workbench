import {UrlUtils} from '@jiangood/open-admin'

/** 知识星球图片：对象存储 key 走站内代理，旧的源站 URL 也先经代理落对象存储 */
export function imageSrc(value) {
    const v = String(value || '').trim()
    if (!v) return null
    if (/^https?:\/\//i.test(v)) return UrlUtils.contextPath(`/admin/zsxq/image?u=${encodeURIComponent(v)}`)
    if (v.startsWith('/')) return UrlUtils.contextPath(v)
    return UrlUtils.contextPath(`/admin/zsxq/image?key=${encodeURIComponent(v)}`)
}

/** images 列为 JSON 数组字符串；坏数据一律当空数组 */
export function parseImages(raw) {
    if (Array.isArray(raw)) return raw.filter(Boolean)
    if (!raw) return []
    try {
        const list = JSON.parse(raw)
        return Array.isArray(list) ? list.filter(Boolean) : []
    } catch {
        return []
    }
}

/** 帖子正文图片列表：优先 images，旧数据回退 cover */
export function topicImages(topic) {
    const list = parseImages(topic?.images)
    if (list.length) return list
    return topic?.cover ? [topic.cover] : []
}

/** 统一时间展示：ISO/毫秒/日期字符串 -> 简短本地显示 */
export function fmtTime(v) {
    if (!v) return ''
    const s = String(v)
    if (s.includes('T')) return s.replace('T', ' ').slice(0, 16).replace(/-/g, '/')
    return s.slice(0, 16)
}

/** 附件下载地址：由服务端按需下载到对象存储后以原文件名返回 */
export function fileDownloadUrl(topicId, fileId) {
    const t = String(topicId || '').trim()
    const f = String(fileId || '').trim()
    if (!t || !f) return null
    return UrlUtils.contextPath(`/admin/zsxq/file?topicId=${encodeURIComponent(t)}&fileId=${encodeURIComponent(f)}`)
}

/** 字节数 -> 可读大小 */
export function fmtSize(bytes) {
    const n = Number(bytes)
    if (!Number.isFinite(n) || n <= 0) return ''
    const units = ['B', 'KB', 'MB', 'GB', 'TB']
    let value = n
    let i = 0
    while (value >= 1024 && i < units.length - 1) {
        value /= 1024
        i += 1
    }
    return `${value >= 10 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`
}
