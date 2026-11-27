import React from 'react'
import {ArrowLeftOutlined, ReloadOutlined} from '@ant-design/icons'
import {Button, Empty, Spin, Tooltip} from 'antd'
import {HttpClient, Page, history} from '@jiangood/open-admin'
import TopicPost from '../TopicPost'
import '../zsxq.css'

export const pageMeta = {title: '专栏阅读'}

const PAGE_SIZE = 20

/** 专栏阅读：普通单列信息流，按发布时间正序加载；专栏内容均为星主发布，不额外区分 */
export default class ZsxqColumnReaderPage extends React.Component {
    state = {
        column: null,
        items: [],
        page: 1,
        hasMore: true,
        loading: false,
        initialLoading: true,
        commentsByTopicId: {},
        filesByTopicId: {},
    }

    loadSeq = 0
    loadMoreLock = false

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

    goBack = () => {
        if (window.history.length > 1) window.history.back()
        else history.push('/zsxq/columns')
    }

    loadColumn = async () => {
        const columnId = this.columnId
        if (!columnId) return
        try {
            const rs = await HttpClient.get(`admin/zsxq/column/${encodeURIComponent(columnId)}`)
            this.setState({column: rs.data || null})
        } catch (_) {
            this.setState({column: null})
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
            commentsByTopicId: {},
            filesByTopicId: {},
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
            const params = {
                page,
                size: PAGE_SIZE,
                columnId,
                sort: 'sourceCreateTime',
                direction: 'ASC',
            }
            const rs = await HttpClient.post('admin/zsxq/page', null, params)
            if (seq !== this.loadSeq) return
            const data = rs.data || {}
            const content = Array.isArray(data.content) ? data.content : (Array.isArray(data) ? data : [])
            const totalElements = data.totalElements != null ? Number(data.totalElements) : content.length
            const size = data.size != null ? Number(data.size) : PAGE_SIZE
            const currentPage = data.number != null ? Number(data.number) + 1 : page
            const totalPages = data.totalPages != null ? Number(data.totalPages) : (totalElements ? Math.ceil(totalElements / size) : page)
            const nextItems = replace ? content : [...this.state.items, ...content]
            this.setState({
                items: nextItems,
                page: currentPage,
                hasMore: currentPage < totalPages,
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

    renderPost(item) {
        const {commentsByTopicId, filesByTopicId} = this.state
        const comments = commentsByTopicId[String(item.topicId)] || []
        const files = filesByTopicId[String(item.topicId)] || []
        return <TopicPost key={item.id} item={item} comments={comments} files={files}
                          distinguishOwner={false} showSourceLink={false}/>
    }

    renderList() {
        const {items, loading, initialLoading, hasMore} = this.state
        if (initialLoading) {
            return <div className='zsxq-feed-state'><Spin/></div>
        }
        if (!items.length) {
            return <div className='zsxq-feed-state'>
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description='该专栏暂无内容'/>
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
        const {column, loading, initialLoading, items} = this.state
        const subtitle = [
            column?.groupName,
            column?.topicsCount != null ? `${column.topicsCount} 篇` : '',
        ].filter(Boolean).join(' · ')
        const refresh = () => {
            this.loadColumn()
            this.reloadList(items.length === 0)
        }

        return <Page>
            <div className='zsxq-feed'>
                <header className='zsxq-feed-head'>
                    <div className='zsxq-feed-heading'>
                        <div className='zsxq-feed-title'>
                            <Button type='text' size='small' className='zsxq-feed-back'
                                    icon={<ArrowLeftOutlined/>} onClick={this.goBack} aria-label='返回专栏列表'/>
                            <h1>{column?.name || '专栏阅读'}</h1>
                        </div>
                        <p>{subtitle || '专栏'}</p>
                    </div>
                    <div className='zsxq-feed-filters'>
                        <Tooltip title='刷新'>
                            <Button icon={<ReloadOutlined/>} loading={loading && !initialLoading}
                                    onClick={refresh} aria-label='刷新'/>
                        </Tooltip>
                    </div>
                </header>
                {this.renderList()}
            </div>
        </Page>
    }
}
