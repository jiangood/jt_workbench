import React from 'react'
import {ReloadOutlined, SearchOutlined} from '@ant-design/icons'
import {Button, Empty, Input, Select, Spin, Switch, Tag, Tooltip} from 'antd'
import {HttpClient, Page, history} from '@jiangood/open-admin'
import {fmtTime, imageSrc, topicImages} from './media'
import './zsxq.css'

export const pageMeta = {title: '知识星球'}

const PAGE_SIZE = 20

/** 时间排序选项：发布时间（默认倒序）/ 发布时间正序 / 最近回复倒序 / 最近回复正序 */
const SORT_OPTIONS = [
    {value: 'sourceCreateTime|DESC', label: '发布时间倒序'},
    {value: 'sourceCreateTime|ASC', label: '发布时间正序'},
    {value: 'lastCommentTime|DESC', label: '最近回复倒序'},
    {value: 'lastCommentTime|ASC', label: '最近回复正序'},
]

/** 摘要超过该长度时默认折叠，避免单条帖子占满整屏 */
const CLAMP_THRESHOLD = 600

/** 知识星球阅读页：传统单列信息流（帖子正文、图片与评论直接展开） */
export default class ZsxqReaderPage extends React.Component {
    state = {
        keyword: '',
        sort: 'sourceCreateTime|DESC',
        ownerOnly: false,
        items: [],
        page: 1,
        hasMore: true,
        loading: false,
        initialLoading: true,
        stats: {topics: 0, groups: 0, columns: 0},
        groups: [],
        columns: [],
        commentsByTopicId: {},
        expandedById: {},
        ownerCommentOnlyById: {},
    }

    loadSeq = 0
    loadMoreLock = false
    searchTimer = null

    componentDidMount() {
        this.loadBase()
        this.reloadList(true)
    }

    componentWillUnmount() {
        clearTimeout(this.searchTimer)
    }

    loadBase = async () => {
        try {
            const [statsRs, groupsRs, columnsRs] = await Promise.all([
                HttpClient.get('admin/zsxq/stats'),
                HttpClient.get('admin/zsxq/groups'),
                HttpClient.get('admin/zsxq/columns'),
            ])
            this.setState({
                stats: statsRs.data || {},
                groups: groupsRs.data || [],
                columns: columnsRs.data || [],
            })
        } catch (_) {}
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
            expandedById: {},
            ownerCommentOnlyById: {},
        }, () => this.loadPage(1, true))
    }

    loadPage = async (page, replace = false) => {
        if (this.loadMoreLock) return
        const seq = this.loadSeq
        this.loadMoreLock = true
        this.setState({loading: true})
        try {
            const params = {page, size: PAGE_SIZE}
            const kw = this.state.keyword?.trim()
            if (kw) params.keyword = kw
            if (this.state.ownerOnly) params.ownerOnly = true
            const [sortProp, sortDir] = (this.state.sort || 'sourceCreateTime|DESC').split('|')
            params.sort = sortProp || 'sourceCreateTime'
            params.direction = sortDir || 'DESC'
            const rs = await HttpClient.post('admin/zsxq/page', null, params)
            if (seq !== this.loadSeq) return
            const data = rs.data || {}
            const content = Array.isArray(data.content) ? data.content : (Array.isArray(data) ? data : [])
            const totalElements = data.totalElements != null ? Number(data.totalElements) : content.length
            const size = data.size != null ? Number(data.size) : PAGE_SIZE
            const currentPage = data.number != null ? Number(data.number) + 1 : page
            const totalPages = data.totalPages != null ? Number(data.totalPages) : (totalElements ? Math.ceil(totalElements / size) : page)
            const hasMore = currentPage < totalPages
            const nextItems = replace ? content : [...(this.state.items || []), ...content]
            this.setState({
                items: nextItems,
                page: currentPage,
                hasMore,
                loading: false,
                initialLoading: false,
            })
            await this.loadComments(nextItems)
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

    openColumn = (column) => {
        const cid = column?.columnId
        if (!cid) return
        history.push(`/zsxq/column/${encodeURIComponent(cid)}`)
    }

    toggleExpanded = (key) => {
        this.setState(prev => ({
            expandedById: {...prev.expandedById, [key]: !prev.expandedById[key]},
        }))
    }

    toggleOwnerComments = (key) => {
        this.setState(prev => ({
            ownerCommentOnlyById: {...prev.ownerCommentOnlyById, [key]: !prev.ownerCommentOnlyById[key]},
        }))
    }

    renderPost(item) {
        const key = String(item.topicId ?? item.id)
        const group = this.state.groups.find(g => String(g.id) === String(item.groupId))
        const column = this.state.columns.find(c => String(c.columnId) === String(item.columnId))
        const author = item.author
        const isOwner = !!author && !!group?.owner && author === group.owner
        const images = topicImages(item)
        const comments = this.state.commentsByTopicId[String(item.topicId)] || []
        const ownerComments = comments.filter(c => c.owner)
        const starOnly = !!this.state.ownerCommentOnlyById[key]
        const shownComments = starOnly ? ownerComments : comments
        const text = item.digest || ''
        const longText = text.length > CLAMP_THRESHOLD
        const expanded = !!this.state.expandedById[key]

        return <article className='zsxq-post' key={item.id}>
            <div className='zsxq-post-head'>
                <div className='zsxq-post-author'>
                    <span>{author || '匿名'}</span>
                    {isOwner ? <Tag color='magenta' bordered={false}>星主</Tag> : null}
                </div>
                <span className='zsxq-post-time'>{fmtTime(item.sourceCreateTime)}</span>
            </div>

            <div className='zsxq-post-meta'>
                {column?.name ? <a href={`#/zsxq/column/${encodeURIComponent(column.columnId)}`}
                                   onClick={(e) => { e.preventDefault(); this.openColumn(column) }}>{column.name}</a> : null}
                {Number(item.likesCount) > 0 ? <span>赞 {item.likesCount}</span> : null}
                {Number(item.commentCount) > 0 ? <span>评论 {item.commentCount}</span> : null}
                {item.lastCommentTime ? <span>最近回复 {fmtTime(item.lastCommentTime)}</span> : null}
            </div>

            {text ? <>
                <div className={`zsxq-post-text${longText && !expanded ? ' is-clamped' : ''}`}>{text}</div>
                {longText ? <button type='button' className='zsxq-post-toggle' onClick={() => this.toggleExpanded(key)}>
                    {expanded ? '收起' : '展开全文'}
                </button> : null}
            </> : images.length ? null : <div className='zsxq-post-text'>（无内容）</div>}

            {images.length ? <div className='zsxq-post-images'>
                {images.map((img, idx) => {
                    const src = imageSrc(img)
                    return <a key={`${img}-${idx}`} href={src} target='_blank' rel='noreferrer'>
                        <img src={src} alt='' loading='lazy'/>
                    </a>
                })}
            </div> : null}

            {comments.length ? <div className='zsxq-post-comments'>
                <div className='zsxq-comments-head'>
                    <span>评论 {shownComments.length}{starOnly ? ` / ${comments.length}` : ''}</span>
                    {ownerComments.length ? <label className='zsxq-comments-filter'>
                        <Switch size='small' checked={starOnly} onChange={() => this.toggleOwnerComments(key)}/>
                        <span>只看星主（{ownerComments.length}）</span>
                    </label> : null}
                </div>
                <ul className='zsxq-comments-list'>
                    {shownComments.map((c, i) => (
                        <li key={`${c.author}-${i}`} className='zsxq-comment'>
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

    renderList() {
        const {keyword, items, loading, initialLoading, hasMore} = this.state
        if (initialLoading) {
            return <div className='zsxq-feed-state'><Spin/></div>
        }
        if (!items.length) {
            return <div className='zsxq-feed-state'>
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE}
                       description={keyword ? `没有匹配「${keyword}」的内容` : '暂无内容'}/>
            </div>
        }
        return <div className='zsxq-feed-list'>
            {items.map(item => this.renderPost(item))}
            <div className='zsxq-feed-more'>
                {loading ? <Spin size='small'/>
                    : hasMore ? <Button onClick={this.loadMore}>加载更多</Button>
                        : <span>已加载全部 {items.length} 条</span>}
            </div>
        </div>
    }

    render() {
        const {keyword, sort, ownerOnly, loading, initialLoading, stats, groups, columns} = this.state
        const topicsCount = stats.topics ?? 0
        const groupsCount = stats.groups ?? groups.length
        const columnsCount = stats.columns ?? columns.length

        return <Page>
            <div className='zsxq-feed'>
                <header className='zsxq-feed-head'>
                    <div className='zsxq-feed-heading'>
                        <h1>知识星球</h1>
                        <p>帖子 {topicsCount} · 星球 {groupsCount} · 专栏 {columnsCount}</p>
                    </div>
                    <div className='zsxq-feed-filters'>
                        <Input
                            className='zsxq-feed-search'
                            allowClear
                            prefix={<SearchOutlined/>}
                            placeholder='搜索帖子内容'
                            value={keyword}
                            onChange={this.onKeywordChange}
                        />
                        <label className='zsxq-feed-switch'>
                            <Switch size='small' checked={ownerOnly}
                                    onChange={(v) => this.setState({ownerOnly: v}, () => this.reloadList(false))}/>
                            <span>只看星主</span>
                        </label>
                        <Select className='zsxq-feed-sort' value={sort} options={SORT_OPTIONS}
                                onChange={(v) => this.setState({sort: v}, () => this.reloadList(false))}/>
                        <Tooltip title='刷新'>
                            <Button icon={<ReloadOutlined/>} loading={loading && !initialLoading} aria-label='刷新'
                                    onClick={() => { this.loadBase(); this.reloadList(false) }}/>
                        </Tooltip>
                    </div>
                </header>

                {this.renderList()}
            </div>
        </Page>
    }
}
