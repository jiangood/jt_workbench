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
