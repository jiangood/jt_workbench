import React from 'react'
import {
    DeleteOutlined,
    MoreOutlined,
    PlusOutlined,
    ReloadOutlined,
    StarFilled,
    StarOutlined,
} from '@ant-design/icons'
import {
    Button,
    Dropdown,
    Empty,
    Input,
    Modal,
    Segmented,
    Space,
    Spin,
    Switch,
    Table,
    Tag,
    Tooltip,
    Typography,
    message,
} from 'antd'
import DOMPurify from 'dompurify'
import {HttpClient, Page, PermUtils} from '@jiangood/open-admin'
import './news.css'

export const pageMeta = {title: '资讯'}

const PAGE_SIZE = 20

/** 正文末尾滑过阅读区中心线后，才提交自动已读 */
const READ_COMMIT_RATIO = 0.5

/** 自动已读的最短可见停留，避免快速划过或最后一条立刻被标记 */
const AUTO_READ_DWELL_MS = 800

/** 正文纯文本超过该长度时默认折叠 */
const CLAMP_TEXT_LENGTH = 600

function fmtTime(v) {
    if (!v) return ''
    const s = String(v)
    if (s.includes('T')) return s.replace('T', ' ').slice(0, 16).replace(/-/g, '/')
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s)) return s.slice(0, 16).replace(/-/g, '/')
    const d = new Date(Number(v))
    if (!Number.isNaN(d.getTime())) {
        const pad = (n) => String(n).padStart(2, '0')
        return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
    }
    return s.slice(0, 16)
}

function sanitize(html) {
    return DOMPurify.sanitize(html || '', {
        FORBID_TAGS: ['script', 'style', 'iframe', 'object'],
        FORBID_ATTR: ['onerror', 'onload', 'onclick'],
    })
}

function plainTextLength(html) {
    return String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().length
}

/** 资讯阅读页：传统单列信息流（未读 / 已读 / 收藏，正文直接展开） */
export default class NewsReaderPage extends React.Component {
    state = {
        tab: 'unread', // unread | read | fav
        items: [],
        page: 1,
        hasMore: true,
        loading: false,
        initialLoading: true,
        stats: {unread: 0, fav: 0, total: 0, recent24h: 0, sources: 0},
        sources: [],
        blocks: [],
        expandedById: {},
        sourceModalOpen: false,
        blockModalOpen: false,
        sourceForm: {name: '', url: '', type: 'rss'},
        blockWord: '',
    }

    loadSeq = 0
    loadMoreLock = false
    markingReadIds = new Set()
    feedRef = React.createRef()
    scrollRoot = null
    readMarkers = new Map()
    readMarkerRefs = new Map()
    readCompleteAt = new Map()
    readTimers = new Map()
    readObserver = null
    readRaf = null
    hasScrolled = false

    componentDidMount() {
        this.scrollRoot = this.feedRef.current?.closest('.oa-page') || null
        if (typeof IntersectionObserver !== 'undefined') {
            this.readObserver = new IntersectionObserver(this.handleReadMarkerIntersection, {
                root: this.scrollRoot,
                threshold: 1,
            })
        }
        this.scrollRoot?.addEventListener('scroll', this.handleScroll, {passive: true})
        window.addEventListener('resize', this.scheduleReadCheck)
        this.loadBase()
        this.reloadList(true)
    }

    componentWillUnmount() {
        this.readObserver?.disconnect()
        this.scrollRoot?.removeEventListener('scroll', this.handleScroll)
        window.removeEventListener('resize', this.scheduleReadCheck)
        if (this.readRaf != null) cancelAnimationFrame(this.readRaf)
        for (const timer of this.readTimers.values()) clearTimeout(timer)
        this.readTimers.clear()
        this.readMarkers.clear()
        this.readMarkerRefs.clear()
        this.readCompleteAt.clear()
    }

    clearReadTimer = id => {
        const timer = this.readTimers.get(id)
        if (timer != null) clearTimeout(timer)
        this.readTimers.delete(id)
    }

    getReadMarkerRef = key => {
        let ref = this.readMarkerRefs.get(key)
        if (!ref) {
            ref = node => this.setReadMarkerRef(key, node)
            this.readMarkerRefs.set(key, ref)
        }
        return ref
    }

    setReadMarkerRef = (key, node) => {
        const previous = this.readMarkers.get(key)
        if (previous === node) return
        if (previous) this.readObserver?.unobserve(previous)
        if (node) {
            this.readMarkers.set(key, node)
            this.readObserver?.observe(node)
        } else {
            this.readMarkers.delete(key)
            this.readMarkerRefs.delete(key)
            this.readCompleteAt.delete(key)
            this.clearReadTimer(key)
        }
    }

    handleReadMarkerIntersection = entries => {
        if (this.state.tab !== 'unread') return
        for (const entry of entries) {
            const id = entry.target.dataset.newsId
            if (this.readMarkers.get(id) !== entry.target) continue
            if (entry.isIntersecting && entry.intersectionRatio >= 1 && !this.readCompleteAt.has(id)) {
                this.readCompleteAt.set(id, Date.now())
            }
        }
        this.scheduleReadCheck()
    }

    handleScroll = () => {
        this.hasScrolled = true
        this.scheduleReadCheck()
    }

    scheduleReadCheck = () => {
        if (this.readRaf != null) return
        this.readRaf = requestAnimationFrame(this.checkReadPositions)
    }

    scheduleReadCommit = (id, delay) => {
        if (this.readTimers.has(id)) return
        const timer = setTimeout(() => {
            this.readTimers.delete(id)
            this.scheduleReadCheck()
        }, delay)
        this.readTimers.set(id, timer)
    }

    checkReadPositions = () => {
        this.readRaf = null
        if (this.state.tab !== 'unread' || !this.scrollRoot) return
        const rootRect = this.scrollRoot.getBoundingClientRect()
        const canScroll = this.scrollRoot.scrollHeight - this.scrollRoot.clientHeight > 2
        if (!this.hasScrolled && canScroll) return
        const atBottom = this.scrollRoot.scrollHeight - this.scrollRoot.scrollTop - this.scrollRoot.clientHeight <= 2
        const centerY = rootRect.top + rootRect.height * READ_COMMIT_RATIO
        for (const [id, marker] of this.readMarkers) {
            const seenAt = this.readCompleteAt.get(id)
            if (seenAt == null) continue
            const markerRect = marker.getBoundingClientRect()
            const passedCenter = this.hasScrolled && markerRect.bottom <= centerY
            const visibleAtBottom = atBottom && markerRect.bottom <= rootRect.bottom && markerRect.bottom >= rootRect.top
            if (!passedCenter && !visibleAtBottom) continue
            const remaining = AUTO_READ_DWELL_MS - (Date.now() - seenAt)
            if (remaining > 0) {
                this.scheduleReadCommit(id, remaining)
                continue
            }
            this.readCompleteAt.delete(id)
            this.clearReadTimer(id)
            const item = this.state.items.find(it => String(it.id) === id)
            if (item?.status === 'unread') this.markRead(item, {remove: false})
        }
    }

    loadBase = async () => {
        try {
            const [statsRs, srcRs, blockRs] = await Promise.all([
                HttpClient.get('admin/news/stats'),
                HttpClient.get('admin/news/sources'),
                HttpClient.get('admin/news/blocks'),
            ])
            this.setState({
                stats: statsRs.data || {},
                sources: srcRs.data || [],
                blocks: blockRs.data || [],
            })
        } catch (_) {}
    }

    loadStats = () => {
        HttpClient.get('admin/news/stats').then(rs => this.setState({stats: rs.data || {}})).catch(() => {})
    }

    matchBlocks = (item) => {
        const blocks = this.state.blocks || []
        if (!blocks.length) return false
        const text = `${item.title || ''} ${item.author || ''}`.toLowerCase()
        return blocks.some(b => b.enabled !== false && text.includes(String(b.word || '').toLowerCase()))
    }

    reloadList = (initial = false) => {
        this.loadSeq += 1
        this.loadMoreLock = false
        this.hasScrolled = false
        for (const timer of this.readTimers.values()) clearTimeout(timer)
        this.readTimers.clear()
        this.readCompleteAt.clear()
        this.setState({
            items: [],
            page: 1,
            hasMore: true,
            loading: false,
            initialLoading: initial || this.state.items.length === 0,
            expandedById: {},
        }, () => this.loadPage(1, true))
    }

    loadPage = async (page, replace = false) => {
        if (this.loadMoreLock) return
        const seq = this.loadSeq
        this.loadMoreLock = true
        this.setState({loading: true})
        try {
            const params = {
                page,
                size: PAGE_SIZE,
                status: this.state.tab,
            }
            const rs = await HttpClient.post('admin/news/page', null, params)
            if (seq !== this.loadSeq) return
            const data = rs.data || {}
            const content = Array.isArray(data.content) ? data.content : (Array.isArray(data) ? data : [])
            const totalElements = data.totalElements != null ? Number(data.totalElements) : content.length
            const size = data.size != null ? Number(data.size) : PAGE_SIZE
            const currentPage = data.number != null ? Number(data.number) + 1 : page
            const totalPages = data.totalPages != null ? Number(data.totalPages) : (totalElements ? Math.ceil(totalElements / size) : page)
            const hasMore = currentPage < totalPages
            const visible = content.filter(i => !this.matchBlocks(i))

            this.setState(prev => ({
                items: replace ? visible : [...prev.items, ...visible],
                page: currentPage,
                hasMore,
                loading: false,
                initialLoading: false,
            }), () => {
                if (visible.length === 0 && hasMore) {
                    this.loadMoreLock = false
                    this.loadPage(currentPage + 1, false)
                }
            })
        } catch (_) {
            if (seq === this.loadSeq) this.setState({loading: false, initialLoading: false})
        } finally {
            if (seq === this.loadSeq) this.loadMoreLock = false
        }
    }

    loadMore = () => {
        const {loading, hasMore, page, initialLoading} = this.state
        if (loading || initialLoading || !hasMore) return
        this.loadPage(page + 1, false)
    }

    markRead = async (record, {remove = true} = {}) => {
        if (!record) return
        const key = String(record.id)
        const current = this.state.items.find(it => String(it.id) === key) || record
        if (current.status !== 'unread') return
        if (this.markingReadIds.has(key)) return
        this.markingReadIds.add(key)
        try {
            await HttpClient.post(`admin/news/${record.id}/read`, null, null, {toastError: false})
            this.setState(prev => {
                const cur = prev.items.find(it => String(it.id) === key)
                if (!cur || cur.status !== 'unread') return null
                let items
                if (remove) items = prev.items.filter(it => String(it.id) !== key)
                else items = prev.items.map(it => String(it.id) === key ? {...it, status: 'read'} : it)
                return {
                    items,
                    stats: {...prev.stats, unread: Math.max(0, (Number(prev.stats.unread) || 0) - 1)},
                }
            }, () => {
                if (remove && this.state.items.length === 0 && this.state.hasMore) this.loadMore()
            })
        } catch (_) {}
        finally { this.markingReadIds.delete(key) }
    }

    toggleFav = async (record) => {
        try {
            const rs = await HttpClient.post(`admin/news/${record.id}/fav`)
            const next = rs?.data?.status || (record.status === 'fav' ? 'unread' : 'fav')
            const wasFav = record.status === 'fav'
            const nowFav = next === 'fav'
            this.setState(prev => {
                let items
                if ((prev.tab === 'fav' && next !== 'fav') || (prev.tab === 'read' && next !== 'read')) {
                    items = prev.items.filter(it => it.id !== record.id)
                } else {
                    items = prev.items.map(it => it.id === record.id ? {...it, status: next} : it)
                }
                const unreadDelta = (!wasFav && next === 'unread' ? 1 : 0) + (record.status === 'unread' && next !== 'unread' ? -1 : 0)
                return {
                    items,
                    stats: {
                        ...prev.stats,
                        fav: Math.max(0, (Number(prev.stats.fav) || 0) + (nowFav ? 1 : 0) + (wasFav ? -1 : 0)),
                        unread: Math.max(0, (Number(prev.stats.unread) || 0) + unreadDelta),
                    },
                }
            }, () => {
                if ((this.state.tab === 'fav' || this.state.tab === 'read') && this.state.items.length === 0 && this.state.hasMore) {
                    this.loadMore()
                }
            })
        } catch (_) {}
    }

    readAll = async () => {
        if (this.state.tab !== 'unread') return
        if (!this.state.items.length && !(Number(this.state.stats.unread) > 0)) {
            message.info('没有未读资讯')
            return
        }
        Modal.confirm({
            title: '全部已读',
            content: '将当前全部未读资讯标记为已读？',
            onOk: async () => {
                const rs = await HttpClient.post('admin/news/read-all')
                message.success(rs.data?.updated ? `已标记 ${rs.data.updated} 条为已读` : '没有未读资讯')
                this.loadStats()
                this.reloadList(false)
            },
        })
    }

    onTabChange = (tab) => {
        this.setState({tab}, () => {
            this.loadStats()
            this.reloadList(false)
        })
    }

    toggleExpanded = (key) => {
        this.setState(prev => ({
            expandedById: {...prev.expandedById, [key]: !prev.expandedById[key]},
        }))
    }

    // ---- 订阅源 ----
    loadSources = async () => {
        const rs = await HttpClient.get('admin/news/sources')
        this.setState({sources: rs.data || []})
    }
    openSources = () => { this.setState({sourceModalOpen: true, sourceForm: {name: '', url: '', type: 'rss'}}); this.loadSources() }
    addSource = async () => {
        const {sourceForm} = this.state
        if (!sourceForm.name?.trim() || !sourceForm.url?.trim()) { message.warning('名称和地址不能为空'); return }
        await HttpClient.post('admin/news/sources', {name: sourceForm.name.trim(), url: sourceForm.url.trim(), type: sourceForm.type || 'rss', enabled: true})
        this.setState({sourceForm: {name: '', url: '', type: 'rss'}})
        message.success('已添加订阅源')
        this.loadSources(); this.loadStats()
    }
    toggleSource = async (row, enabled) => { await HttpClient.post('admin/news/sources/update', {id: row.id, enabled}); this.loadSources() }
    deleteSource = async (row) => { await HttpClient.ajax({url: `admin/news/sources/${row.id}`, method: 'DELETE'}); message.success('已删除订阅源'); this.loadSources(); this.loadStats() }

    // ---- 屏蔽词 ----
    loadBlocks = async () => { const rs = await HttpClient.get('admin/news/blocks'); this.setState({blocks: rs.data || []}) }
    openBlocks = () => { this.setState({blockModalOpen: true, blockWord: ''}); this.loadBlocks() }
    addBlock = async () => {
        const word = (this.state.blockWord || '').trim()
        if (!word) { message.warning('屏蔽词不能为空'); return }
        await HttpClient.post('admin/news/blocks', {word, enabled: true})
        this.setState({blockWord: ''})
        message.success('已添加屏蔽词')
        await this.loadBlocks()
        this.reloadList(false)
    }
    deleteBlock = async (row) => { await HttpClient.ajax({url: `admin/news/blocks/${row.id}`, method: 'DELETE'}); await this.loadBlocks(); this.reloadList(false) }

    renderSourcesModal() {
        const {sources, sourceForm} = this.state
        const canDeleteSource = PermUtils.hasPermission('news:source')
        return <Modal title='订阅源' open={this.state.sourceModalOpen} onCancel={() => this.setState({sourceModalOpen: false})} footer={null} width={720}>
            <Table rowKey='id' size='small' pagination={false} dataSource={sources} locale={{emptyText: '暂无订阅源'}}
                columns={[
                    {title: '名称', dataIndex: 'name', render: (v, row) => <div><div>{v}</div><Typography.Text type='secondary' style={{fontSize: 12}}>{row.url}</Typography.Text></div>},
                    {title: '类型', dataIndex: 'type', width: 80},
                    {title: '启用', dataIndex: 'enabled', width: 70, render: (v, row) => <Switch size='small' checked={!!v} onChange={(checked) => this.toggleSource(row, checked)}/>},
                    {title: '', dataIndex: 'option', width: 60, render: (_, row) => canDeleteSource ? <Button type='text' danger size='small' icon={<DeleteOutlined/>} onClick={() => this.deleteSource(row)}/> : null},
                ]}
            />
            <Space.Compact style={{width: '100%', marginTop: 12}}>
                <Input placeholder='名称' value={sourceForm.name} onChange={e => this.setState({sourceForm: {...sourceForm, name: e.target.value}})}/>
                <Input placeholder='RSS 地址' value={sourceForm.url} onChange={e => this.setState({sourceForm: {...sourceForm, url: e.target.value}})}/>
                <Button type='primary' icon={<PlusOutlined/>} onClick={this.addSource}>添加</Button>
            </Space.Compact>
        </Modal>
    }

    renderBlocksModal() {
        const {blocks, blockWord} = this.state
        return <Modal title='屏蔽词' open={this.state.blockModalOpen} onCancel={() => this.setState({blockModalOpen: false})} footer={null} width={560}>
            <div style={{marginBottom: 12, minHeight: 32}}>
                {blocks.length ? blocks.map(b => <Tag key={b.id} closable onClose={() => this.deleteBlock(b)} style={{marginBottom: 6}}>{b.word}</Tag>) : <Typography.Text type='secondary'>暂无屏蔽词</Typography.Text>}
            </div>
            <Space.Compact style={{width: '100%'}}>
                <Input placeholder='新增屏蔽词' value={blockWord} onChange={e => this.setState({blockWord: e.target.value})} onPressEnter={this.addBlock}/>
                <Button type='primary' icon={<PlusOutlined/>} onClick={this.addBlock}>添加</Button>
            </Space.Compact>
        </Modal>
    }

    renderItem(item) {
        const src = this.state.sources.find(s => s.id === item.sourceId)
        const isUnread = item.status === 'unread'
        const isFav = item.status === 'fav'
        const safe = sanitize(item.content || '')
        const key = String(item.id)
        const longText = plainTextLength(safe) > CLAMP_TEXT_LENGTH
        const expanded = !!this.state.expandedById[key]
        return <article className='news-post' key={item.id}>
            <div className='news-post-meta'>
                <span>{[src?.name, item.author, fmtTime(item.pubTime)].filter(Boolean).join(' · ')}</span>
                {isFav ? <Tag color='gold' bordered={false}>已收藏</Tag> : null}
            </div>
            <h2 className='news-post-title'>{item.title || '(无标题)'}</h2>
            {item.tags ? <div className='news-post-tags'><Tag>{item.tags}</Tag></div> : null}
            <div className={`news-post-content${longText && !expanded ? ' is-clamped' : ''}`}>
                {safe.trim()
                    ? <div className='jt-news-content' dangerouslySetInnerHTML={{__html: safe}} />
                    : <Typography.Text type='secondary'>（无正文）</Typography.Text>}
                <div ref={this.getReadMarkerRef(key)} data-news-id={key}
                     className='news-post-read-marker' aria-hidden='true'/>
            </div>
            {longText ? <button type='button' className='news-post-toggle' onClick={() => this.toggleExpanded(key)}>
                {expanded ? '收起' : '展开全文'}
            </button> : null}
            <div className='news-post-actions'>
                <button type='button' className={`news-post-favbtn${isFav ? ' active' : ''}`}
                        onClick={() => this.toggleFav(item)} aria-label={isFav ? '取消收藏' : '收藏'}>
                    {isFav ? <StarFilled/> : <StarOutlined/>}<span>{isFav ? '已收藏' : '收藏'}</span>
                </button>
                {isUnread
                    ? <button type='button' className='news-post-readbtn' onClick={() => this.markRead(item, {remove: false})}>标记已读</button>
                    : <span className='news-post-status'>{item.status === 'fav' ? '已收藏' : '已读'}</span>}
            </div>
        </article>
    }

    renderList() {
        const {tab, items, loading, initialLoading, hasMore} = this.state
        if (initialLoading) {
            return <div className='news-feed-state'><Spin/></div>
        }
        if (!items.length) {
            return <div className='news-feed-state'>
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE}
                       description={tab === 'fav' ? '暂无收藏' : tab === 'read' ? '暂无已读' : '暂无未读'}/>
            </div>
        }
        return <div className='news-feed-list'>
            {items.map(item => this.renderItem(item))}
            <div className='news-feed-more'>
                {loading ? <Spin size='small'/>
                    : hasMore ? <Button onClick={this.loadMore}>加载更多</Button>
                        : <span>已加载全部 {items.length} 条</span>}
            </div>
        </div>
    }

    render() {
        const {tab, loading, initialLoading, stats} = this.state
        const readCount = Math.max(0, (Number(stats.total) || 0) - (Number(stats.unread) || 0) - (Number(stats.fav) || 0))

        const moreItems = [
            ...(tab === 'unread' ? [{key: 'readall', label: '全部已读'}] : []),
            ...(tab === 'unread' ? [{type: 'divider'}] : []),
            ...(PermUtils.hasPermission('news:source') ? [{key: 'sources', label: '订阅源'}] : []),
            ...(PermUtils.hasPermission('news:block') ? [{key: 'blocks', label: '屏蔽词'}] : []),
        ].filter(Boolean)
        const onMore = ({key}) => {
            if (key === 'readall') this.readAll()
            else if (key === 'sources') this.openSources()
            else if (key === 'blocks') this.openBlocks()
        }

        return <Page>
            <div className='news-feed' ref={this.feedRef}>
                <div className='news-feed-toolbar'>
                    <Segmented value={tab} onChange={this.onTabChange} options={[
                        {label: `未读${stats.unread ? ` (${stats.unread})` : ''}`, value: 'unread'},
                        {label: `已读${readCount ? ` (${readCount})` : ''}`, value: 'read'},
                        {label: `收藏${stats.fav ? ` (${stats.fav})` : ''}`, value: 'fav'},
                    ]}/>
                    <div className='news-feed-actions'>
                        <Tooltip title='刷新'>
                            <Button icon={<ReloadOutlined/>} loading={loading && !initialLoading} aria-label='刷新'
                                    onClick={() => { this.loadBase(); this.reloadList(false) }}/>
                        </Tooltip>
                        <Dropdown menu={{items: moreItems, onClick: onMore}} trigger={['click']} placement='bottomRight'>
                            <Button icon={<MoreOutlined/>} aria-label='更多'/>
                        </Dropdown>
                    </div>
                </div>

                {this.renderList()}
            </div>

            {this.renderSourcesModal()}
            {this.renderBlocksModal()}
        </Page>
    }
}
