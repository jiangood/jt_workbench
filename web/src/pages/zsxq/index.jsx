import React from 'react'
import {MoreOutlined, ReadOutlined, ReloadOutlined, SearchOutlined, TeamOutlined} from '@ant-design/icons'
import {Input, Modal, Switch, Table, Typography} from 'antd'
import {HttpClient, history} from '@jiangood/open-admin'
import SwipeReader from '../../components/SwipeReader'
import {imageSrc, topicImages} from './media'

export const pageMeta = {layout: 'blank', title: '知识星球'}

const PAGE_SIZE = 20

function fmtTime(v) {
    if (!v) return ''
    const s = String(v)
    if (s.includes('T')) return s.replace('T', ' ').slice(0, 16).replace(/-/g, '/')
    return s.slice(0, 16)
}

export default class ZsxqReaderPage extends React.Component {
    state = {
        keyword: '',
        ownerOnly: false,
        ownerCommentOnly: false,
        items: [],
        page: 1,
        hasMore: true,
        loading: false,
        initialLoading: true,
        swipeIndex: 0,
        stats: {topics: 0, groups: 0, columns: 0},
        groups: [],
        columns: [],
        commentsByTopicId: {},
        groupModalOpen: false,
        columnModalOpen: false,
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
            swipeIndex: 0,
            commentsByTopicId: {},
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
        this.setState({columnModalOpen: false})
        history.push(`/zsxq/column/${encodeURIComponent(cid)}`)
    }

    renderGroupsModal() {
        const {groups} = this.state
        return <Modal title='星球信息' open={this.state.groupModalOpen} onCancel={() => this.setState({groupModalOpen: false})} footer={null} width={720}>
            <Table
                rowKey='id'
                size='small'
                pagination={false}
                dataSource={groups}
                locale={{emptyText: '暂无星球'}}
                columns={[
                    {
                        title: '名称', dataIndex: 'name',
                        render: (v, row) => <div>
                            <div>{v}</div>
                            {row.introduction ? <Typography.Text type='secondary' style={{fontSize: 12}}>{row.introduction}</Typography.Text> : null}
                        </div>,
                    },
                    {title: '星主', dataIndex: 'owner', width: 100, render: (v) => v || '—'},
                    {title: '成员', dataIndex: 'memberCount', width: 80, align: 'right', render: (v) => Number(v) || 0},
                ]}
            />
        </Modal>
    }

    renderColumnsModal() {
        const {columns, groups} = this.state
        return <Modal title='专栏列表' open={this.state.columnModalOpen} onCancel={() => this.setState({columnModalOpen: false})} footer={null} width={760}>
            <Table
                rowKey='columnId'
                size='small'
                pagination={false}
                dataSource={columns}
                locale={{emptyText: '暂无专栏，等待专栏同步任务执行'}}
                onRow={(row) => ({onClick: () => this.openColumn(row), style: {cursor: 'pointer'}})}
                columns={[
                    {
                        title: '专栏', dataIndex: 'name',
                        render: (v, row) => <div>
                            <div style={{fontWeight: 500}}>{v || row.columnId}</div>
                            {row.description ? <Typography.Text type='secondary' style={{fontSize: 12}} ellipsis>{row.description}</Typography.Text> : null}
                        </div>,
                    },
                    {
                        title: '星球', dataIndex: 'groupId', width: 160,
                        render: (gid) => groups.find(g => String(g.id) === String(gid))?.name || gid || '—',
                    },
                    {title: '帖子', dataIndex: 'topicsCount', width: 80, align: 'right', render: (v) => Number(v) || 0},
                    {title: '操作', width: 80, render: (_, row) => <a onClick={(e) => { e.stopPropagation(); this.openColumn(row) }}>阅读</a>},
                ]}
            />
        </Modal>
    }

    render() {
        const {keyword, items, loading, initialLoading, hasMore, stats, groups, columns, swipeIndex} = this.state
        const current = items[swipeIndex] || null
        const currentGroup = current ? groups.find(g => String(g.id) === String(current.groupId)) : null
        const currentColumn = current ? columns.find(c => String(c.columnId) === String(current.columnId)) : null
        const subtitle = [currentGroup?.name, currentColumn?.name].filter(Boolean).join(' · ')
            || (current?.sourceCreateTime ? fmtTime(current.sourceCreateTime) : '帖子')
        const posText = items.length ? `${Math.min(swipeIndex + 1, items.length)}/${items.length}${hasMore ? '+' : ''}` : ''
        const progressPct = items.length ? Math.round(((Math.min(swipeIndex, items.length - 1) + 1) / Math.max(items.length, 1)) * 100) : 0

        const moreItems = [
            {key: 'refresh', icon: <ReloadOutlined />, label: '刷新'},
            {key: 'columns', icon: <ReadOutlined />, label: '专栏列表'},
            {key: 'groups', icon: <TeamOutlined />, label: '星球信息'},
        ]
        const onMore = ({key}) => {
            if (key === 'refresh') { this.loadBase(); this.reloadList(false) }
            else if (key === 'groups') this.setState({groupModalOpen: true})
            else if (key === 'columns') this.setState({columnModalOpen: true})
        }

        return <>
            <SwipeReader
                title='知识星球'
                subtitle={subtitle}
                badges={[{text: `帖子 ${stats.topics ?? 0}`, accent: true}, {text: `专栏 ${stats.columns ?? 0}`}]}
                posText={posText}
                progressPct={progressPct}
                onBack={() => history.push('/')}
                moreItems={moreItems}
                onMore={onMore}
                moreIcon={<MoreOutlined />}
                items={items}
                index={swipeIndex}
                onIndexChange={(swipeIndex) => this.setState({swipeIndex}, () => {
                    if (this.state.hasMore && !this.state.loading && swipeIndex >= this.state.items.length - 2) this.loadMore()
                })}
                initialLoading={initialLoading}
                loading={loading}
                hasMore={hasMore}
                onLoadMore={this.loadMore}
                emptyDescription={keyword ? `没有匹配「${keyword}」的内容` : '暂无内容'}
                drawerTitle='帖子列表'
                drawerControls={<div style={{display: 'flex', alignItems: 'center', gap: 12}}>
                    <Input allowClear prefix={<SearchOutlined />} placeholder='搜索摘要' value={keyword} onChange={this.onKeywordChange} />
                    <label style={{display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap', cursor: 'pointer'}}>
                        <Switch size='small' checked={this.state.ownerOnly}
                                onChange={(v) => this.setState({ownerOnly: v}, () => this.reloadList(false))} />
                        <span>只看星主</span>
                    </label>
                </div>}
                renderArticle={(item) => {
                    const group = groups.find(g => String(g.id) === String(item.groupId))
                    const column = columns.find(c => String(c.columnId) === String(item.columnId))
                    const time = fmtTime(item.sourceCreateTime || item.lastCommentTime)
                    const images = topicImages(item)
                    const author = item.author
                    const isOwner = !!author && !!group?.owner && author === group.owner
                    const comments = this.state.commentsByTopicId[String(item.topicId)] || []
                    const ownerComments = comments.filter(c => c.owner)
                    const shownComments = this.state.ownerCommentOnly ? ownerComments : comments
                    return <>
                        <div className='swipe-reader-article-meta'>
                            {group?.name ? <span>{group.name}</span> : null}
                            {author ? <span>作者 {author}{isOwner ? ' · 星主' : ''}</span> : null}
                            {column?.name ? <a style={{color: 'inherit'}} onClick={(e) => { e.preventDefault(); this.openColumn(column) }}>{column.name}</a> : null}
                            {time ? <span>{time}</span> : null}
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
                renderListItem={(item, idx, active, onClick) => {
                    const group = groups.find(g => String(g.id) === String(item.groupId))
                    const column = columns.find(c => String(c.columnId) === String(item.columnId))
                    return <button key={item.id} type='button' className={`swipe-reader-list-item${active ? ' active' : ''}`} onClick={onClick}>
                        <div className='swipe-reader-list-title'>{item.digest || '(无内容)'}</div>
                        <div className='swipe-reader-list-meta'>{[[group?.name, column?.name].filter(Boolean).join(' · '), fmtTime(item.sourceCreateTime || item.lastCommentTime)].filter(Boolean).join(' · ')}</div>
                    </button>
                }}
            />
            {this.renderGroupsModal()}
            {this.renderColumnsModal()}
        </>
    }
}
