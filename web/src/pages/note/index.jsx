import {DeleteOutlined, EditOutlined, FolderAddOutlined, MenuOutlined, PlusOutlined, SearchOutlined, SettingOutlined} from '@ant-design/icons'
import {Button, Card, Drawer, Form, Input, Modal, Select, Space, Splitter, Tree, Typography} from 'antd'
import React from 'react'
import {FormModal, HttpClient, Page, PermActions, ProTable, history} from '@jiangood/open-admin'
import './note.css'

const MOBILE_QUERY = '(max-width: 768px)'

const FOLDER_ALL = 'all'
const FOLDER_NONE = 'none'

/** 笔记：左侧目录树（全部 / 未分类 / 自定义目录）+ 右侧列表；新增/编辑打开独立页面 */
export default class NotePage extends React.Component {

    state = {
        folders: [],
        expandedKeys: [],
        folderId: FOLDER_ALL,
        folderModalOpen: false,
        folderParentId: null,
        folderEditing: null,
        folderManageOpen: false,
        isMobile: typeof window !== 'undefined' && typeof window.matchMedia === 'function'
            ? window.matchMedia(MOBILE_QUERY).matches
            : false,
        folderDrawerOpen: false,
    }

    tableRef = React.createRef()
    folderModalRef = React.createRef()
    mobileMediaQuery = null
    handleMobileChange = null

    componentDidMount() {
        this.loadFolders()
        if (typeof window.matchMedia === 'function') {
            this.mobileMediaQuery = window.matchMedia(MOBILE_QUERY)
            this.handleMobileChange = e => {
                this.setState({
                    isMobile: e.matches,
                    ...(!e.matches ? {folderDrawerOpen: false} : {}),
                })
            }
            this.mobileMediaQuery.addEventListener('change', this.handleMobileChange)
        }
    }

    componentWillUnmount() {
        this.mobileMediaQuery?.removeEventListener('change', this.handleMobileChange)
    }

    loadFolders = () => {
        HttpClient.get('admin/note/folders').then(rs => {
            const folders = rs.data || []
            this.setState({folders, expandedKeys: folders.map(f => f.id)})
        })
    }

    /** 平铺目录 → antd Tree 数据（含全部/未分类两个虚拟节点） */
    buildTreeData = () => {
        const {folders} = this.state
        const byParent = new Map()
        folders.forEach(f => {
            const key = f.parentId || ''
            if (!byParent.has(key)) byParent.set(key, [])
            byParent.get(key).push(f)
        })
        const build = (parentKey) => (byParent.get(parentKey) || [])
            .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0) || String(a.name).localeCompare(String(b.name)))
            .map(f => ({
                key: f.id,
                title: f.name,
                isFolder: true,
                children: build(f.id),
            }))
        return [
            {key: FOLDER_ALL, title: '全部笔记'},
            {key: FOLDER_NONE, title: '未分类'},
            ...build(''),
        ]
    }

    folderName = (folderId) => {
        if (!folderId) return '未分类'
        const f = this.state.folders.find(x => x.id === folderId)
        return f ? f.name : '（已删除目录）'
    }

    handleSelectFolder = (keys) => {
        const folderId = keys.length > 0 ? String(keys[0]) : FOLDER_ALL
        this.setState({folderId, folderDrawerOpen: false}, () => this.tableRef.current?.reload())
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

    titleRender = (node) => {
        return <span>{node.title}</span>
    }

    renderFolderTree = () => (
        <Tree
            blockNode
            selectedKeys={[this.state.folderId]}
            expandedKeys={this.state.expandedKeys}
            onExpand={(expandedKeys) => this.setState({expandedKeys})}
            treeData={this.buildTreeData()}
            titleRender={this.titleRender}
            onSelect={this.handleSelectFolder}
        />
    )

    render() {
        const {folders, folderId, folderEditing, folderManageOpen, isMobile, folderDrawerOpen} = this.state
        const folderOptions = folders.map(f => ({label: f.name, value: f.id}))
        const noteTable = <div className='note-list-panel'>
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
                    <PermActions more={isMobile} visibleCount={1} actions={[
                        {label: '目录', icon: <MenuOutlined/>, type: 'default', onClick: () => this.setState({folderDrawerOpen: true})},
                        {label: '新增笔记', type: 'primary', icon: <PlusOutlined/>, perm: 'note:edit', onClick: this.openAddNote},
                        {label: '目录管理', type: 'default', icon: <SettingOutlined/>, perm: 'note:edit', onClick: () => this.setState({folderManageOpen: true})},
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
                            <PermActions actions={[
                                {label: '编辑', perm: 'note:edit', onClick: () => this.openEditNote(record)},
                                {label: '删除', perm: 'note:edit', onClick: () => this.handleNoteDelete(record)},
                            ]}/>
                        ),
                    },
                ]}
            />
        </div>

        return <Page padding={false}>
            <div className='note-page'>
                    {isMobile ? noteTable : (
                        <Splitter>
                            <Splitter.Panel defaultSize={260} min={200} style={{paddingRight: 8}}>
                                <Card size='small' className='note-directory' title='目录'>
                                    {this.renderFolderTree()}
                                </Card>
                            </Splitter.Panel>
                            <Splitter.Panel min={0} style={{paddingLeft: 8}}>
                                {noteTable}
                            </Splitter.Panel>
                        </Splitter>
                    )}

                    <Drawer title='笔记目录' placement='left' width={Math.min(window.innerWidth * 0.86, 360)}
                            open={folderDrawerOpen} onClose={() => this.setState({folderDrawerOpen: false})}>
                        {this.renderFolderTree()}
                    </Drawer>
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
                       footer={null} width={isMobile ? 'calc(100vw - 24px)' : 520}>
                    <Space style={{marginBottom: 12}}>
                        <Button type='primary' size='small' icon={<FolderAddOutlined/>} perm='note:edit'
                                onClick={() => this.openAddFolder(null)}>新建根目录</Button>
                    </Space>
                    <Tree
                        blockNode
                        defaultExpandAll
                        treeData={this.buildTreeData().filter(n => n.key === 'all' || n.key === 'none' ? false : true)}
                        titleRender={(node) => {
                            if (!node.isFolder) return <span>{node.title}</span>
                            return <Space size={4}>
                                <span>{node.title}</span>
                                <Space size={0} style={{opacity: 0.85}}>
                                    <Button type='text' size='small' perm='note:edit' icon={<EditOutlined/>}
                                            onClick={e => { e.stopPropagation(); this.openEditFolder(node.key) }}/>
                                    <Button type='text' size='small' danger perm='note:edit' icon={<DeleteOutlined/>}
                                            onClick={e => { e.stopPropagation(); this.handleFolderDelete(node.key) }}/>
                                </Space>
                            </Space>
                        }}
                    />
                    <Typography.Text type='secondary' style={{display: 'block', marginTop: 8}}>提示：删除目录后，其中笔记会变为未分类。</Typography.Text>
                </Modal>
            </Page>
    }


}