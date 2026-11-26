import {DeleteOutlined, EditOutlined, FolderAddOutlined, PlusOutlined, SearchOutlined, SettingOutlined} from '@ant-design/icons'
import {Button, Form, Input, Modal, Select, Segmented, Space, Tree, Typography} from 'antd'
import React from 'react'
import {FormModal, HttpClient, Page, PermActions, ProTable, history} from '@jiangood/open-admin'
import './note.css'

const MOBILE_QUERY = '(max-width: 768px)'

const FOLDER_ALL = 'all'
const FOLDER_NONE = 'none'

/** 笔记：顶部扁平目录筛选 + 笔记列表；新增/编辑打开独立页面 */
export default class NotePage extends React.Component {

    state = {
        folders: [],
        folderId: FOLDER_ALL,
        folderModalOpen: false,
        folderParentId: null,
        folderEditing: null,
        folderManageOpen: false,
        isMobile: typeof window !== 'undefined' && typeof window.matchMedia === 'function'
            ? window.matchMedia(MOBILE_QUERY).matches
            : false,
    }

    tableRef = React.createRef()
    folderModalRef = React.createRef()
    mobileMediaQuery = null
    handleMobileChange = null

    componentDidMount() {
        if (typeof window.matchMedia === 'function') {
            this.mobileMediaQuery = window.matchMedia(MOBILE_QUERY)
            this.handleMobileChange = e => this.setState({isMobile: e.matches})
            this.mobileMediaQuery.addEventListener('change', this.handleMobileChange)
        }
        this.loadFolders()
    }

    componentWillUnmount() {
        this.mobileMediaQuery?.removeEventListener('change', this.handleMobileChange)
    }

    loadFolders = () => {
        HttpClient.get('admin/note/folders').then(rs => {
            this.setState({folders: rs.data || []})
        })
    }

    /** 平铺目录 → 按 seq、名称排序的目录选项（含全部/未分类两个虚拟项） */
    folderOptionsWithVirtual = () => {
        const options = [...this.state.folders]
            .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0) || String(a.name).localeCompare(String(b.name)))
            .map(folder => ({label: folder.name, value: String(folder.id)}))
        return [
            {label: '全部笔记', value: FOLDER_ALL},
            {label: '未分类', value: FOLDER_NONE},
            ...options,
        ]
    }

    folderName = (folderId) => {
        if (!folderId) return '未分类'
        const f = this.state.folders.find(x => x.id === folderId)
        return f ? f.name : '（已删除目录）'
    }

    handleSelectFolder = (value) => {
        this.setState({folderId: String(value)}, () => this.tableRef.current?.reload())
    }

    openAddNote = () => {
        const {folderId} = this.state
        if (folderId && folderId !== FOLDER_ALL && folderId !== FOLDER_NONE) {
            history.push(`/note/edit?folderId=${encodeURIComponent(folderId)}`)
        } else {
            history.push('/note/edit')
        }
    }

    openEditNote = (record) => {
        if (!record?.id) return
        history.push(`/note/edit?id=${encodeURIComponent(record.id)}`)
    }

    handleNoteDelete = (record) => {
        Modal.confirm({
            title: '删除笔记',
            content: `确定删除「${record.title}」？`,
            okButtonProps: {danger: true},
            onOk: () => HttpClient.post('admin/note/delete', {id: record.id}, null).then(() => this.tableRef.current?.reload()),
        })
    }

    // ---------- 目录维护 ----------

    openAddFolder = (parentId = null) => {
        this.setState({folderEditing: null, folderParentId: parentId})
        this.folderModalRef.current.open({parentId: parentId || null})
    }

    openEditFolder = (folderId) => {
        const folder = this.state.folders.find(f => f.id === folderId)
        if (!folder) return
        this.setState({folderEditing: folder})
        this.folderModalRef.current.open({...folder})
    }

    handleFolderFinish = async (values) => {
        const url = values.id ? 'admin/note/folders/update' : 'admin/note/folders'
        await HttpClient.post(url, values)
        this.loadFolders()
    }

    handleFolderDelete = (folderId) => {
        const folder = this.state.folders.find(f => f.id === folderId)
        if (!folder) return
        Modal.confirm({
            title: '删除目录',
            content: `确定删除目录「${folder.name}」？目录下的笔记不会被删除（变为未分类）。`,
            okButtonProps: {danger: true},
            onOk: () => HttpClient.ajax({url: 'admin/note/folders/' + folderId, method: 'DELETE'})
                .then(() => {
                    this.setState({folderId: this.state.folderId === folderId ? FOLDER_ALL : this.state.folderId})
                    this.loadFolders()
                    this.tableRef.current?.reload()
                }),
        })
    }

    /** 目录管理保留树形结构，便于维护父子目录 */
    buildFolderTree = () => {
        const byParent = new Map()
        this.state.folders.forEach(folder => {
            const key = folder.parentId || ''
            if (!byParent.has(key)) byParent.set(key, [])
            byParent.get(key).push(folder)
        })
        const build = (parentKey) => (byParent.get(parentKey) || [])
            .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0) || String(a.name).localeCompare(String(b.name)))
            .map(folder => ({
                key: folder.id,
                title: folder.name,
                isFolder: true,
                children: build(folder.id),
            }))
        return build('')
    }

    render() {
        const {folders, folderId, folderEditing, folderManageOpen, isMobile} = this.state
        const folderOptions = folders.map(f => ({label: f.name, value: f.id}))

        return <Page>
            <div className='note-page'>
                <div className='note-filters'>
                    <Segmented
                        value={folderId}
                        options={this.folderOptionsWithVirtual()}
                        onChange={this.handleSelectFolder}
                        aria-label='按笔记目录筛选'
                    />
                    <PermActions actions={[
                        {label: '目录管理', icon: <SettingOutlined/>, perm: 'note:edit', onClick: () => this.setState({folderManageOpen: true})},
                    ]}/>
                </div>

                <ProTable
                    actionRef={this.tableRef}
                    rowKey='id'
                    searchInline
                    scrollX={true}
                    searchFormRender={() => (
                        <Form.Item name='keyword' noStyle>
                            <Input prefix={<SearchOutlined/>} placeholder='搜索标题或正文' allowClear/>
                        </Form.Item>
                    )}
                    toolBarRightRender={() => (
                        <PermActions actions={[
                            {
                                label: isMobile ? <span className='note-sr-only'>新增笔记</span> : '新增笔记',
                                type: 'primary', icon: <PlusOutlined/>, perm: 'note:edit', onClick: this.openAddNote,
                            },
                        ]}/>
                    )}
                    request={(params) => HttpClient.post('admin/note/page', null, {
                        ...params,
                        folderId: folderId === FOLDER_ALL ? undefined : folderId,
                    })}
                    columns={[
                        {
                            title: '标题', dataIndex: 'title', className: 'note-cell-title',
                            render: (v, record) => <a onClick={() => this.openEditNote(record)}>{v}</a>,
                        },
                        {
                            title: '目录', dataIndex: 'folderId', width: 140, className: 'note-cell-folder',
                            render: (v) => <Typography.Text type='secondary'>{this.folderName(v)}</Typography.Text>,
                        },
                        {
                            title: '内容', dataIndex: 'content', ellipsis: true, className: 'note-cell-content',
                            render: (v) => (v || '').replace(/[#*`>\s]+/g, ' ').trim().slice(0, 80),
                        },
                        {
                            title: '更新时间', dataIndex: 'updateTime', width: 160, className: 'note-cell-updated',
                            render: v => <span>{v || '-'}</span>,
                        },
                        {
                            title: '操作', dataIndex: 'option', width: 130, className: 'note-cell-actions',
                            render: (_, record) => (
                                <PermActions more={isMobile} actions={[
                                    {label: '编辑', perm: 'note:edit', onClick: () => this.openEditNote(record)},
                                    {label: '删除', danger: true, perm: 'note:edit', onClick: () => this.handleNoteDelete(record)},
                                ]}/>
                            ),
                        },
                    ]}
                />
            </div>

            <FormModal ref={this.folderModalRef} title={folderEditing ? '编辑目录' : '新建目录'}
                       onFinish={this.handleFolderFinish} labelCol={{flex: '70px'}}>
                <Form.Item label='名称' name='name' rules={[{required: true, message: '请输入目录名称'}]}>
                    <Input/>
                </Form.Item>
                <Form.Item label='上级目录' name='parentId'>
                    <Select allowClear placeholder='根目录'
                            options={folderOptions.filter(o => o.value !== folderEditing?.id)}/>
                </Form.Item>
            </FormModal>

            <Modal title='目录管理' open={folderManageOpen} onCancel={() => this.setState({folderManageOpen: false})}
                   footer={null} rootClassName='note-folder-modal' width={isMobile ? 'calc(100vw - 24px)' : 520}>
                <Space style={{marginBottom: 12}}>
                    <Button type='primary' size='small' icon={<FolderAddOutlined/>} perm='note:edit'
                            onClick={() => this.openAddFolder(null)}>新建根目录</Button>
                </Space>
                <Tree
                    blockNode
                    defaultExpandAll
                    treeData={this.buildFolderTree()}
                    titleRender={(node) => (
                        <div className='note-folder-node'>
                            <span className='note-folder-name'>{node.title}</span>
                            <Space size={0} className='note-folder-actions'>
                                <Button type='text' size='small' perm='note:edit' icon={<EditOutlined/>}
                                        aria-label={`编辑目录 ${node.title}`}
                                        onClick={e => { e.stopPropagation(); this.openEditFolder(node.key) }}/>
                                <Button type='text' size='small' danger perm='note:edit' icon={<DeleteOutlined/>}
                                        aria-label={`删除目录 ${node.title}`}
                                        onClick={e => { e.stopPropagation(); this.handleFolderDelete(node.key) }}/>
                            </Space>
                        </div>
                    )}
                />
                <Typography.Text type='secondary' style={{display: 'block', marginTop: 8}}>提示：删除目录后，其中笔记会变为未分类。</Typography.Text>
            </Modal>
        </Page>
    }


}