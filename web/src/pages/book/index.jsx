import {
    BookOutlined,
    CloudUploadOutlined,
    EditOutlined,
    EllipsisOutlined,
    InboxOutlined,
    LinkOutlined,
    PlusOutlined,
    ReloadOutlined,
    SearchOutlined,
    StarFilled,
    SyncOutlined,
} from '@ant-design/icons'
import {
    Alert,
    AutoComplete,
    Button,
    Descriptions,
    Dropdown,
    Empty,
    Form,
    Input,
    InputNumber,
    Modal,
    Pagination,
    Progress,
    Segmented,
    Select,
    Space,
    Spin,
    Tooltip,
    Typography,
    Upload,
    message,
} from 'antd'
import React from 'react'
import {FormModal, HttpClient, Page, PermUtils, UrlUtils, getModalApi, history} from '@jiangood/open-admin'
import './book.css'

const PAGE_SIZE = 24

const STATUS = {
    unread: {label: '待读', tone: 'unread'},
    reading: {label: '阅读中', tone: 'reading'},
    read: {label: '已读', tone: 'read'},
}

const STATUS_OPTIONS = [
    {value: 'unread', label: '待读'},
    {value: 'reading', label: '阅读中'},
    {value: 'read', label: '已读'},
]

const ORDER_OPTIONS = [
    {value: 'recent', label: '最近更新'},
    {value: 'lastRead', label: '最近阅读'},
    {value: 'title', label: '书名 A → Z'},
    {value: 'rating', label: '评分从高到低'},
]

function clampProgress(v) {
    return Math.max(0, Math.min(100, Number(v) || 0))
}

function hasEditPerm() {
    return PermUtils.hasPermission('book:edit')
}

/** 豆瓣图片有防盗链，统一走后端代理；相对地址补上 contextPath */
function coverSrc(url) {
    const src = String(url || '').trim()
    if (!src) return null
    try {
        const parsed = new URL(src, window.location.origin)
        const host = parsed.hostname.toLowerCase()
        if (host === 'douban.com' || host.endsWith('.douban.com')
            || host === 'doubanio.com' || host.endsWith('.doubanio.com')) {
            return UrlUtils.contextPath(`/admin/book/cover/proxy?url=${encodeURIComponent(src)}`)
        }
    } catch {
        /* 非法 URL 交给 img 兜底 */
    }
    return src.startsWith('/') ? UrlUtils.contextPath(src) : src
}

function BookCover({record, hasFile}) {
    const src = coverSrc(record.coverUrl)
    const [failed, setFailed] = React.useState(false)

    React.useEffect(() => {
        setFailed(false)
    }, [src])

    if (!src || failed) {
        return <div className='jt-book-cover jt-book-cover-placeholder' aria-label={`${record.title || '图书'}封面占位`}>
            {hasFile ? <BookOutlined/> : <CloudUploadOutlined/>}
        </div>
    }

    return <img
        className='jt-book-cover'
        src={src}
        alt={`${record.title || '图书'}封面`}
        loading='lazy'
        decoding='async'
        onError={() => setFailed(true)}
    />
}

/** 书架：封面卡片视图，支持按状态 / 分组 / 关键字筛选，卡片上直接续读或管理 */
export default class BookPage extends React.Component {

    state = {
        books: [],
        total: 0,
        page: 1,
        loading: true,
        firstLoad: true,
        keyword: '',
        status: null,
        category: undefined,
        order: 'recent',
        categories: [],
        stats: {total: 0, unread: 0, reading: 0, read: 0},
        editing: null,
        uploadTarget: null,
        uploading: false,
        uploadPct: 0,
        doubanTarget: null,
        doubanLoading: false,
        doubanData: null,
        doubanApplying: false,
    }

    loadSeq = 0
    searchTimer = null
    modalRef = React.createRef()

    componentDidMount() {
        this.loadCategories()
        this.loadStats()
        this.loadBooks()
    }

    componentWillUnmount() {
        clearTimeout(this.searchTimer)
    }

    loadCategories = () => {
        HttpClient.get('admin/book/categories')
            .then(rs => this.setState({categories: rs.data || []}))
            .catch(() => {})
    }

    loadStats = () => {
        HttpClient.get('admin/book/stats')
            .then(rs => this.setState({stats: rs?.data || {total: 0, unread: 0, reading: 0, read: 0}}))
            .catch(() => {})
    }

    loadBooks = async () => {
        const seq = ++this.loadSeq
        const {page, keyword, status, category, order} = this.state
        const params = {page, size: PAGE_SIZE, order}
        const kw = keyword.trim()
        if (kw) params.keyword = kw
        if (status) params.status = status
        if (category) params.category = category

        this.setState({loading: true})
        try {
            const rs = await HttpClient.post('admin/book/page', null, params)
            if (seq !== this.loadSeq) return
            const data = rs?.data || {}
            const content = Array.isArray(data.content) ? data.content : []
            const totalElements = Number(data.totalElements) || 0
            // 删除 / 筛选后当前页可能越界，回落到最后一页
            if (!content.length && page > 1 && totalElements > 0) {
                this.setState({page: Math.max(1, Math.ceil(totalElements / PAGE_SIZE)), loading: false}, () => this.loadBooks())
                return
            }
            this.setState({
                books: content,
                total: totalElements,
                loading: false,
                firstLoad: false,
            })
        } catch (_) {
            if (seq !== this.loadSeq) return
            this.setState({loading: false, firstLoad: false})
        }
    }

    reload = () => {
        this.loadStats()
        return this.loadBooks()
    }

    resetAndLoad = (patch) => {
        this.setState({...patch, page: 1}, () => this.loadBooks())
    }

    onKeywordChange = (e) => {
        const keyword = e.target.value
        this.setState({keyword})
        clearTimeout(this.searchTimer)
        this.searchTimer = setTimeout(() => this.resetAndLoad({keyword}), 320)
    }

    onKeywordSearch = (keyword) => {
        clearTimeout(this.searchTimer)
        this.resetAndLoad({keyword})
    }

    onPageChange = (page) => {
        this.setState({page}, () => {
            this.loadBooks()
            window.scrollTo({top: 0, behavior: 'smooth'})
        })
    }

    hasFilters() {
        const {keyword, status, category} = this.state
        return !!(keyword.trim() || status || category)
    }

    clearFilters = () => {
        clearTimeout(this.searchTimer)
        this.setState({keyword: '', status: null, category: undefined, page: 1}, () => this.loadBooks())
    }

    openAdd = () => {
        this.setState({editing: null})
        this.modalRef.current.open({
            id: undefined,
            title: '',
            isbn: '',
            publisher: '',
            coverUrl: '',
            category: undefined,
            status: 'unread',
            progress: 0,
            rating: '',
            readMinutes: undefined,
        })
    }

    openEdit = (record) => {
        this.setState({editing: record})
        this.modalRef.current.open({...record})
    }

    handleSubmit = async (values) => {
        const url = values.id ? 'admin/book/update' : 'admin/book/create'
        await HttpClient.post(url, values)
        message.success('已保存')
        this.reload()
        this.loadCategories()
    }

    markStatus = async (record, status) => {
        await HttpClient.post('admin/book/update', {id: record.id, status})
        message.success(status === 'read' ? '已标记为已读' : '已标记为待读')
        this.reload()
    }

    confirmDelete = (record) => {
        getModalApi().confirm({
            title: '删除书籍',
            content: `确定删除《${record.title || '未命名'}》？EPUB 文件也会一并删除，操作不可恢复。`,
            okText: '删除',
            okButtonProps: {danger: true},
            cancelText: '取消',
            onOk: async () => {
                await HttpClient.post('admin/book/delete', {id: record.id}, null)
                message.success('已删除')
                const {books, page} = this.state
                const nextPage = books.length === 1 && page > 1 ? page - 1 : page
                this.setState({page: nextPage}, () => this.reload())
            },
        })
    }

    openReader = (record) => {
        if (!record.r2Key) {
            this.openUpload(record)
            return
        }
        history.push(`/book/read/${record.id}`)
    }

    openUpload = (record) => {
        this.setState({uploadTarget: record, uploading: false, uploadPct: 0})
    }

    closeUpload = () => {
        if (this.state.uploading) return
        this.setState({uploadTarget: null, uploadPct: 0})
    }

    openDoubanSync = (record) => {
        this.setState({doubanTarget: record, doubanLoading: true, doubanData: null})
        HttpClient.get(`admin/book/douban/preview/${record.id}`).then(rs => {
            this.setState({doubanData: rs?.data || null, doubanLoading: false})
        }).catch(() => {
            this.setState({doubanLoading: false})
        })
    }

    closeDoubanSync = () => {
        if (this.state.doubanApplying) return
        this.setState({doubanTarget: null, doubanData: null, doubanLoading: false})
    }

    applyDoubanSync = async () => {
        const {doubanTarget, doubanData} = this.state
        if (!doubanTarget || !doubanData) return

        const fields = ['title', 'author', 'isbn', 'publisher', 'pubYear', 'coverUrl', 'summary', 'rating', 'doubanId', 'doubanUrl']
        const payload = {id: doubanTarget.id}
        fields.forEach(key => {
            const val = doubanData[key]
            if (val !== undefined && val !== null && String(val).trim() !== '') {
                payload[key] = val
            }
        })

        if (Object.keys(payload).length <= 1) {
            message.warning('没有可同步的豆瓣字段')
            return
        }

        this.setState({doubanApplying: true})
        try {
            await HttpClient.post('admin/book/update', payload)
            message.success('已同步豆瓣信息')
            this.setState({doubanTarget: null, doubanData: null, doubanLoading: false, doubanApplying: false})
            this.reload()
            this.loadCategories()
        } catch (_) {
            this.setState({doubanApplying: false})
        }
    }

    /** EPUB 走独立上传接口（直接写对象存储，避免临时文件被清理），XHR 上报进度 */
    uploadEpub = ({file, onSuccess, onError}) => {
        const target = this.state.uploadTarget
        if (!target) return
        const form = new FormData()
        form.append('file', file)
        form.append('bookId', target.id)
        const xhr = new XMLHttpRequest()
        xhr.open('POST', UrlUtils.contextPath('/admin/book/upload'))
        xhr.withCredentials = true
        this.setState({uploading: true, uploadPct: 0})
        xhr.upload.onprogress = e => {
            if (e.lengthComputable) {
                this.setState({uploadPct: Math.min(100, Math.round((e.loaded / e.total) * 100))})
            }
        }
        xhr.onload = () => {
            let body = null
            try {
                body = JSON.parse(xhr.responseText)
            } catch {
                /* 非 JSON 响应 */
            }
            this.setState({uploading: false})
            if (xhr.status >= 200 && xhr.status < 300 && body?.success) {
                message.success('EPUB 已上传，可以开始阅读')
                this.setState({uploadTarget: null, uploadPct: 0})
                this.reload()
                onSuccess?.(body)
            } else {
                const msg = body?.message || `上传失败（HTTP ${xhr.status}）`
                message.error(msg)
                this.setState({uploadPct: 0})
                onError?.(new Error(msg))
            }
        }
        xhr.onerror = () => {
            this.setState({uploading: false, uploadPct: 0})
            message.error('上传失败：网络异常')
            onError?.(new Error('网络异常'))
        }
        xhr.send(form)
    }

    buildCardMenu(record) {
        const hasFile = !!record.r2Key
        return [
            {
                key: 'read',
                icon: hasFile ? <BookOutlined/> : <CloudUploadOutlined/>,
                label: hasFile ? '阅读' : '上传 EPUB',
            },
            {key: 'upload', icon: <InboxOutlined/>, label: hasFile ? '更换 EPUB 文件' : '上传 EPUB 文件'},
            {key: 'edit', icon: <EditOutlined/>, label: '编辑图书信息'},
            {key: 'douban', icon: <SyncOutlined/>, label: '同步豆瓣信息'},
            {type: 'divider'},
            {
                key: 'status',
                label: record.status === 'read' ? '标记为待读' : '标记为已读',
            },
            {type: 'divider'},
            {key: 'delete', label: '删除', danger: true},
        ]
    }

    onCardMenu = (record, key) => {
        switch (key) {
            case 'read':
                this.openReader(record)
                break
            case 'upload':
                this.openUpload(record)
                break
            case 'edit':
                this.openEdit(record)
                break
            case 'douban':
                this.openDoubanSync(record)
                break
            case 'status':
                this.markStatus(record, record.status === 'read' ? 'unread' : 'read')
                break
            case 'delete':
                this.confirmDelete(record)
                break
            default:
                break
        }
    }

    renderCard(record) {
        const status = STATUS[record.status] ? record.status : 'unread'
        const statusMeta = STATUS[status]
        const hasFile = !!record.r2Key
        const pct = status === 'read' ? 100 : clampProgress(record.progress)
        const canEdit = hasEditPerm()
        const subtitle = record.author || record.publisher || ''

        return <article
            key={record.id}
            className='jt-book-card'
            onClick={() => this.openReader(record)}
            title={hasFile ? '打开阅读' : '上传 EPUB 后可阅读'}
        >
            <div className='jt-book-cover-wrap'>
                <BookCover record={record} hasFile={hasFile}/>
                <span className={`jt-book-status jt-book-status-${statusMeta.tone}`}>{statusMeta.label}</span>
                <div className='jt-book-hover'>
                    <span className='jt-book-hover-read'>{hasFile
                        ? (status === 'reading' ? '继续阅读' : status === 'read' ? '再读一次' : '开始阅读')
                        : '上传 EPUB'}</span>
                    {canEdit && <Dropdown
                        trigger={['click']}
                        placement='bottomRight'
                        menu={{
                            items: this.buildCardMenu(record),
                            onClick: ({key, domEvent}) => {
                                domEvent?.stopPropagation()
                                this.onCardMenu(record, key)
                            },
                        }}
                    >
                        <button
                            type='button'
                            className='jt-book-more'
                            aria-label='更多操作'
                            onClick={e => e.stopPropagation()}
                        >
                            <EllipsisOutlined/>
                        </button>
                    </Dropdown>}
                </div>
                {pct > 0 && <div className={`jt-book-progress ${status === 'read' ? 'is-done' : ''}`}>
                    <span style={{width: `${pct}%`}}/>
                </div>}
            </div>

            <div className='jt-book-info'>
                <div className='jt-book-title' title={record.title || '未命名'}>{record.title || '未命名'}</div>
                <div className='jt-book-subtitle' title={subtitle}>{subtitle || <span className='jt-book-muted'>未填写作者</span>}</div>
                <div className='jt-book-meta'>
                    <span className='jt-book-meta-left'>
                        {record.rating
                            ? <span className='jt-book-rating'><StarFilled/> {record.rating}</span>
                            : null}
                        {record.category
                            ? <span className='jt-book-category'>{record.category}</span>
                            : null}
                    </span>
                    {pct > 0 && <span className='jt-book-percent'>{status === 'read' ? '读完' : `${pct}%`}</span>}
                </div>
            </div>
        </article>
    }

    renderToolbar() {
        const {status, keyword, category, categories, order, stats, loading} = this.state
        const statusOptions = [
            {value: 'all', label: `全部 ${stats.total || 0}`},
            {value: 'unread', label: `待读 ${stats.unread || 0}`},
            {value: 'reading', label: `阅读中 ${stats.reading || 0}`},
            {value: 'read', label: `已读 ${stats.read || 0}`},
        ]

        return <div className='jt-book-toolbar'>
            <Segmented
                className='jt-book-status-filter'
                value={status || 'all'}
                options={statusOptions}
                onChange={v => this.resetAndLoad({status: v === 'all' ? null : v})}
            />
            <div className='jt-book-filters'>
                <Input
                    className='jt-book-search'
                    allowClear
                    value={keyword}
                    prefix={<SearchOutlined/>}
                    placeholder='搜索书名 / 出版社'
                    onChange={this.onKeywordChange}
                    onPressEnter={() => this.onKeywordSearch(this.state.keyword)}
                />
                <Select
                    className='jt-book-select'
                    allowClear
                    showSearch
                    value={category}
                    placeholder='全部分组'
                    optionFilterProp='label'
                    options={categories.map(c => ({label: c, value: c}))}
                    onChange={v => this.resetAndLoad({category: v})}
                />
                <Select
                    className='jt-book-select'
                    value={order}
                    options={ORDER_OPTIONS}
                    onChange={v => this.resetAndLoad({order: v})}
                />
                <Tooltip title='刷新书架'>
                    <Button icon={<ReloadOutlined/>} loading={loading} onClick={this.reload} aria-label='刷新书架'/>
                </Tooltip>
            </div>
        </div>
    }

    renderGrid() {
        const {books, loading, firstLoad} = this.state
        if (firstLoad && loading) {
            return <div className='jt-book-grid' aria-busy='true'>
                {Array.from({length: 12}).map((_, i) => <div className='jt-book-skeleton' key={i}>
                    <div className='jt-book-skeleton-cover'/>
                    <div className='jt-book-skeleton-line' style={{width: '82%'}}/>
                    <div className='jt-book-skeleton-line' style={{width: '55%'}}/>
                </div>)}
            </div>
        }

        if (!books.length) {
            const filtered = this.hasFilters()
            const canEdit = hasEditPerm()
            return <div className='jt-book-empty'>
                <Empty
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description={filtered ? '没有符合条件的书' : '书架还是空的，添加第一本书开始阅读吧'}
                >
                    {filtered
                        ? <Button onClick={this.clearFilters}>清除筛选</Button>
                        : canEdit ? <Button type='primary' icon={<PlusOutlined/>} onClick={this.openAdd}>添加图书</Button> : null}
                </Empty>
            </div>
        }

        return <div className={`jt-book-grid ${loading ? 'is-loading' : ''}`} aria-busy={loading}>
            {books.map(record => this.renderCard(record))}
        </div>
    }

    renderDoubanPreview() {
        const {doubanTarget, doubanLoading, doubanData, doubanApplying} = this.state
        const open = !!doubanTarget
        const fields = [
            {key: 'title', label: '书名'},
            {key: 'author', label: '作者'},
            {key: 'isbn', label: 'ISBN'},
            {key: 'publisher', label: '出版社'},
            {key: 'pubYear', label: '出版时间'},
            {key: 'rating', label: '豆瓣评分'},
        ]

        const syncItems = doubanData
            ? fields.filter(f => doubanData[f.key]).map(f => ({label: f.label, value: doubanData[f.key]}))
            : []
        if (doubanData?.doubanUrl) {
            syncItems.push({label: '豆瓣链接', value: doubanData.doubanUrl, isLink: true})
        }

        return <Modal
            open={open}
            title={doubanTarget ? `同步豆瓣信息 · ${doubanTarget.title || '未命名'}` : '同步豆瓣信息'}
            onCancel={this.closeDoubanSync}
            width={720}
            destroyOnHidden
            footer={[
                <Button key='cancel' onClick={this.closeDoubanSync} disabled={doubanApplying}>取消</Button>,
                <Button key='apply' type='primary' icon={<SyncOutlined/>}
                        onClick={this.applyDoubanSync}
                        loading={doubanApplying}
                        disabled={doubanLoading || !doubanData}>
                    应用同步
                </Button>,
            ]}
        >
            {doubanLoading ? (
                <div style={{padding: '32px 0', textAlign: 'center'}}><Spin tip='正在从豆瓣获取图书信息…'/></div>
            ) : doubanData ? (
                <Space direction='vertical' size={16} style={{width: '100%'}}>
                    <Alert type='info' showIcon
                           message='确认后将用豆瓣信息更新当前书籍（仅覆盖本次获取到的字段）'
                           description='匹配优先级：ISBN > 书名。若结果不准确，请先完善书籍的 ISBN 或书名后重试。'/>

                    <div style={{display: 'flex', gap: 16, alignItems: 'flex-start'}}>
                        <div style={{width: 120, flex: 'none'}}>
                            {doubanData.coverUrl
                                ? <img src={coverSrc(doubanData.coverUrl)} alt={doubanData.title || '豆瓣封面'}
                                       style={{width: 120, height: 168, objectFit: 'cover', borderRadius: 6, border: '1px solid var(--oa-color-border, #f0f0f0)', background: 'var(--oa-color-fill-quaternary, #fafafa)'}}/>
                                : <div style={{width: 120, height: 168, borderRadius: 6, border: '1px solid var(--oa-color-border, #f0f0f0)', background: 'var(--oa-color-fill-quaternary, #fafafa)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--oa-color-text-tertiary, #bfbfbf)'}}>
                                    <BookOutlined style={{fontSize: 28}}/>
                                </div>}
                        </div>
                        <div style={{flex: 1, minWidth: 0}}>
                            <Descriptions column={1} size='small' colon={false} styles={{label: {width: 72, color: 'var(--oa-color-text-secondary, #888)'}}}>
                                {syncItems.map(item => (
                                    <Descriptions.Item key={item.label} label={item.label}>
                                        {item.isLink
                                            ? <Typography.Link href={item.value} target='_blank' rel='noreferrer'>
                                                <LinkOutlined/> {item.value}
                                            </Typography.Link>
                                            : <span style={{wordBreak: 'break-word'}}>{String(item.value)}</span>}
                                    </Descriptions.Item>
                                ))}
                                {!syncItems.length && <Descriptions.Item label='结果'>未解析到可用字段</Descriptions.Item>}
                            </Descriptions>
                        </div>
                    </div>

                    {doubanData.summary && (
                        <div>
                            <Typography.Text strong style={{display: 'block', marginBottom: 6}}>简介</Typography.Text>
                            <div style={{maxHeight: 180, overflow: 'auto', padding: '10px 12px', background: 'var(--oa-color-fill-quaternary, #fafafa)', border: '1px solid var(--oa-color-border, #f0f0f0)', borderRadius: 6, lineHeight: 1.7, whiteSpace: 'pre-wrap', fontSize: 13, color: 'var(--oa-color-text, #444)'}}>
                                {doubanData.summary}
                            </div>
                        </div>
                    )}
                </Space>
            ) : (
                <Alert type='warning' showIcon message='未获取到豆瓣信息' description='可尝试补充准确的 ISBN 或书名后再同步。'/>
            )}
        </Modal>
    }

    render() {
        const {total, page, loading, editing, uploadTarget, uploading, uploadPct, stats} = this.state
        const start = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1
        const end = Math.min(page * PAGE_SIZE, total)

        return <Page>
            <div className='jt-book-shelf'>
                <header className='jt-book-head'>
                    <div className='jt-book-heading'>
                        <h1>书架</h1>
                        <p>
                            共 {stats.total || total} 本
                            {stats.reading ? ` · 阅读中 ${stats.reading} 本` : ''}
                            {stats.read ? ` · 已读完 ${stats.read} 本` : ''}
                        </p>
                    </div>
                    {hasEditPerm() && <Button type='primary' icon={<PlusOutlined/>} onClick={this.openAdd}>添加图书</Button>}
                </header>

                {this.renderToolbar()}
                {this.renderGrid()}

                {total > PAGE_SIZE && <div className='jt-book-pagination'>
                    <Pagination
                        current={page}
                        pageSize={PAGE_SIZE}
                        total={total}
                        showSizeChanger={false}
                        showTotal={() => `第 ${start}–${end} 本，共 ${total} 本`}
                        onChange={this.onPageChange}
                    />
                </div>}
            </div>

            <Modal open={!!uploadTarget} title={`上传 EPUB${uploadTarget?.title ? ` · ${uploadTarget.title}` : ''}`}
                   footer={null} mask={{closable: !uploading}} closable={!uploading}
                   onCancel={this.closeUpload} destroyOnHidden>
                <Upload.Dragger accept='.epub' showUploadList={false} disabled={uploading}
                                customRequest={this.uploadEpub}>
                    <p className='ant-upload-drag-icon'><InboxOutlined/></p>
                    <p className='ant-upload-text'>点击或拖拽 EPUB 文件到此处</p>
                    <p className='ant-upload-hint'>
                        仅支持 .epub；上传后覆盖原有文件，会重新开始记录阅读位置
                    </p>
                </Upload.Dragger>
                {uploading && <Progress percent={uploadPct} size='small' style={{marginTop: 16}}/>}
            </Modal>

            <FormModal ref={this.modalRef} title={editing ? '编辑图书' : '添加图书'}
                       onFinish={this.handleSubmit} labelCol={{flex: '80px'}} width={680}>
                <Form.Item label='书名' name='title' rules={[{required: true, message: '请输入书名'}]}>
                    <Input/>
                </Form.Item>
                <Form.Item label='作者' name='author'>
                    <Input placeholder='可选'/>
                </Form.Item>
                <Form.Item label='ISBN' name='isbn'>
                    <Input/>
                </Form.Item>
                <Form.Item label='出版社' name='publisher'>
                    <Input/>
                </Form.Item>
                <Form.Item label='出版时间' name='pubYear'>
                    <Input placeholder='如 2020-01（可选）'/>
                </Form.Item>
                <Form.Item label='分组' name='category'>
                    <AutoComplete allowClear filterOption
                                  placeholder='如 小说 / 技术 / 历史'
                                  options={this.state.categories.map(c => ({label: c, value: c}))}/>
                </Form.Item>
                <Form.Item label='阅读状态' name='status'>
                    <Select options={STATUS_OPTIONS}/>
                </Form.Item>
                <Form.Item label='阅读进度' name='progress'
                           extra='0–100，已读状态自动按 100% 展示'>
                    <InputNumber min={0} max={100} style={{width: 160}} addonAfter='%'/>
                </Form.Item>
                <Form.Item label='评分' name='rating'>
                    <Input placeholder='如 8.9（可选）' style={{width: 160}}/>
                </Form.Item>
                <Form.Item label='预计阅读' name='readMinutes'>
                    <InputNumber min={0} style={{width: 160}} addonAfter='分钟'/>
                </Form.Item>
                <Form.Item label='封面链接' name='coverUrl'>
                    <Input placeholder='https://…（可选）'/>
                </Form.Item>
                <Form.Item label='豆瓣链接' name='doubanUrl'>
                    <Input placeholder='https://book.douban.com/subject/...（可选）'/>
                </Form.Item>
                <Form.Item label='简介' name='summary'>
                    <Input.TextArea autoSize={{minRows: 3, maxRows: 8}} placeholder='可选'/>
                </Form.Item>
            </FormModal>
            {this.renderDoubanPreview()}
        </Page>
    }
}
