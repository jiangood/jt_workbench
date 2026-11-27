import {ArrowLeftOutlined, DownloadOutlined, EditOutlined, PaperClipOutlined} from '@ant-design/icons'
import {Button, Card, Empty, Space, Spin, Tag, Typography, message} from 'antd'
import React from 'react'
import {HttpClient, Page, PageUtils, UrlUtils, history} from '@jiangood/open-admin'
import {isEmptyHtml, sanitizeNoteHtml} from './html'
import './note.css'

export const pageMeta = {title: '笔记详情'}

function readQueryParams() {
    const params = (PageUtils && typeof PageUtils.currentParams === 'function' && PageUtils.currentParams()) || {}
    const out = {...params}
    const hash = window.location.hash || ''
    const q = hash.includes('?') ? hash.slice(hash.indexOf('?') + 1) : ''
    if (q) {
        const sp = new URLSearchParams(q)
        sp.forEach((v, k) => {
            if (out[k] == null || out[k] === '') out[k] = v
        })
    }
    return out
}

export function fmtTime(v) {
    if (!v) return ''
    const s = String(v)
    if (s.includes('T')) return s.replace('T', ' ').slice(0, 16).replace(/-/g, '/')
    return s.slice(0, 16)
}

export function fmtSize(bytes) {
    const n = Number(bytes)
    if (!Number.isFinite(n) || n <= 0) return ''
    const units = ['B', 'KB', 'MB', 'GB', 'TB']
    let value = n
    let i = 0
    while (value >= 1024 && i < units.length - 1) {
        value /= 1024
        i += 1
    }
    return `${value >= 10 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`
}

/** 笔记详情：只读展示富文本正文与附件，编辑入口返回富文本编辑页 */
export default class NoteViewPage extends React.Component {

    state = {
        id: null,
        loading: true,
        note: null,
        isMobile: typeof window !== 'undefined' && typeof window.matchMedia === 'function'
            ? window.matchMedia('(max-width: 768px)').matches
            : false,
    }

    mobileMediaQuery = null
    handleMobileChange = null

    componentDidMount() {
        if (typeof window.matchMedia === 'function') {
            this.mobileMediaQuery = window.matchMedia('(max-width: 768px)')
            this.handleMobileChange = e => this.setState({isMobile: e.matches})
            this.mobileMediaQuery.addEventListener('change', this.handleMobileChange)
        }
        const params = readQueryParams()
        const id = params.id ? String(params.id) : null
        this.setState({id})
        if (id) {
            this.loadDetail(id)
        } else {
            this.setState({loading: false})
        }
    }

    componentWillUnmount() {
        this.mobileMediaQuery?.removeEventListener('change', this.handleMobileChange)
    }

    loadDetail = (id) => {
        this.setState({loading: true})
        HttpClient.get(`admin/note/info/${id}`).then(rs => {
            if (rs.data) {
                this.setState({note: rs.data})
            } else {
                message.error('笔记不存在或已删除')
            }
        }).finally(() => this.setState({loading: false}))
    }

    handleBack = () => {
        history.push('/note')
    }

    handleEdit = () => {
        const {id} = this.state
        if (id) history.push(`/note/edit?id=${encodeURIComponent(id)}`)
    }

    renderAttachments(note) {
        const files = Array.isArray(note?.attachmentFiles) ? note.attachmentFiles : []
        if (!files.length) return null
        return <div className='note-view-attachments'>
            <div className='note-view-attachments-head'>
                <PaperClipOutlined/>
                <span>附件 {files.length}</span>
            </div>
            <ul className='note-view-attachment-list'>
                {files.map(file => {
                    const href = UrlUtils.contextPath(`/admin/sys-file/download/${encodeURI(file.objectName)}`)
                    const preview = UrlUtils.contextPath(`/file/${encodeURI(file.objectName)}`)
                    const size = fmtSize(file.size)
                    return <li key={file.objectName}>
                        <a href={preview} target='_blank' rel='noreferrer' className='note-view-attachment'>
                            <PaperClipOutlined/>
                            <span className='note-view-attachment-name'>{file.name || file.objectName}</span>
                            {size ? <span className='note-view-attachment-size'>{size}</span> : null}
                        </a>
                        <a href={href} className='note-view-attachment-download' aria-label={`下载 ${file.name || ''}`}>
                            <DownloadOutlined/>
                        </a>
                    </li>
                })}
            </ul>
        </div>
    }

    render() {
        const {id, loading, note, isMobile} = this.state
        const html = note ? sanitizeNoteHtml(note.contentHtml || '') : ''
        const hasContent = html && !isEmptyHtml(html)
        const folderName = note?.folderName || (note?.folderId ? '已删除目录' : '未分类')

        return <Page padding={false}>
            <div className='note-view-page'>
                <Card
                    className='note-view-card'
                    title={(
                        <Space>
                            <Button type='text' icon={<ArrowLeftOutlined/>} onClick={this.handleBack} aria-label='返回笔记列表'/>
                            <span>笔记详情</span>
                        </Space>
                    )}
                    extra={isMobile ? null : (
                        <Button type='primary' icon={<EditOutlined/>} perm='note:edit' onClick={this.handleEdit}>编辑</Button>
                    )}
                >
                    <Spin spinning={loading}>
                        {!note && !loading
                            ? <Empty description={id ? '笔记不存在或已删除' : '缺少笔记参数'}/>
                            : note ? <>
                                <h1 className='note-view-title'>{note.title || '无标题'}</h1>
                                <div className='note-view-meta'>
                                    <Tag bordered={false}>{folderName}</Tag>
                                    {note.updateTime ? <span>更新于 {fmtTime(note.updateTime)}</span> : null}
                                    {note.sourceUrl ? <a href={note.sourceUrl} target='_blank'
                                                        rel='noreferrer'>查看来源</a> : null}
                                </div>
                                {hasContent
                                    ? <div className='note-rich-content' dangerouslySetInnerHTML={{__html: html}}/>
                                    : <Typography.Paragraph type='secondary'>（无正文）</Typography.Paragraph>}
                                {this.renderAttachments(note)}
                            </> : null}
                    </Spin>
                </Card>
                {isMobile && note ? (
                    <div className='note-view-actions'>
                        <Button icon={<ArrowLeftOutlined/>} onClick={this.handleBack}>返回</Button>
                        <Button type='primary' icon={<EditOutlined/>} perm='note:edit' onClick={this.handleEdit}>编辑</Button>
                    </div>
                ) : null}
            </div>
        </Page>
    }
}
