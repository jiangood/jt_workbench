import React from 'react'
import {Image, Switch, Tag} from 'antd'
import {fmtTime, imageSrc, topicImages} from './media'

/** 摘要超过该长度时默认折叠，避免单条帖子占满整屏 */
const CLAMP_THRESHOLD = 600

/** 单条星球话题：作者、正文、图片与评论；折叠/只看星主评论由组件自身维护 */
export default class TopicPost extends React.Component {
    state = {
        expanded: false,
        ownerCommentOnly: false,
        previewIndex: -1,
    }

    toggleExpanded = () => this.setState(prev => ({expanded: !prev.expanded}))

    toggleOwnerComments = () => this.setState(prev => ({ownerCommentOnly: !prev.ownerCommentOnly}))

    togglePreview = (index, open) => this.setState({previewIndex: open ? index : -1})

    render() {
        const {item, comments = [], isOwner = false, meta = null} = this.props
        const {expanded, ownerCommentOnly, previewIndex} = this.state
        const images = topicImages(item)
        const ownerComments = comments.filter(c => c.owner)
        const shownComments = ownerCommentOnly ? ownerComments : comments
        const text = item.digest || ''
        const longText = text.length > CLAMP_THRESHOLD
        // 专栏文章：优先用同步到的原文地址；没有时回退到星球话题详情页
        const sourceUrl = item.articleUrl
            || (item.columnId && item.topicId
                ? `https://wx.zsxq.com/dweb2/index/topic_detail/${encodeURIComponent(item.topicId)}`
                : '')

        return <article className={`zsxq-post${isOwner ? ' is-owner' : ''}`}>
            <div className='zsxq-post-head'>
                <div className='zsxq-post-author'>
                    <span>{item.author || '匿名'}</span>
                    {isOwner ? <Tag color='magenta' bordered={false}>星主</Tag> : null}
                </div>
                <span className='zsxq-post-time'>{fmtTime(item.sourceCreateTime)}</span>
            </div>

            <div className='zsxq-post-meta'>
                {meta}
                {sourceUrl ? <a className='zsxq-post-source' href={sourceUrl} target='_blank'
                                rel='noreferrer'>查看原文</a> : null}
                {Number(item.likesCount) > 0 ? <span>赞 {item.likesCount}</span> : null}
                {Number(item.commentCount) > 0 ? <span>评论 {item.commentCount}</span> : null}
                {item.lastCommentTime ? <span>最近回复 {fmtTime(item.lastCommentTime)}</span> : null}
            </div>

            {text ? <>
                <div className={`zsxq-post-text${longText && !expanded ? ' is-clamped' : ''}`}>{text}</div>
                {longText ? <button type='button' className='zsxq-post-toggle' onClick={this.toggleExpanded}>
                    {expanded ? '收起' : '展开全文'}
                </button> : null}
            </> : images.length ? null : <div className='zsxq-post-text'>
                {sourceUrl ? '（长文章，点击「查看原文」阅读）' : '（无内容）'}
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
                            imageRender: (node, info) => React.cloneElement(node, {
                                className: `${node.props.className || ''} zsxq-post-preview-img`,
                                onClick: info.actions.onClose,
                            }),
                        }}
                    />
                })}
            </div> : null}

            {comments.length ? <div className='zsxq-post-comments'>
                <div className='zsxq-comments-head'>
                    <span>评论 {shownComments.length}{ownerCommentOnly ? ` / ${comments.length}` : ''}</span>
                    {ownerComments.length ? <label className='zsxq-comments-filter'>
                        <Switch size='small' checked={ownerCommentOnly} onChange={this.toggleOwnerComments}/>
                        <span>只看星主（{ownerComments.length}）</span>
                    </label> : null}
                </div>
                <ul className='zsxq-comments-list'>
                    {shownComments.map((c, i) => (
                        <li key={`${c.author}-${i}`} className={`zsxq-comment${c.owner ? ' is-owner' : ''}`}>
                            <div className='zsxq-comment-head'>
                                <span className='zsxq-comment-author'>
                                    {c.author || '匿名'}
                                    {c.owner ? <b className='zsxq-comment-owner'>星主</b> : null}
                                </span>
                                {c.time ? <span className='zsxq-comment-time'>{fmtTime(c.time)}</span> : null}
                            </div>
                            <div className='zsxq-comment-text'>{c.text || ''}</div>
                        </li>
                    ))}
                </ul>
            </div> : null}
        </article>
    }
}
