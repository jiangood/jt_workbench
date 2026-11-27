import {ArrowLeftOutlined, EyeOutlined} from '@ant-design/icons'
import {Button, Card, Form, Input, Select, Space, Spin, message} from 'antd'
import React from 'react'
import {FieldEditor, FieldUploadFile, HttpClient, Page, PageUtils, history} from '@jiangood/open-admin'
import {plainTextToHtml, validateSourceUrl} from './html'
import './note.css'

export const pageMeta = {title: '笔记编辑'}

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

export default class NoteEditPage extends React.Component {

    state = {
        id: null,
        loading: false,
        saving: false,
        folders: [],
        isMobile: typeof window !== 'undefined' && typeof window.matchMedia === 'function'
            ? window.matchMedia('(max-width: 768px)').matches
            : false,
    }

    formRef = React.createRef()
    mobileMediaQuery = null
    handleMobileChange = null

    componentDidMount() {
        const params = readQueryParams()
        if (typeof window.matchMedia === 'function') {
            this.mobileMediaQuery = window.matchMedia('(max-width: 768px)')
            this.handleMobileChange = e => this.setState({isMobile: e.matches})
            this.mobileMediaQuery.addEventListener('change', this.handleMobileChange)
        }
        const id = params.id ? String(params.id) : null
        const folderId = params.folderId ? String(params.folderId) : null
        this.setState({id})
        this.loadFolders()
        if (id) {
            this.loadDetail(id)
        } else if (folderId) {
            // 新建时预选目录
            setTimeout(() => this.formRef.current?.setFieldsValue({folderId}))
        }
    }

    componentWillUnmount() {
        this.mobileMediaQuery?.removeEventListener('change', this.handleMobileChange)
    }

    loadFolders = () => {
        HttpClient.get('admin/note/folders').then(rs => {
            this.setState({folders: rs.data || []})
        })
    }

    loadDetail = (id) => {
        this.setState({loading: true})
        HttpClient.get(`admin/note/info/${id}`).then(rs => {
            const data = rs.data
            if (data) {
                this.formRef.current?.setFieldsValue({
                    id: data.id,
                    title: data.title,
                    folderId: data.folderId || undefined,
                    // 历史笔记只有纯文本正文，编辑时转成简单 HTML 交给富文本编辑器
                    contentHtml: data.contentHtml || plainTextToHtml(data.content || ''),
                    attachments: data.attachments || undefined,
                    sourceUrl: data.sourceUrl || undefined,
                })
            } else {
                message.error('笔记不存在或已删除')
            }
        }).finally(() => this.setState({loading: false}))
    }

    handleSave = async () => {
        try {
            const values = await this.formRef.current?.validateFields()
            if (!values) return
            this.setState({saving: true})
            const url = values.id ? 'admin/note/update' : 'admin/note/create'
            await HttpClient.post(url, values)
            if (values.id) {
                message.success('已保存')
            }
            history.push('/note')
        } catch {
            // 校验失败或提交失败（HttpClient 已提示错误）时停留在当前页
        } finally {
            this.setState({saving: false})
        }
    }

    handleBack = () => {
        history.push('/note')
    }

    handleView = () => {
        const {id} = this.state
        if (id) history.push(`/note/view?id=${encodeURIComponent(id)}`)
    }

    render() {
        const {id, loading, saving, folders, isMobile} = this.state
        const isEdit = !!id
        const folderOptions = folders.map(f => ({label: f.name, value: f.id}))
        const title = isEdit ? '编辑笔记' : '新增笔记'

        return <Page padding={false}>
            <div className='note-edit-page'>
                <Card
                    className='note-edit-card'
                    title={(
                        <Space>
                            <Button type='text' icon={<ArrowLeftOutlined/>} onClick={this.handleBack} aria-label='返回笔记列表'/>
                            <span>{title}</span>
                        </Space>
                    )}
                    extra={isMobile ? null : (
                        <Space>
                            {isEdit ? <Button icon={<EyeOutlined/>} onClick={this.handleView}>预览</Button> : null}
                            <Button onClick={this.handleBack}>取消</Button>
                            <Button type='primary' loading={saving} onClick={this.handleSave}>保存</Button>
                        </Space>
                    )}
                >
                    <Spin spinning={loading}>
                        <Form ref={this.formRef} labelCol={{flex: '70px'}} style={{maxWidth: 960}}>
                            <Form.Item name='id' hidden>
                                <Input/>
                            </Form.Item>
                            <Form.Item label='标题' name='title' rules={[{required: true, message: '请输入标题'}]}>
                                <Input placeholder='请输入标题'/>
                            </Form.Item>
                            <Form.Item label='目录' name='folderId'>
                                <Select allowClear placeholder='未分类' options={folderOptions}/>
                            </Form.Item>
                            <Form.Item label='原文链接' name='sourceUrl' rules={[{validator: validateSourceUrl}]}>
                                <Input placeholder='可粘贴 https://... 或域名' maxLength={1024} allowClear/>
                            </Form.Item>
                            <Form.Item label='正文' name='contentHtml'>
                                <FieldEditor height={isMobile ? 360 : 480} isPublic={false}/>
                            </Form.Item>
                            <Form.Item label='附件' name='attachments'
                                       extra='支持 PDF、Word、压缩包等；正文图片会跟随笔记一起保存。'>
                                <FieldUploadFile maxCount={20} listType='text' isPublic={false}/>
                            </Form.Item>
                        </Form>
                    </Spin>
                </Card>
                {isMobile && (
                    <div className='note-edit-actions'>
                        {isEdit ? <Button icon={<EyeOutlined/>} onClick={this.handleView}>预览</Button> : null}
                        <Button onClick={this.handleBack}>取消</Button>
                        <Button type='primary' loading={saving} onClick={this.handleSave}>保存</Button>
                    </div>
                )}
            </div>
        </Page>
    }
}
