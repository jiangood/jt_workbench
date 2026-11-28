import React from 'react'
import {DownloadOutlined, FileTextOutlined, PaperClipOutlined} from '@ant-design/icons'
import {Button, Image, Radio, Switch, Tag} from 'antd'
import {HttpClient, PermUtils} from '@jiangood/open-admin'
import {fileDownloadUrl, fmtSize, fmtTime, imageSrc, topicImages} from './media'
import {parseZsxqText} from './richText'
import {sanitizeArticleHtml} from './articleContent'
import SaveNoteModal from './SaveNoteModal'

/** 摘要超过该长度时默认折叠，避免单条帖子占满整屏 */
const CLAMP_THRESHOLD = 600

/** 单条星球话题：作者、正文、图片与评论；折叠/只看星主评论由组件自身维护 */
export default class TopicPost extends React.Component {
    state = {
        expanded: false,
        ownerCommentOnly: false,
        commentsExpanded: false,
        previewIndex: -1,
        noteModalOpen: false,
    }

    toggleExpanded = () => this.setState(prev => ({expanded: !prev.expanded}))

    toggleOwnerComments = () => this.setState(prev => ({ownerCommentOnly: !prev.ownerCommentOnly}))

    toggleCommentsExpanded = () => this.setState(prev => ({commentsExpanded: !prev.commentsExpanded}))

    togglePreview = (index, open) => this.setState({previewIndex: open ? index : -1})

    setQuality = async (quality) => {
        const {item, onQualityChange} = this.props
        const rs = await HttpClient.post('admin/zsxq/quality', {id: item.id, quality: quality || ''})
        const next = rs?.data?.quality ?? (quality || '')
        if (onQualityChange) onQualityChange(item.id, next || null)
    }

    renderTextParts = (parts) => parts.map((part, index) => part.href
        ? <a key={index} className='zsxq-rich-link' href={part.href} target='_blank' rel='noreferrer'>
            {part.value}
        </a>
        : <React.Fragment key={index}>{part.value}</React.Fragment>)

    renderRichText = (raw) => this.renderTextParts(parseZsxqText(raw))

    render() {
        const {
            item,
            comments = [],
            files = [],
            isOwner = false,
            meta = null,
            distinguishOwner = true,
            showSourceLink = true,
            collapseCommentsWithoutOwner = false,
        } = this.props
        const {expanded, ownerCommentOnly, commentsExpanded, previewIndex, noteModalOpen} = this.state
        const markedIsOwner = distinguishOwner && isOwner
        const articleHtml = sanitizeArticleHtml(item.articleContent, item.articleTitle)
        const hasArticleContent = !!articleHtml.trim()
        const images = hasArticleContent ? [] : topicImages(item)
        const ownerComments = distinguishOwner ? comments.filter(c => c.owner) : []
        const shownComments = distinguishOwner && ownerCommentOnly ? ownerComments : comments
        const shouldCollapseComments = distinguishOwner && collapseCommentsWithoutOwner
            && comments.length > 0 && ownerComments.length === 0
        const commentsCollapsed = shouldCollapseComments && !commentsExpanded
        const commentsListId = `zsxq-comments-${String(item.topicId || item.id || 'post').replace(/[^a-zA-Z0-9_-]/g, '-')}`
        const textParts = parseZsxqText(item.digest || '')
        const text = textParts.map(part => part.value).join('')
        const longText = text.length > CLAMP_THRESHOLD
        // 专栏文章：优先用同步到的原文地址；没有时回退到星球话题详情页
        const sourceUrl = item.articleUrl
            || (item.columnId && item.topicId
                ? `https://wx.zsxq.com/dweb2/index/topic_detail/${encodeURIComponent(item.topicId)}`
                : '')

        return <article className={`zsxq-post${markedIsOwner ? ' is-owner' : ''}`}>
            <div className='zsxq-post-head'>
                <div className='zsxq-post-author'>
                    <span>{item.author || '匿名'}</span>
                    {markedIsOwner ? <Tag color='magenta' bordered={false}>星主</Tag> : null}
                    {item.quality === 'DRY' ? <Tag color='gold' bordered={false}>干货</Tag> : null}
                    {item.quality === 'WATER' ? <Tag bordered={false}>水帖</Tag> : null}
                </div>
                <span className='zsxq-post-time'>{fmtTime(item.sourceCreateTime)}</span>
            </div>

            <div className='zsxq-post-meta'>
                {meta}
                {showSourceLink && sourceUrl ? <a className='zsxq-post-source' href={sourceUrl} target='_blank'
                                                  rel='noreferrer'>查看原文</a> : null}
                {Number(item.likesCount) > 0 ? <span>赞 {item.likesCount}</span> : null}
                {Number(item.commentCount) > 0 ? <span>评论 {item.commentCount}</span> : null}
                {item.lastCommentTime ? <span>最近回复 {fmtTime(item.lastCommentTime)}</span> : null}
                {PermUtils.hasPermission('zsxq:manage') ? <Radio.Group
                    className='zsxq-post-mark'
                    size='small'
                    optionType='button'
                    value={item.quality || undefined}
                    options={[
                        {label: '干货', value: 'DRY'},
                        {label: '水帖', value: 'WATER'},
                    ]}
                    onChange={(e) => this.setQuality(e.target.value)}
                /> : null}
                <Button className='zsxq-post-note' type='link' size='small'
                        icon={<FileTextOutlined/>} perm='note:edit'
                        onClick={() => this.setState({noteModalOpen: true})}>转为笔记</Button>
            </div>

            {hasArticleContent ? <>
                {item.articleTitle ? <h2 className='zsxq-article-title'>{item.articleTitle}</h2> : null}
                <div className='zsxq-article-content' dangerouslySetInnerHTML={{__html: articleHtml}}/>
            </> : text ? <>
                <div className={`zsxq-post-text${longText && !expanded ? ' is-clamped' : ''}`}>{this.renderTextParts(textParts)}</div>
                {longText ? <button type='button' className='zsxq-post-toggle' onClick={this.toggleExpanded}>
                    {expanded ? '收起' : '展开全文'}
                </button> : null}
            </> : images.length ? null : <div className='zsxq-post-text'>
                {item.columnId ? (showSourceLink && sourceUrl ? '（正文待同步，可先查看原文）' : '（正文待同步）') : '（无内容）'}
            </div>}

            {images.length ? <div className='zsxq-post-images'>
                {images.map((img, idx) => {
                    const src = imageSrc(img)
                    const alt = `帖子图片 ${idx + 1}`
                    return <Image
                        key={`${img}-${idx}`}
                        src={src}
                        alt={alt}
                        loading='lazy'
                        classNames={{root: 'zsxq-post-image'}}
                        preview={{
                            open: previewIndex === idx,
                            onOpenChange: open => this.togglePreview(idx, open),
                            // 预览态下再次点击图片即关闭，回到信息流中的缩略图
                            imageRender: node => React.cloneElement(node, {
                                className: `${node.props.className || ''} zsxq-post-preview-img`,
                                onClick: () => this.togglePreview(idx, false),
                            }),
                        }}
                    />
                })}
            </div> : null}

            {files.length ? <div className='zsxq-post-files'>
                <div className='zsxq-post-files-head'>
                    <PaperClipOutlined/>
                    <span>附件 {files.length}</span>
                </div>
                <ul className='zsxq-post-file-list'>
                    {files.map((file, idx) => {
                        const href = fileDownloadUrl(item.topicId, file.fileId)
                        if (!href) return null
                        const label = file.name || `附件 ${idx + 1}`
                        const size = fmtSize(file.size)
                        return <li key={file.fileId || idx}>
                            <a className='zsxq-post-file' href={href} title={`下载 ${label}`}>
                                <DownloadOutlined className='zsxq-post-file-icon'/>
                                <span className='zsxq-post-file-name'>{label}</span>
                                {size ? <span className='zsxq-post-file-size'>{size}</span> : null}
                            </a>
                        </li>
                    })}
                </ul>
            </div> : null}

            {comments.length ? <div className='zsxq-post-comments'>
                <div className='zsxq-comments-head'>
                    <span>评论 {shownComments.length}{distinguishOwner && ownerCommentOnly ? ` / ${comments.length}` : ''}</span>
                    {shouldCollapseComments ? <button type='button' className='zsxq-comments-toggle'
                                                     aria-expanded={!commentsCollapsed} aria-controls={commentsListId}
                                                     onClick={this.toggleCommentsExpanded}>
                        {commentsCollapsed ? '展开评论' : '收起评论'}
                    </button> : ownerComments.length ? <label className='zsxq-comments-filter'>
                        <Switch size='small' checked={ownerCommentOnly} onChange={this.toggleOwnerComments}/>
                        <span>只看星主（{ownerComments.length}）</span>
                    </label> : null}
                </div>
                <ul id={commentsListId} className='zsxq-comments-list' hidden={commentsCollapsed}>
                    {shownComments.map((c, i) => (
                        <li key={`${c.author}-${i}`} className={`zsxq-comment${distinguishOwner && c.owner ? ' is-owner' : ''}`}>
                            <div className='zsxq-comment-head'>
                                <span className='zsxq-comment-author'>
                                    {c.author || '匿名'}
                                    {distinguishOwner && c.owner ? <b className='zsxq-comment-owner'>星主</b> : null}
                                </span>
                                {c.time ? <span className='zsxq-comment-time'>{fmtTime(c.time)}</span> : null}
                            </div>
                            <div className='zsxq-comment-text'>{this.renderRichText(c.text || '')}</div>
                        </li>
                    ))}
                </ul>
            </div> : null}

            <SaveNoteModal open={noteModalOpen} topic={item}
                           onCancel={() => this.setState({noteModalOpen: false})}/>
        </article>
    }
}
