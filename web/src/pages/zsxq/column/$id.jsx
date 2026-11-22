import React from 'react'
import {SearchOutlined} from '@ant-design/icons'
import {Input, Switch} from 'antd'
import {HttpClient, history} from '@jiangood/open-admin'
import SwipeReader from '../../../components/SwipeReader'
import {fmtTime, imageSrc, topicImages} from '../media'

export const pageMeta = {layout: 'blank', title: '专栏阅读'}

const PAGE_SIZE = 20

export default class ZsxqColumnReaderPage extends React.Component {
    state = {
        keyword: '',
        ownerOnly: false,
        ownerCommentOnly: false,
        column: null,
        groupName: '',
        groupOwner: '',
        items: [],
        page: 1,
        hasMore: true,
        loading: false,
        initialLoading: true,
        swipeIndex: 0,
        commentsByTopicId: {},
    }

    loadSeq = 0
    loadMoreLock = false
    searchTimer = null

    get columnId() {
        return this.props.params?.id || this.props.match?.params?.id || ''
    }

    componentDidMount() {
        this.loadColumn()
        this.reloadList(true)
    }

    componentDidUpdate(prevProps) {
        const prevId = prevProps.params?.id || prevProps.match?.params?.id
        if (prevId !== this.columnId) {
            this.loadColumn()
            this.reloadList(true)
        }
    }

    componentWillUnmount() {
        clearTimeout(this.searchTimer)
    }

    loadColumn = async () => {
        const columnId = this.columnId
        if (!columnId) return
        try {
            const rs = await HttpClient.get(`admin/zsxq/column/${encodeURIComponent(columnId)}`)
            const column = rs.data || null
            this.setState({
                column,
                groupName: column?.groupName || '',
                groupOwner: column?.groupOwner || '',
            })
        } catch (_) {
            this.setState({column: null, groupName: '', groupOwner: ''})
        }
    }

    reloadList = (initial = false) => {
        this.loadSeq += 1
        this.loadMoreLock = false
        this.setState({
            items: [],
            page: 1,
            hasMore: true,
            loading: false,
            initialLoading: initial || this.state.items.length === 0,
            swipeIndex: 0,
            commentsByTopicId: {},
        }, () => this.loadPage(1, true))
    }

    loadPage = async (page, replace = false) => {
        if (this.loadMoreLock) return
        const columnId = this.columnId
        if (!columnId) {
            this.setState({loading: false, initialLoading: false})
            return
        }
        const seq = this.loadSeq
        this.loadMoreLock = true
        this.setState({loading: true})
        try {
            const params = {page, size: PAGE_SIZE, columnId}
            const kw = this.state.keyword?.trim()
            if (kw) params.keyword = kw
            if (this.state.ownerOnly) params.ownerOnly = true
            const rs = await HttpClient.post('admin/zsxq/page', null, params)
            if (seq !== this.loadSeq) return
            const data = rs.data || {}
            const content = Array.isArray(data.content) ? data.content : (Array.isArray(data) ? data : [])
            const totalElements = data.totalElements != null ? Number(data.totalElements) : content.length
            const size = data.size != null ? Number(data.size) : PAGE_SIZE
            const currentPage = data.number != null ? Number(data.number) + 1 : page
            const totalPages = data.totalPages != null ? Number(data.totalPages) : (totalElements ? Math.ceil(totalElements / size) : page)
            this.setState(prev => ({
                items: replace ? content : [...prev.items, ...content],
                page: currentPage,
                hasMore: currentPage < totalPages,
                loading: false,
                initialLoading: false,
            }))
            await this.loadComments(content)
        } catch (_) {
            if (seq === this.loadSeq) this.setState({loading: false, initialLoading: false})
        } finally {
            if (seq === this.loadSeq) this.loadMoreLock = false
        }
    }

    loadComments = async (items) => {
        const ids = items
            .map(it => (it && it.topicId != null ? String(it.topicId).trim() : ''))
            .filter(id => id)
        if (!ids.length) return
        const seq = this.loadSeq
        try {
            const rs = await HttpClient.get('admin/zsxq/comments', {topicIds: ids}, {toastError: false, toastSuccess: false})
            if (seq !== this.loadSeq) return
            const data = rs.data || {}
            if (!data || typeof data !== 'object') return
            this.setState(prev => ({commentsByTopicId: {...prev.commentsByTopicId, ...data}}))
        } catch (_) {}
    }

    loadMore = () => {
        const {loading, hasMore, page, initialLoading} = this.state
        if (loading || initialLoading || !hasMore) return
        this.loadPage(page + 1, false)
    }

    onKeywordChange = (e) => {
        const keyword = e.target.value
        this.setState({keyword})
        clearTimeout(this.searchTimer)
        this.searchTimer = setTimeout(() => this.reloadList(false), 350)
    }

    render() {
        const {keyword, column, groupName, groupOwner, items, loading, initialLoading, hasMore, swipeIndex} = this.state
        const title = column?.name || '专栏阅读'
        const subtitle = column?.topicsCount != null ? `${column.topicsCount} 篇` : '专栏'
        const posText = items.length ? `${Math.min(swipeIndex + 1, items.length)}/${items.length}${hasMore ? '+' : ''}` : ''
        const progressPct = items.length ? Math.round(((Math.min(swipeIndex, items.length - 1) + 1) / Math.max(items.length, 1)) * 100) : 0

        return <SwipeReader
            title={title}
            subtitle={subtitle}
            badges={[{text: `专栏`, accent: true}]}
            posText={posText}
            progressPct={progressPct}
            onBack={() => { if (window.history.length > 1) window.history.back(); else history.push('/zsxq/columns') }}
            items={items}
            index={swipeIndex}
            onIndexChange={(swipeIndex) => this.setState({swipeIndex}, () => {
                if (this.state.hasMore && !this.state.loading && swipeIndex >= this.state.items.length - 2) this.loadMore()
            })}
            initialLoading={initialLoading}
            loading={loading}
            hasMore={hasMore}
            onLoadMore={this.loadMore}
            emptyDescription={keyword ? `没有匹配「${keyword}」的内容` : '该专栏暂无内容'}
            drawerTitle={column?.name || '专栏目录'}
            drawerControls={<div style={{display: 'flex', alignItems: 'center', gap: 12}}>
                <Input allowClear prefix={<SearchOutlined />} placeholder='搜索摘要' value={keyword} onChange={this.onKeywordChange} />
                <label style={{display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap', cursor: 'pointer'}}>
                    <Switch size='small' checked={this.state.ownerOnly}
                            onChange={(v) => this.setState({ownerOnly: v}, () => this.reloadList(false))} />
                    <span>只看星主</span>
                </label>
            </div>}
            renderArticle={(item) => {
                const metaParts = [fmtTime(item.sourceCreateTime || item.lastCommentTime)].filter(Boolean)
                const images = topicImages(item)
                const isOwner = !!item.author && !!groupOwner && item.author === groupOwner
                const comments = this.state.commentsByTopicId[String(item.topicId)] || []
                const ownerComments = comments.filter(c => c.owner)
                const shownComments = this.state.ownerCommentOnly ? ownerComments : comments
                return <>
                    <div className='swipe-reader-article-meta'>
                        {metaParts.map((p, i) => <span key={i}>{p}</span>)}
                        {item.author ? <span>作者 {item.author}{isOwner ? ' · 星主' : ''}</span> : null}
                        {Number(item.likesCount) > 0 ? <span>赞 {item.likesCount}</span> : null}
                        {Number(item.commentCount) > 0 ? <span>评论 {item.commentCount}</span> : null}
                        {item.lastCommentTime ? <span>最近回复 {fmtTime(item.lastCommentTime)}</span> : null}
                    </div>
                    <div className='swipe-reader-content'>{item.digest || (images.length ? '' : '（无内容）')}</div>
                    {images.length ? <div className='swipe-reader-images'>
                        {images.map((img, idx) => <img key={`${img}-${idx}`} src={imageSrc(img)} alt='' loading='lazy' />)}
                    </div> : null}
                    {comments.length ? (
                        <div className='swipe-reader-comments'>
                            <div className='swipe-reader-comments-title' style={{display: 'flex', alignItems: 'center', gap: 10}}>
                                <span>评论 ({shownComments.length}{this.state.ownerCommentOnly ? '' : `/${comments.length}`})</span>
                                {ownerComments.length ? <label style={{display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 400, cursor: 'pointer'}}>
                                    <Switch size='small' checked={this.state.ownerCommentOnly}
                                            onChange={(v) => this.setState({ownerCommentOnly: v})} />
                                    <span>只看星主（{ownerComments.length}）</span>
                                </label> : null}
                            </div>
                            <ul className='swipe-reader-comments-list'>
                                {shownComments.map((c, i) => (
                                    <li key={`${c.author}-${i}`} className='swipe-reader-comment'>
                                        <div className='swipe-reader-comment-head'>
                                            <span className='swipe-reader-comment-author'>{c.author || '匿名'}{c.owner ? <b style={{color: '#d4380d', marginLeft: 6}}>星主</b> : null}</span>
                                            {c.time ? <span className='swipe-reader-comment-time'>{fmtTime(c.time)}</span> : null}
                                        </div>
                                        <div className='swipe-reader-comment-text'>{c.text || ''}</div>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    ) : null}
                </>
            }}
            renderListItem={(item, idx, active, onClick) => <button key={item.id} type='button' className={`swipe-reader-list-item${active ? ' active' : ''}`} onClick={onClick}>
                <div className='swipe-reader-list-title'>{item.digest || '(无内容)'}</div>
                <div className='swipe-reader-list-meta'>{[fmtTime(item.sourceCreateTime || item.lastCommentTime)].filter(Boolean).join(' · ')}</div>
            </button>}
        />
    }
}
