import React from 'react'
import {
    DeleteOutlined,
    LeftOutlined,
    MoreOutlined,
    PlusOutlined,
    ReloadOutlined,
    SearchOutlined,
    StarFilled,
    StarOutlined,
    UnorderedListOutlined,
} from '@ant-design/icons'
import {
    Button,
    Drawer,
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
    Typography,
    message,
} from 'antd'
import DOMPurify from 'dompurify'
import {HttpClient, PermUtils, history} from '@jiangood/open-admin'
import './news.css'

export const pageMeta = {layout: 'blank', title: '资讯'}

const PAGE_SIZE = 20

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

export default class NewsReaderPage extends React.Component {
    state = {
        tab: 'unread', // unread | read | fav
        keyword: '',
        items: [],
        page: 1,
        hasMore: true,
        loading: false,
        initialLoading: true,
        swipeIndex: 0,
        stats: {unread: 0, fav: 0, total: 0, recent24h: 0, sources: 0},
        sources: [],
        blocks: [],
        listOpen: false,
        sourceModalOpen: false,
        blockModalOpen: false,
        sourceForm: {name: '', url: '', type: 'rss'},
        blockWord: '',
    }

    loadSeq = 0
    loadMoreLock = false
    swipeRef = React.createRef()
    markingReadIds = new Set()
    searchTimer = null

    componentDidMount() {
        this.loadBase()
        this.reloadList(true)
    }

    componentDidUpdate(prevProps, prevState) {
        if ((prevState.tab !== this.state.tab || prevState.keyword !== this.state.keyword) && this.state.swipeIndex !== 0) {
            this.scrollToIndex(0, false)
        }
        if (prevState.items !== this.state.items && this.state.items.length > 0 && this.state.swipeIndex >= this.state.items.length) {
            this.scrollToIndex(this.state.items.length - 1, false)
        }
    }

    componentWillUnmount() {
        clearTimeout(this.searchTimer)
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
        this.setState({
            items: [],
            page: 1,
            hasMore: true,
            loading: false,
            initialLoading: initial || this.state.items.length === 0,
            swipeIndex: 0,
        }, () => {
            this.scrollToIndex(0, false)
            this.loadPage(1, true)
        })
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
            const kw = this.state.keyword?.trim()
            if (kw) params.keyword = kw
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

    markRead = async (record, {remove = true, autoNext = false} = {}) => {
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
                if (autoNext) this.advanceAfterMarkRead()
            })
        } catch (_) {}
        finally { this.markingReadIds.delete(key) }
    }

    advanceAfterMarkRead = () => {
        const {items, swipeIndex, hasMore, loading} = this.state
        const nextIdx = swipeIndex + 1
        if (nextIdx < items.length) {
            this.scrollToIndex(nextIdx)
        } else if (hasMore && !loading) {
            this.loadMore()
        }
    }

    autoMarkReadOnSwipe = (fromIdx, toIdx) => {
        if (toIdx <= fromIdx) return
        const {items} = this.state
        const end = Math.min(toIdx, items.length)
        for (let i = fromIdx; i < end; i++) {
            const item = items[i]
            if (item && item.status === 'unread') this.markRead(item, {remove: false})
        }
    }

    onSwipeScroll = () => {
        const el = this.swipeRef.current
        if (!el) return
        const w = el.clientWidth || 1
        const rawIdx = Math.round(el.scrollLeft / w)
        const prevIdx = this.state.swipeIndex
        const maxItemIdx = Math.max(0, this.state.items.length - 1)
        const clamped = Math.max(0, Math.min(rawIdx, maxItemIdx))
        if (rawIdx > prevIdx) this.autoMarkReadOnSwipe(prevIdx, Math.min(rawIdx, this.state.items.length))
        if (clamped !== prevIdx) {
            this.setState({swipeIndex: clamped}, () => {
                if (this.state.hasMore && !this.state.loading && clamped >= this.state.items.length - 2) this.loadMore()
            })
        } else if (this.state.hasMore && !this.state.loading && clamped >= this.state.items.length - 2) {
            this.loadMore()
        }
    }

    scrollToIndex = (index, smooth = true) => {
        const el = this.swipeRef.current
        if (!el) {
            if (this.state.swipeIndex !== index) this.setState({swipeIndex: index})
            return
        }
        const left = index * (el.clientWidth || 0)
        if (smooth && el.scrollTo) el.scrollTo({left, behavior: 'smooth'})
        else el.scrollLeft = left
        if (this.state.swipeIndex !== index) this.setState({swipeIndex: index})
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
        clearTimeout(this.searchTimer)
        this.setState({tab, listOpen: this.state.listOpen}, () => {
            this.loadStats()
            this.reloadList(false)
        })
    }

    onKeywordChange = (e) => {
        const keyword = e.target.value
        this.setState({keyword})
        clearTimeout(this.searchTimer)
        this.searchTimer = setTimeout(() => this.reloadList(false), 350)
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

    render() {
        const {tab, keyword, items, loading, initialLoading, hasMore, stats, sources, swipeIndex, listOpen} = this.state
        const readCount = Math.max(0, (Number(stats.total) || 0) - (Number(stats.unread) || 0) - (Number(stats.fav) || 0))
        const posText = items.length ? `${Math.min(swipeIndex + 1, items.length)}/${items.length}${hasMore ? '+' : ''}` : ''
        const progressPct = items.length ? Math.round(((Math.min(swipeIndex, items.length - 1) + 1) / Math.max(items.length, 1)) * 100) : 0
        const collectTime = items[0] ? fmtTime(items[0].createTime || items[0].pubTime) : ''

        const moreItems = [
            {key: 'refresh', icon: <ReloadOutlined/>, label: '刷新'},
            ...(tab === 'unread' ? [{key: 'readall', label: '全部已读'}] : []),
            {type: 'divider'},
            ...(PermUtils.hasPermission('news:source') ? [{key: 'sources', label: '订阅源'}] : []),
            ...(PermUtils.hasPermission('news:block') ? [{key: 'blocks', label: '屏蔽词'}] : []),
        ].filter(Boolean)
        const onMore = ({key}) => {
            if (key === 'refresh') { this.loadBase(); this.reloadList(false) }
            else if (key === 'readall') this.readAll()
            else if (key === 'sources') this.openSources()
            else if (key === 'blocks') this.openBlocks()
        }

        return <div className='news-reader-root'>
            <header className='news-reader-topbar'>
                <div className='news-reader-left'>
                    <button type='button' className='news-reader-iconbtn' onClick={() => history.push('/')} aria-label='返回'>
                        <LeftOutlined />
                    </button>
                    <div className='news-reader-meta'>
                        <div className='news-reader-title'>资讯</div>
                    </div>
                </div>
                <div className='news-reader-right'>
                    <span className='news-reader-badge'>未读 {stats.unread ?? 0}</span>
                    {collectTime ? <span className='news-reader-collect'>采集 {collectTime}</span> : null}
                    {posText ? <span className='news-reader-pos'>{posText}</span> : null}
                    <button type='button' className='news-reader-iconbtn' onClick={() => this.setState({listOpen: true})} aria-label='列表'>
                        <UnorderedListOutlined />
                    </button>
                    <Dropdown menu={{items: moreItems, onClick: onMore}} trigger={['click']} placement='bottomRight'>
                        <button type='button' className='news-reader-iconbtn' aria-label='更多'>
                            <MoreOutlined />
                        </button>
                    </Dropdown>
                </div>
            </header>

            <div className='news-reader-stage'>
                {initialLoading ? (
                    <div className='news-reader-center'><Spin /></div>
                ) : items.length === 0 ? (
                    <div className='news-reader-center'>
                        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={keyword ? `没有匹配「${keyword}」的资讯` : (tab === 'fav' ? '暂无收藏' : tab === 'read' ? '暂无已读' : '暂无未读')} />
                    </div>
                ) : (
                    <div className='news-reader-track' ref={this.swipeRef} onScroll={this.onSwipeScroll}>
                        {items.map((item, idx) => {
                            const src = sources.find(s => s.id === item.sourceId)
                            const isUnread = item.status === 'unread'
                            const isFav = item.status === 'fav'
                            const safe = sanitize(item.content || '')
                            return <div className='news-reader-slide' key={item.id}>
                                <article className='news-reader-article'>
                                    <div className='news-reader-article-meta'>
                                        {[src?.name, item.author, fmtTime(item.pubTime)].filter(Boolean).join(' · ')}
                                    </div>
                                    <h1 className='news-reader-article-title'>{item.title || '(无标题)'}</h1>
                                    {item.tags ? <div className='news-reader-tags'><Tag>{item.tags}</Tag></div> : null}
                                    <div className='news-reader-content'>
                                        {safe.trim()
                                            ? <div className='jt-news-content' dangerouslySetInnerHTML={{__html: safe}} />
                                            : <Typography.Text type='secondary'>（无正文）</Typography.Text>}
                                    </div>
                                    <div className='news-reader-article-actions'>
                                        <button type='button' className={`news-reader-favbtn${isFav ? ' active' : ''}`} onClick={() => this.toggleFav(item)} aria-label={isFav ? '取消收藏' : '收藏'}>
                                            {isFav ? <StarFilled /> : <StarOutlined />}<span>{isFav ? '已收藏' : '收藏'}</span>
                                        </button>
                                        {isUnread ? (
                                            <button type='button' className='news-reader-readbtn' onClick={() => this.markRead(item, {remove: false, autoNext: true})}>标记已读</button>
                                        ) : <span className='news-reader-statuslabel'>{item.status === 'fav' ? '已收藏' : '已读'}</span>}
                                    </div>
                                </article>
                            </div>
                        })}
                        {hasMore || loading ? (
                            <div className='news-reader-slide'><div className='news-reader-center' style={{height: '100%'}}>{loading ? <Spin /> : null}</div></div>
                        ) : null}
                    </div>
                )}
            </div>

            <div className='news-reader-progress-line'>
                <div style={{width: `${progressPct}%`}} />
            </div>

            <Drawer title='资讯列表' placement='left' width={Math.min(typeof window !== 'undefined' ? window.innerWidth * 0.92 : 380, 420)}
                open={listOpen} onClose={() => this.setState({listOpen: false})}
                styles={{body: {padding: '12px 12px 16px', display: 'flex', flexDirection: 'column', minHeight: 0}}}>
                <div className='news-reader-list-controls'>
                    <Segmented block value={tab} onChange={this.onTabChange} options={[
                        {label: `未读${stats.unread ? ` (${stats.unread})` : ''}`, value: 'unread'},
                        {label: `已读${readCount ? ` (${readCount})` : ''}`, value: 'read'},
                        {label: `收藏${stats.fav ? ` (${stats.fav})` : ''}`, value: 'fav'},
                    ]} />
                    <Input allowClear prefix={<SearchOutlined />} placeholder='搜索标题 / 作者 / 正文' value={keyword} onChange={this.onKeywordChange} />
                </div>
                <div className='news-reader-list'>
                    {initialLoading ? <div className='news-reader-center' style={{padding: 24}}><Spin size='small' /></div>
                        : items.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description='暂无内容' style={{marginTop: 24}} />
                        : items.map((item, idx) => {
                            const src = sources.find(s => s.id === item.sourceId)
                            const active = idx === swipeIndex
                            return <button key={item.id} type='button' className={`news-reader-list-item${active ? ' active' : ''}`} onClick={() => { this.scrollToIndex(idx); this.setState({listOpen: false}) }}>
                                <div className='news-reader-list-title'>{item.title || '(无标题)'}</div>
                                <div className='news-reader-list-meta'>{[src?.name, fmtTime(item.pubTime)].filter(Boolean).join(' · ')}</div>
                            </button>
                        })}
                    {!initialLoading && hasMore ? <div className='news-reader-list-more'>{loading ? <Spin size='small' /> : '继续浏览可加载更多'}</div> : null}
                </div>
            </Drawer>

            {this.renderSourcesModal()}
            {this.renderBlocksModal()}
        </div>
    }
}
