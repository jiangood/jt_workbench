import React from 'react'
import {ArrowDownOutlined, ArrowUpOutlined, ReloadOutlined, SearchOutlined} from '@ant-design/icons'
import {Button, Empty, Input, Segmented, Spin, Switch, Tooltip} from 'antd'
import {HttpClient, Page} from '@jiangood/open-admin'
import TopicPost from './TopicPost'
import './zsxq.css'

export const pageMeta = {title: '知识星球'}

const PAGE_SIZE = 20

/** 发布时间排序字段；唯一排序方式，单击按钮切换正序/倒序 */
const SORT_PROP = 'sourceCreateTime'

/** 知识星球阅读页：传统单列信息流（帖子正文、图片与评论直接展开） */
export default class ZsxqReaderPage extends React.Component {
    state = {
        keyword: '',
        sort: `${SORT_PROP}|DESC`,
        ownerOnly: false,
        read: 'UNREAD',
        items: [],
        page: 1,
        hasMore: true,
        loading: false,
        initialLoading: true,
        stats: {topics: 0, groups: 0},
        groups: [],
        commentsByTopicId: {},
        filesByTopicId: {},
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
            const [statsRs, groupsRs] = await Promise.all([
                HttpClient.get('admin/zsxq/stats'),
                HttpClient.get('admin/zsxq/groups'),
            ])
            this.setState({
                stats: statsRs.data || {},
                groups: groupsRs.data || [],
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
            if (this.state.read) params.read = this.state.read
            const [sortProp, sortDir] = (this.state.sort || `${SORT_PROP}|DESC`).split('|')
            params.sort = sortProp || SORT_PROP
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
            await Promise.all([this.loadComments(nextItems), this.loadFiles(nextItems)])
        } catch (_) {
            if (seq === this.loadSeq) this.setState({loading: false, initialLoading: false})
        } finally {
            if (seq === this.loadSeq) this.loadMoreLock = false
        }
    }

    loadFiles = async (items) => {
        const ids = items
            .map(it => (it && it.topicId != null ? String(it.topicId).trim() : ''))
            .filter(id => id)
        if (!ids.length) return
        const seq = this.loadSeq
        try {
            const rs = await HttpClient.get('admin/zsxq/files', {topicIds: ids}, {toastError: false, toastSuccess: false})
            if (seq !== this.loadSeq) return
            const data = rs.data || {}
            if (!data || typeof data !== 'object') return
            this.setState(prev => ({filesByTopicId: {...prev.filesByTopicId, ...data}}))
        } catch (_) {}
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

    onReadChange = (id, read) => {
        this.setState(prev => {
            const nextRead = !!read
            const items = prev.items || []
            const oldItem = items.find(it => it.id === id)
            const oldRead = !!oldItem?.read
            const stats = prev.stats || {}
            const rc = stats.read ? {...stats.read} : null
            if (rc && oldRead !== nextRead) {
                if (nextRead) {
                    rc.read = (Number(rc.read) || 0) + 1
                    rc.unread = Math.max(0, (Number(rc.unread) || 0) - 1)
                } else {
                    rc.unread = (Number(rc.unread) || 0) + 1
                    rc.read = Math.max(0, (Number(rc.read) || 0) - 1)
                }
            }
            const filter = prev.read
            const remove = (filter === 'UNREAD' && nextRead) || (filter === 'READ' && !nextRead)
            const nextItems = remove
                ? items.filter(it => it.id !== id)
                : items.map(it => it.id === id ? {...it, read: nextRead} : it)
            return rc ? {items: nextItems, stats: {...stats, read: rc}} : {items: nextItems}
        })
    }

    renderPost(item) {
        const group = this.state.groups.find(g => String(g.id) === String(item.groupId))
        const author = item.author
        const isOwner = !!author && !!group?.owner && author === group.owner
        const comments = this.state.commentsByTopicId[String(item.topicId)] || []
        const files = this.state.filesByTopicId[String(item.topicId)] || []

        return <TopicPost key={item.id} item={item} comments={comments} files={files} isOwner={isOwner}
                          collapseCommentsWithoutOwner={this.state.ownerOnly}
                          onReadChange={this.onReadChange}/>
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
        const {keyword, sort, ownerOnly, loading, initialLoading, stats, groups} = this.state
        const sortAsc = sort === `${SORT_PROP}|ASC`
        const topicsCount = stats.topics ?? 0
        const groupsCount = stats.groups ?? groups.length

        return <Page>
            <div className='zsxq-feed'>
                <header className='zsxq-feed-head'>
                    <div className='zsxq-feed-heading'>
                        <h1>知识星球</h1>
                        <p>帖子 {topicsCount} · 星球 {groupsCount}</p>
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
                        <Segmented
                            size='middle'
                            value={this.state.read}
                            options={[
                                {label: `未读 ${stats?.read?.unread ?? 0}`, value: 'UNREAD'},
                                {label: `已读 ${stats?.read?.read ?? 0}`, value: 'READ'},
                                {label: `全部 ${stats?.read?.all ?? 0}`, value: 'ALL'},
                            ]}
                            onChange={(v) => this.setState({read: v}, () => this.reloadList(false))}
                        />
                        <label className='zsxq-feed-switch'>
                            <Switch size='small' checked={ownerOnly}
                                    onChange={(v) => this.setState({ownerOnly: v}, () => this.reloadList(false))}/>
                            <span>只看星主</span>
                        </label>
                        <Tooltip title={sortAsc ? '发布时间：正序' : '发布时间：倒序'}>
                            <Button className='zsxq-feed-sort'
                                    aria-label={sortAsc ? '发布时间正序' : '发布时间倒序'}
                                    icon={sortAsc ? <ArrowUpOutlined/> : <ArrowDownOutlined/>}
                                    onClick={() => this.setState(
                                        s => ({sort: `${SORT_PROP}|${s.sort === `${SORT_PROP}|ASC` ? 'DESC' : 'ASC'}`}),
                                        () => this.reloadList(false),
                                    )}/>
                        </Tooltip>
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
