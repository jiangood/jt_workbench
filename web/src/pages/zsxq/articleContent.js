import DOMPurify from 'dompurify'
import {imageSrc} from './media'

const OFFICIAL_IMAGE = /^https:\/\/images\.zsxq\.com\//i

/** 专栏完整正文：先清洗不可信 HTML，再把星球图片改走站内代理，避免过期外链。 */
export function sanitizeArticleHtml(raw, title = '') {
    const safe = DOMPurify.sanitize(String(raw || ''), {
        USE_PROFILES: {html: true},
        FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button'],
        FORBID_ATTR: ['style'],
        ADD_ATTR: ['target', 'loading', 'referrerpolicy'],
    })
    const doc = new DOMParser().parseFromString(safe, 'text/html')

    // 正文页可能自带标题；与单独展示的 articleTitle 相同时去掉，避免重复。
    const expected = String(title || '').replace(/\s+/g, ' ').trim()
    if (expected) {
        const heading = [...doc.querySelectorAll('h1, h2')]
            .find(node => node.textContent.replace(/\s+/g, ' ').trim() === expected)
        heading?.remove()
    }

    doc.querySelectorAll('img').forEach(img => {
        const source = (img.getAttribute('src') || '').trim()
        const normalized = source.startsWith('//') ? `https:${source}` : source
        img.removeAttribute('srcset')
        img.removeAttribute('style')
        img.setAttribute('loading', 'lazy')
        img.setAttribute('referrerpolicy', 'no-referrer')
        img.setAttribute('class', 'zsxq-article-image')
        if (OFFICIAL_IMAGE.test(normalized)) img.setAttribute('src', imageSrc(normalized))
        else img.removeAttribute('src')
    })

    doc.querySelectorAll('a[href]').forEach(link => {
        const href = (link.getAttribute('href') || '').trim()
        if (/^https?:\/\//i.test(href)) {
            link.setAttribute('target', '_blank')
            link.setAttribute('rel', 'noreferrer noopener')
        }
    })

    return doc.body.innerHTML
}
