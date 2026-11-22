import React from 'react'
import {
    App as AntdApp, Badge, Button, ConfigProvider, Dropdown, Empty, Form, Input, List, Modal, Popconfirm,
    Progress, Select, Slider, Space, Spin, Tag, Tooltip, Typography, theme,
} from 'antd'
import {
    AudioOutlined,
    CheckCircleOutlined,
    ClockCircleOutlined,
    CloseCircleOutlined,
    CloudUploadOutlined,
    CloseOutlined,
    DeleteOutlined,
    EditOutlined,
    HeartFilled,
    HeartOutlined,
    LeftOutlined,
    LoadingOutlined,
    MoreOutlined,
    MutedOutlined,
    OrderedListOutlined,
    PauseCircleFilled,
    PlayCircleFilled,
    PlusOutlined,
    RedoOutlined,
    RetweetOutlined,
    SearchOutlined,
    SoundFilled,
    StepBackwardFilled,
    StepForwardFilled,
    SwapOutlined,
    UnorderedListOutlined,
} from '@ant-design/icons'
import {FormModal, HttpClient, PermActions, UrlUtils, history} from '@jiangood/open-admin'
import {fmtDuration, player, PLAY_MODES, readListCache, writeListCache, initPlayer} from './player'
import './music.css'

export const pageMeta = {layout: 'blank', title: '音乐'}

/** 网易云风格深色主题：暗色容器 + 红色强调色 */
const mcTheme = {
    algorithm: theme.darkAlgorithm,
    token: {
        colorPrimary: '#EC4141',
        colorBgContainer: '#26272d',
        colorBgElevated: '#2d2e35',
        colorBorder: '#3a3b43',
        colorBorderSecondary: '#31323a',
        colorText: '#e8e9ec',
        colorTextSecondary: '#9c9da8',
        colorFillAlter: 'rgba(255, 255, 255, .04)',
        borderRadius: 8,
    },
}

const MODE_ICONS = {
    order: <OrderedListOutlined/>,
    list: <RedoOutlined/>,
    one: <SwapOutlined/>,
    shuffle: <RetweetOutlined/>,
}

const VOL_KEY = 'wb-player-vol'

function readVolume() {
    try {
        const s = localStorage.getItem(VOL_KEY)
        if (s != null) {
            const n = Number(s)
            if (Number.isFinite(n) && n >= 0 && n <= 1) return n
        }
    } catch { /* 忽略 */ }
    return 0.8
}

/** 外壳：深色主题 + antd App 上下文（让 Modal / message 跟随深色主题） */
export default function MusicPage(props) {
    return <ConfigProvider theme={mcTheme}>
        <AntdApp component={false}>
            <MusicPageApp {...props}/>
        </AntdApp>
    </ConfigProvider>
}

function MusicPageApp(props) {
    const app = AntdApp.useApp()
    return <MusicPageInner {...props} app={app}/>
}

/** 音乐库：曲目列表 + 播放列表面板 + 底部播放条（网易云风格） */
class MusicPageInner extends React.Component {

    state = {
        tracks: readListCache() || [],
        loading: false,
        keyword: undefined,
        artist: undefined,
        artists: [],
        editing: null,
        queueOpen: false,
        tick: 0,          // 播放器状态变化驱动重绘
        curTime: 0,
        duration: 0,
        seeking: false,
        uploadState: null,
        volume: readVolume(),
    }

    modalRef = React.createRef()
    fileInputRef = React.createRef()
    prevVol = null

    constructor(props) {
        super(props)
        this.app = props.app
        this.unsub = null
        this.onTime = () => {
            const a = player.audio
            if (!this.state.seeking) {
                this.setState({curTime: a?.currentTime || 0, duration: Number.isFinite(a?.duration) ? a.duration : 0})
            }
        }
    }

    componentDidMount() {
        initPlayer()
        this.unsub = player.onChange(() => this.setState({tick: this.state.tick + 1}))
        const a = player.audio
        if (a) a.volume = this.state.volume
        ;['timeupdate', 'durationchange', 'loadedmetadata', 'play', 'pause', 'ended'].forEach(ev => a?.addEventListener(ev, this.onTime))
        this.loadArtists()
        this.loadTracks()
    }

    componentWillUnmount() {
        this.unsub?.()
        const a = player.audio
        ;['timeupdate', 'durationchange', 'loadedmetadata', 'play', 'pause', 'ended'].forEach(ev => a?.removeEventListener(ev, this.onTime))
    }

    loadArtists = () => {
        HttpClient.get('admin/music/artists').then(rs => this.setState({artists: rs.data || []})).catch(() => {})
    }

    loadTracks = async () => {
        const {keyword, artist} = this.state
        this.setState({loading: true})
        try {
            const rs = await HttpClient.post('admin/music/list', null, {
                keyword: keyword || undefined, artist: artist || undefined,
            })
            const list = rs.data || []
            this.setState({tracks: list, loading: false})
            writeListCache(list)
            player.syncMeta(list)
        } catch {
            this.setState({loading: false})
        }
    }

    reload = () => {
        this.loadTracks()
        this.loadArtists()
    }

    // ---------- 音量 ----------
    setVolume = (v) => {
        const vol = Math.min(1, Math.max(0, Number(v) || 0))
        this.setState({volume: vol})
        const a = player.audio
        if (a) a.volume = vol
        try { localStorage.setItem(VOL_KEY, String(vol)) } catch { /* 忽略 */ }
    }

    toggleMute = () => {
        const {volume} = this.state
        if (volume > 0) {
            this.prevVol = volume
            this.setVolume(0)
        } else {
            this.setVolume(this.prevVol || 0.8)
        }
    }
    // ---------- 播放交互 ----------
    trackOf = (id) => this.state.tracks.find(t => String(t.id) === String(id))

    playTrack = (id) => {
        const pos = this.state.tracks.findIndex(t => String(t.id) === String(id))
        player.playQueue(this.state.tracks, Math.max(pos, 0))
    }

    addToQueue = (id) => {
        const t = this.trackOf(id)
        if (!t) return
        const r = player.enqueue(t)
        this.app.message.info(r === 'exists' ? '已在播放列表中' : r === 'playing' ? '开始播放' : '已加入播放列表')
    }

    openEdit = (record) => {
        this.setState({editing: record})
        this.modalRef.current?.open({...record})
    }

    removeTrack = async (id) => {
        await HttpClient.post('admin/music/delete', {id})
        const qi = player.queue.findIndex(t => t.id === String(id))
        if (qi >= 0) player.removeAt(qi)
        this.app.message.success('已删除')
        this.reload()
    }

    toggleFavorite = async (record) => {
        await HttpClient.post(`admin/music/${record.id}/favorite`)
        this.reload()
    }

    handleSubmit = async (values) => {
        const url = values.id ? 'admin/music/update' : 'admin/music/create'
        await HttpClient.post(url, values)
        this.app.message.success('已保存')
        if (values.id) player.updateTrack(values.id, values)
        this.setState({editing: null})
        this.reload()
    }

    // ---------- 元数据补全（浏览器端 music-metadata，拉音频头部解析） ----------
    fixMeta = async () => {
        const todo = this.state.tracks.filter(t => !(Number(t.duration) > 0) || !String(t.artist || '').trim() || !String(t.album || '').trim())
        if (!todo.length) { this.app.message.info('时长 / 艺术家 / 专辑都已完整'); return }
        const hide = this.app.message.loading('解析库加载中…', 0)
        let mm
        try { mm = await import('music-metadata') } catch { mm = null }
        hide()
        if (!mm) { this.app.modal.error({title: '错误', content: '解析库加载失败'}); return }

        let ok = 0, failed = 0
        for (let i = 0; i < todo.length; i++) {
            const t = todo[i]
            const h2 = this.app.message.loading(`补全元数据 ${i + 1}/${todo.length}`, 0)
            try {
                const url = UrlUtils.contextPath(`/admin/music/audio/${encodeURIComponent(t.id)}`)
                const res = await fetch(url, {credentials: 'same-origin', headers: {Range: 'bytes=0-262143'}, signal: AbortSignal.timeout(30000)})
                if (!res.ok && res.status !== 206) throw new Error('HTTP ' + res.status)
                const meta = await mm.parseBlob(await res.blob())
                const body = {}
                if (!(Number(t.duration) > 0)) {
                    const sec = Math.round(Number(meta.format?.duration))
                    if (sec > 0 && sec < 86400) body.duration = sec
                }
                const artist = String(meta.common?.artist || meta.common?.albumartist || '').trim().slice(0, 200)
                const album = String(meta.common?.album || '').trim().slice(0, 200)
                if (!String(t.artist || '').trim() && artist) body.artist = artist
                if (!String(t.album || '').trim() && album) body.album = album
                if (Object.keys(body).length) {
                    await HttpClient.post('admin/music/update', {id: t.id, ...body})
                    ok++
                }
            } catch { failed++ } finally { h2() }
        }
        this.app.message.success(`补全完成：成功 ${ok} 首${failed ? `，失败 ${failed} 首` : ''}`)
        this.reload()
    }
    // ---------- 上传（直传 S3/分片 + 代理回退，浏览器端解析 tag） ----------
    setUploadState = (updater) => {
        this.setState(prev => ({
            uploadState: typeof updater === 'function' ? updater(prev.uploadState) : updater,
        }))
    }

    updateUploadItem = (index, patch) => {
        this.setUploadState(state => {
            if (!state) return state
            const items = state.items.map((item, i) => (i === index ? {...item, ...patch} : item))
            return {...state, items}
        })
    }

    filterSignedHeaders = (headers) => {
        const out = {}
        if (!headers) return out
        const forbidden = new Set(['host', 'content-length'])
        for (const [k, v] of Object.entries(headers)) {
            if (v == null) continue
            if (forbidden.has(String(k).toLowerCase())) continue
            out[k] = String(v)
        }
        return out
    }

    xhrPutToS3 = (url, data, headers) => new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest()
        xhr.open('PUT', url, true)
        xhr.withCredentials = false
        for (const [k, v] of Object.entries(headers || {})) {
            try { xhr.setRequestHeader(k, v) } catch { /* ignore */ }
        }
        xhr.onerror = () => {
            const err = new Error('直传失败：网络错误或跨域配置异常')
            err.directPutFailed = true
            reject(err)
        }
        xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.getResponseHeader('ETag'))
            else {
                const err = new Error(`直传失败：HTTP ${xhr.status}`)
                err.directPutFailed = true
                reject(err)
            }
        }
        xhr.send(data)
    })

    uploadFileDirect = async (file) => {
        const prepareRs = await HttpClient.post('admin/sys-file/direct-upload/prepare', {
            originName: file.name,
            size: file.size,
            isPublic: true,
            contentType: file.type || undefined,
        }, null, {toastError: false})
        const info = prepareRs?.data || {}

        // 不支持直传则回退服务端代理上传
        if (!info.supported) {
            const fd = new FormData()
            fd.append('file', file)
            fd.append('isPublic', 'true')
            const rs = await HttpClient.post('admin/sys-file/upload', fd, null, {toastError: false})
            const objectName = rs?.data?.objectName
            if (!objectName) throw new Error('上传返回无 objectName')
            return objectName
        }

        if (info.mode === 'multipart') {
            const partSize = Number(info.partSize) || 5 * 1024 * 1024
            const totalParts = Math.max(1, Math.ceil(file.size / partSize))
            const parts = []
            try {
                for (let partNumber = 1; partNumber <= totalParts; partNumber++) {
                    const start = (partNumber - 1) * partSize
                    const end = Math.min(start + partSize, file.size)
                    const blob = file.slice(start, end)
                    const partRs = await HttpClient.post('admin/sys-file/direct-upload/multipart/part-url', {
                        objectName: info.objectName,
                        uploadId: info.uploadId,
                        partNumber,
                    }, null, {toastError: false})
                    const pinfo = partRs?.data || {}
                    const headers = this.filterSignedHeaders(pinfo.headers)
                    const etag = await this.xhrPutToS3(pinfo.uploadUrl, blob, headers)
                    if (!etag) throw new Error('分片上传未返回 ETag')
                    parts.push({partNumber, etag: String(etag).replace(/"/g, '')})
                }
                const completeRs = await HttpClient.post('admin/sys-file/direct-upload/multipart/complete', {
                    objectName: info.objectName,
                    uploadId: info.uploadId,
                    parts,
                }, null, {toastError: false})
                return completeRs?.data?.objectName || info.objectName
            } catch (e) {
                try {
                    await HttpClient.post('admin/sys-file/direct-upload/multipart/abort', {
                        objectName: info.objectName,
                        uploadId: info.uploadId,
                    }, null, {toastError: false})
                } catch { /* ignore */ }
                if (e && e.directPutFailed) {
                    const fd = new FormData()
                    fd.append('file', file)
                    fd.append('isPublic', 'true')
                    const rs = await HttpClient.post('admin/sys-file/upload', fd, null, {toastError: false})
                    const objectName = rs?.data?.objectName
                    if (!objectName) throw new Error('上传返回无 objectName')
                    return objectName
                }
                throw e
            }
        }

        // 单文件 PUT 直传
        try {
            const headers = this.filterSignedHeaders(info.headers)
            if (file.type && !Object.keys(headers).some(k => k.toLowerCase() === 'content-type')) {
                headers['Content-Type'] = file.type
            }
            await this.xhrPutToS3(info.uploadUrl, file, headers)
            const completeRs = await HttpClient.post('admin/sys-file/direct-upload/complete', {
                objectName: info.objectName,
            }, null, {toastError: false})
            return completeRs?.data?.objectName || info.objectName
        } catch (e) {
            if (e && e.directPutFailed) {
                const fd = new FormData()
                fd.append('file', file)
                fd.append('isPublic', 'true')
                const rs = await HttpClient.post('admin/sys-file/upload', fd, null, {toastError: false})
                const objectName = rs?.data?.objectName
                if (!objectName) throw new Error('上传返回无 objectName')
                return objectName
            }
            throw e
        }
    }

    uploadFiles = async (files) => {
        if (!files.length) return
        const items = files.map((file, i) => ({
            key: `${file.name}-${file.size}-${file.lastModified || 0}-${i}`,
            name: file.name,
            status: 'pending',
            detail: '等待上传',
        }))
        this.setUploadState({items, current: 0, total: files.length, done: false})

        let mm
        try { mm = await import('music-metadata') } catch { mm = null }

        for (let i = 0; i < files.length; i++) {
            const file = files[i]
            this.setUploadState(state => state ? {...state, current: i + 1} : state)
            this.updateUploadItem(i, {status: 'processing', detail: '解析元数据并上传中…'})
            try {
                let meta = null
                if (mm) { try { meta = await mm.parseBlob(file) } catch { /* 解析失败用文件名 */ } }
                const objectName = await this.uploadFileDirect(file)
                const fmt = file.name.includes('.') ? file.name.split('.').pop().toLowerCase() : undefined
                const title = String(meta?.common?.title || '').trim() || file.name.replace(/\.[^.]+$/, '')
                await HttpClient.post('admin/music/create', {
                    title,
                    artist: String(meta?.common?.artist || meta?.common?.albumartist || '').trim().slice(0, 200) || null,
                    album: String(meta?.common?.album || '').trim().slice(0, 200) || null,
                    duration: meta?.format?.duration ? Math.round(meta.format.duration) : null,
                    format: fmt,
                    filePath: objectName,
                })
                this.updateUploadItem(i, {status: 'success', detail: `已添加「${title}」`})
                await this.loadTracks()
                this.loadArtists()
            } catch (e) {
                this.updateUploadItem(i, {status: 'error', detail: e?.message || '未知错误'})
            }
        }
        this.setUploadState(state => state ? {...state, done: true} : state)
    }
    renderUploadModal = () => {
        const {uploadState} = this.state
        if (!uploadState) return null
        const {items, current, total, done} = uploadState
        const successCount = items.filter(i => i.status === 'success').length
        const failCount = items.filter(i => i.status === 'error').length
        const finishedCount = successCount + failCount
        const percent = total ? Math.round((finishedCount / total) * 100) : 0
        const statusIcon = (status) => {
            if (status === 'success') return <CheckCircleOutlined style={{color: '#52c41a'}}/>
            if (status === 'error') return <CloseCircleOutlined style={{color: '#ff4d4f'}}/>
            if (status === 'processing') return <LoadingOutlined style={{color: '#1677ff'}}/>
            return <ClockCircleOutlined style={{color: '#bfbfbf'}}/>
        }
        const statusTag = (status) => {
            if (status === 'success') return <Tag color='success'>成功</Tag>
            if (status === 'error') return <Tag color='error'>失败</Tag>
            if (status === 'processing') return <Tag color='processing'>上传中</Tag>
            return <Tag>等待</Tag>
        }
        const title = done ? '上传完成' : `上传进度（${Math.min(current, total)}/${total}）`

        return <Modal
            open
            title={title}
            closable={done}
            maskClosable={false}
            keyboard={done}
            onCancel={done ? () => this.setUploadState(null) : undefined}
            footer={done ? [<Button key='ok' type='primary' onClick={() => this.setUploadState(null)}>关闭</Button>] : null}
            width={720}
        >
            <Space direction='vertical' size='middle' style={{width: '100%'}}>
                <div>
                    <Progress percent={percent} status={failCount ? 'exception' : (done ? 'success' : 'active')}/>
                    <Typography.Text type='secondary'>
                        共 {total} 个文件，成功 {successCount} 个，失败 {failCount} 个{done ? '' : `，正在处理第 ${Math.min(current, total)} 个`}
                    </Typography.Text>
                </div>
                <List
                    size='small'
                    bordered
                    dataSource={items}
                    style={{maxHeight: 360, overflow: 'auto'}}
                    renderItem={(item) => (
                        <List.Item>
                            <List.Item.Meta
                                avatar={statusIcon(item.status)}
                                title={<Space size={8}><span style={{wordBreak: 'break-all'}}>{item.name}</span>{statusTag(item.status)}</Space>}
                                description={<Typography.Text type={item.status === 'error' ? 'danger' : 'secondary'} style={{wordBreak: 'break-all'}}>
                                    {item.detail}
                                </Typography.Text>}
                            />
                        </List.Item>
                    )}
                />
            </Space>
        </Modal>
    }

    // ---------- 底部播放条（网易云风格） ----------
    renderPlayerBar = () => {
        const cur = player.current
        const playing = player.isPlaying
        const dur = this.state.duration || (cur?.duration ? Number(cur.duration) : 0)
        const curT = this.state.curTime
        const mode = PLAY_MODES.find(m => m.key === player.mode) || PLAY_MODES[0]
        const fav = cur ? Number(cur.favorite) > 0 : false

        return <div className='mc-player' aria-label='播放控制栏'>
            <div className='mc-now'>
                <div className='mc-now-cover'>
                    {cur?.coverUrl ? <img src={cur.coverUrl} alt=''/> : <AudioOutlined/>}
                </div>
                <div className='mc-now-meta'>
                    <div className='mc-now-title'>{cur ? (cur.title || '(未命名曲目)') : '未在播放'}</div>
                    <div className='mc-now-sub'>{cur ? (cur.artist || '未知艺术家') : '在列表中选择曲目开始播放'}</div>
                </div>
                {cur ? (
                    <Tooltip title={fav ? '取消收藏' : '收藏'}>
                        <button type='button' className={`mc-heart${fav ? ' active' : ''}`} onClick={() => this.toggleFavorite(cur)}>
                            {fav ? <HeartFilled/> : <HeartOutlined/>}
                        </button>
                    </Tooltip>
                ) : null}
            </div>
            <div className='mc-center'>
                <div className='mc-controls'>
                    <Tooltip title={`播放模式：${mode.label}（点击切换）`}>
                        <button type='button' className={`mc-mode${player.mode !== 'order' ? ' active' : ''}`} onClick={() => player.cycleMode()}>
                            {MODE_ICONS[mode.key] || <OrderedListOutlined/>}
                        </button>
                    </Tooltip>
                    <Tooltip title='上一首'>
                        <button type='button' className='mc-ctl' onClick={() => player.prev()}><StepBackwardFilled/></button>
                    </Tooltip>
                    <Tooltip title={playing ? '暂停' : '播放'}>
                        <button type='button' className='mc-playbtn' onClick={() => player.toggle()}>
                            {playing ? <PauseCircleFilled/> : <PlayCircleFilled/>}
                        </button>
                    </Tooltip>
                    <Tooltip title='下一首'>
                        <button type='button' className='mc-ctl' onClick={() => player.next()}><StepForwardFilled/></button>
                    </Tooltip>
                </div>
                <div className='mc-progress'>
                    <span className='mc-time'>{fmtDuration(curT) || '0:00'}</span>
                    <Slider className={dur > 0 ? 'mc-seek' : 'mc-seek mc-seek-disabled'} min={0} max={Math.max(1, Math.floor(dur))}
                            step={1} value={Math.min(Math.floor(curT), Math.floor(dur || 1))} disabled={!(dur > 0)}
                            onChange={() => this.setState({seeking: true})}
                            onChangeComplete={(v) => {
                                const a = player.audio
                                if (a && Number.isFinite(a.duration)) a.currentTime = v
                                this.setState({seeking: false, curTime: v})
                            }}
                            tooltip={{formatter: v => fmtDuration(v) || '0:00'}}/>
                    <span className='mc-time'>{fmtDuration(dur) || '0:00'}</span>
                </div>
            </div>
            <div className='mc-right'>
                <Tooltip title={this.state.volume > 0 ? '取消静音' : '静音'}>
                    <button type='button' className='mc-ctl' onClick={this.toggleMute}>
                        {this.state.volume > 0 ? <SoundFilled/> : <MutedOutlined/>}
                    </button>
                </Tooltip>
                <Slider className='mc-vol' min={0} max={1} step={0.01} value={this.state.volume}
                        tooltip={false} onChange={this.setVolume}/>
                <Badge count={player.queue.length} size='small' color='#ec4141'>
                    <Tooltip title='播放列表'>
                        <button type='button' className={`mc-queue-btn${this.state.queueOpen ? ' active' : ''}`}
                                onClick={() => this.setState({queueOpen: !this.state.queueOpen})}>
                            <UnorderedListOutlined/>
                        </button>
                    </Tooltip>
                </Badge>
            </div>
        </div>
    }
    // ---------- 播放列表面板 ----------
    renderPlaylistPanel = () => {
        const q = player.queue
        return <aside className='mc-playlist' hidden={!this.state.queueOpen} aria-label='播放列表'>
            <div className='mc-pl-head'>
                <strong>播放列表</strong>
                <span className='mc-pl-count'>{q.length ? `共 ${q.length} 首` : ''}</span>
                <span className='mc-pl-acts'>
                    <Popconfirm title='清空播放列表并停止播放？' onConfirm={() => player.stop()}>
                        <button type='button' className='mc-iconbtn' disabled={!q.length} aria-label='清空播放列表'><DeleteOutlined/></button>
                    </Popconfirm>
                    <button type='button' className='mc-iconbtn' onClick={() => this.setState({queueOpen: false})} aria-label='关闭'>
                        <CloseOutlined/>
                    </button>
                </span>
            </div>
            <ol className='mc-pl-items'>
                {q.length ? q.map((t, i) => {
                    const isCur = i === player.index
                    return <li key={`${t.id}-${i}`} className={`mc-pl-item${isCur ? ' active' : ''}`}>
                        <button type='button' className='mc-pl-pick' onClick={() => player.play(t.id, q)} title={t.title}>
                            <span className='mc-pl-no'>
                                {isCur ? (player.isPlaying ? <PauseCircleFilled/> : <PlayCircleFilled/>) : i + 1}
                            </span>
                            <span className='mc-pl-meta'>
                                <span className='mc-pl-title'>{t.title}</span>
                                {t.artist ? <span className='mc-pl-sub'>{t.artist}</span> : null}
                            </span>
                            <span className='mc-pl-dur'>{fmtDuration(t.duration) || '--:--'}</span>
                        </button>
                        <button type='button' className='mc-pl-rm' onClick={() => player.removeAt(i)} aria-label='移出播放列表'>
                            <CloseOutlined/>
                        </button>
                    </li>
                }) : <li className='mc-pl-empty'>播放列表是空的</li>}
            </ol>
        </aside>
    }

    render() {
        const {tracks, loading, editing, artists, keyword, artist, uploadState} = this.state
        const uploading = !!uploadState && !uploadState.done
        const moreItems = [
            {key: 'reset', icon: <CloseCircleOutlined/>, label: '重置筛选'},
            {key: 'fix', icon: <RedoOutlined/>, label: '补全元数据'},
        ]
        const onMore = ({key}) => {
            if (key === 'reset') this.setState({keyword: undefined, artist: undefined}, () => this.loadTracks())
            else if (key === 'fix') this.fixMeta()
        }

        const rows = tracks.map((t, i) => {
            const isCur = player.currentId === String(t.id)
            const playingHere = isCur && player.isPlaying
            return <div key={t.id} className={`mc-row${isCur ? ' active' : ''}`}>
                <span className='mc-col-no'>
                    <span className='mc-no'>{i + 1}</span>
                    <button type='button' className='mc-rowplay'
                            onClick={() => (isCur ? player.toggle() : this.playTrack(t.id))}
                            aria-label={isCur ? (playingHere ? '暂停' : '播放') : `播放 ${t.title || ''}`}>
                        {playingHere ? <PauseCircleFilled/> : <PlayCircleFilled/>}
                    </button>
                </span>
                <span className='mc-col-title'>
                    <span className='mc-cover'>
                        {t.coverUrl ? <img src={t.coverUrl} alt='' loading='lazy'/> : <AudioOutlined/>}
                    </span>
                    <span className='mc-track-meta'>
                        <span className='mc-track-name' onClick={() => this.playTrack(t.id)}>{t.title || '(未命名曲目)'}</span>
                        <span className='mc-track-sub'>
                            {t.artist || '未知艺术家'}
                            {t.format ? ` · ${String(t.format).toUpperCase()}` : ''}
                            {Number(t.playCount) > 0 ? ` · 播放 ${t.playCount}` : ''}
                        </span>
                    </span>
                </span>
                <span className='mc-col-album'>{t.album || '—'}</span>
                <span className='mc-col-dur'>{fmtDuration(t.duration) || '—'}</span>
                <span className='mc-col-acts'>
                    <PermActions more size='small' visibleCount={1} actions={[
                        {
                            label: Number(t.favorite) > 0 ? '取消收藏' : '收藏',
                            icon: <HeartOutlined/>,
                            perm: 'music:edit',
                            onClick: () => this.toggleFavorite(t),
                        },
                        {label: '加入播放列表', icon: <PlusOutlined/>, perm: 'music:read', onClick: () => this.addToQueue(t.id)},
                        {label: '编辑', icon: <EditOutlined/>, perm: 'music:edit', onClick: () => this.openEdit(t)},
                        {
                            label: '删除', danger: true, perm: 'music:edit',
                            confirm: `确定删除「${t.title || ''}」？`,
                            onClick: () => this.removeTrack(t.id),
                        },
                    ]}/>
                </span>
            </div>
        })

        return <div className='mc-root'>
            <header className='mc-topbar'>
                <div className='mc-top-left'>
                    <button type='button' className='mc-iconbtn' onClick={() => history.push('/')} aria-label='返回'>
                        <LeftOutlined/>
                    </button>
                    <div className='mc-top-meta'>
                        <div className='mc-top-title'>音乐</div>
                        <div className='mc-top-sub'>我的音乐{tracks.length ? ` · ${tracks.length} 首` : ''}</div>
                    </div>
                </div>
                <div className='mc-top-right'>
                    <Input allowClear placeholder='搜索标题 / 艺术家 / 专辑' prefix={<SearchOutlined/>} style={{width: 230}}
                           value={keyword} onChange={e => this.setState({keyword: e.target.value})}
                           onPressEnter={() => this.loadTracks()}/>
                    <Select allowClear placeholder='艺术家' style={{width: 150}} value={artist}
                            onChange={(v) => this.setState({artist: v}, () => this.loadTracks())}
                            options={artists.map(a => ({value: a, label: a}))}/>
                    <PermActions actions={[
                        {label: '播放全部', icon: <PlayCircleFilled/>, perm: 'music:read', onClick: () => tracks.length && player.playQueue(tracks, 0)},
                        {label: '随机播放', icon: <RetweetOutlined/>, perm: 'music:read', onClick: () => tracks.length && player.playQueue(tracks, 0, {mode: 'shuffle', random: true})},
                    ]}/>
                    <input ref={this.fileInputRef} type='file' accept='audio/*,.ape,.flac' multiple hidden
                           onChange={e => {
                               const files = [...e.target.files]
                               e.target.value = ''
                               if (files.length) this.uploadFiles(files)
                           }}/>
                    <Button icon={<CloudUploadOutlined/>} disabled={!!uploadState} loading={uploading}
                            onClick={() => this.fileInputRef.current?.click()}>上传</Button>
                    <Dropdown menu={{items: moreItems, onClick: onMore}}>
                        <button type='button' className='mc-iconbtn' aria-label='更多'><MoreOutlined/></button>
                    </Dropdown>
                </div>
            </header>

            <div className='mc-body'>
                <div className='mc-main'>
                    <div className='mc-row mc-row-head'>
                        <span className='mc-col-no'>#</span>
                        <span className='mc-col-title'>标题</span>
                        <span className='mc-col-album'>专辑</span>
                        <span className='mc-col-dur'>时长</span>
                        <span className='mc-col-acts'/>
                    </div>
                    {loading ? (
                        <div className='mc-status'><Spin/></div>
                    ) : tracks.length === 0 ? (
                        <div className='mc-status'>
                            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE}
                                   description={keyword || artist ? '没有匹配的曲目' : '暂无曲目 · 点右上角「上传」添加音频文件'}/>
                        </div>
                    ) : rows}
                </div>
                {this.renderPlaylistPanel()}
            </div>

            <FormModal ref={this.modalRef} title={editing ? '编辑曲目' : '新增曲目'}
                       onFinish={this.handleSubmit} labelCol={{flex: '80px'}}>
                <Form.Item label='标题' name='title' rules={[{required: true, message: '请输入曲目名称'}]}>
                    <Input/>
                </Form.Item>
                <Form.Item label='艺术家' name='artist'><Input/></Form.Item>
                <Form.Item label='专辑' name='album'><Input/></Form.Item>
                <Form.Item label='封面链接' name='coverUrl'><Input placeholder='https://…（可选）'/></Form.Item>
                {editing ? <Form.Item label='文件信息'>
                    <Space direction='vertical' size={0}>
                        <Typography.Text type='secondary' style={{fontSize: 12}}>
                            格式：{editing.format || '—'} · 时长：{fmtDuration(editing.duration) || '—'}
                        </Typography.Text>
                        <Typography.Text type='secondary' style={{fontSize: 12, wordBreak: 'break-all'}}>
                            路径：{editing.filePath || '—'}
                        </Typography.Text>
                    </Space>
                </Form.Item> : null}
            </FormModal>

            {this.renderPlayerBar()}
            {this.renderUploadModal()}
        </div>
    }
}
