import DOMPurify from 'dompurify'
import {UrlUtils} from '@jiangood/open-admin'

/** 富文本 -> 可读纯文本（列表预览、标题兜底） */
export function htmlToPlainText(raw) {
    if (!raw) return ''
    const doc = new DOMParser().parseFromString(String(raw), 'text/html')
    return (doc.body.textContent || '').replace(/\s+/g, ' ').trim()
}

/** 历史纯文本笔记 -> 简单 HTML（保留换行） */
export function plainTextToHtml(text) {
    return String(text || '')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .split('\n')
        .map(line => `<p>${line ? escapeHtml(line) : '<br/>'}</p>`)
        .join('')
}

export function escapeHtml(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
}

/**
 * 笔记正文清洗：去掉脚本/内联样式，图片改走站内文件地址并补齐 context-path。
 *
 * <p>笔记正文既可能来自富文本编辑器，也可能来自知识星球同步内容，展示前一律清洗。</p>
 */
export function sanitizeNoteHtml(raw) {
    const safe = DOMPurify.sanitize(String(raw || ''), {
        USE_PROFILES: {html: true},
        FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button'],
        FORBID_ATTR: ['style'],
        ADD_ATTR: ['target', 'loading', 'referrerpolicy'],
    })
    const doc = new DOMParser().parseFromString(safe, 'text/html')

    doc.querySelectorAll('img').forEach(img => {
        let src = (img.getAttribute('src') || '').trim()
        if (src.startsWith('//')) src = `https:${src}`
        img.removeAttribute('srcset')
        img.removeAttribute('style')
        img.setAttribute('loading', 'lazy')
        img.setAttribute('referrerpolicy', 'no-referrer')
        if (src.startsWith('/file/') || src.startsWith('/admin/')) {
            img.setAttribute('src', UrlUtils.contextPath(src))
        } else if (/^https?:\/\//i.test(src)) {
            img.setAttribute('src', src)
        } else {
            img.removeAttribute('src')
        }
    })

    doc.querySelectorAll('a[href]').forEach(link => {
        const href = (link.getAttribute('href') || '').trim()
        if (/^https?:\/\//i.test(href)) {
            link.setAttribute('target', '_blank')
            link.setAttribute('rel', 'noreferrer noopener')
        } else if (href.startsWith('/')) {
            link.setAttribute('href', UrlUtils.contextPath(href))
        }
    })

    return doc.body.innerHTML
}

/** 内容是否只有空白/空标签 */
export function isEmptyHtml(raw) {
    return !htmlToPlainText(raw)
}
