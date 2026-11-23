import {DeleteOutlined, ReloadOutlined} from '@ant-design/icons'
import {Modal, Switch} from 'antd'
import React from 'react'
import {HttpClient, Page, PermActions, ProTable} from '@jiangood/open-admin'

export const pageMeta = {title: '知识星球管理'}

export default class ZsxqManagePage extends React.Component {
    tableRef = React.createRef()

    /** 启用/禁用切换 */
    handleEnabledChange = (group, checked) => {
        HttpClient.post('admin/zsxq/group/update', {id: group.id, enabled: checked})
            .then(() => this.tableRef.current?.reload?.())
            .catch(() => {})
    }

    /** 删除星球（确认后，后端级联清除话题/评论/专栏/正文图片） */
    handleDelete = (group) => {
        Modal.confirm({
            title: '删除星球',
            content: `确定删除星球「${group.name || group.id}」？删除后该星球的话题、评论与正文图片将被清除，不可恢复。`,
            okButtonProps: {danger: true},
            onOk: async () => {
                await HttpClient.post('admin/zsxq/group/delete', {id: group.id})
                this.tableRef.current?.reload?.()
            },
        })
    }

    render() {
        const columns = [
            {
                title: '星球名称', dataIndex: 'name', key: 'name', width: 170,
                render: (v, g) => <span>{v || ''}{g.owner ? `（${g.owner}）` : ''}</span>,
            },
            {title: '星主', dataIndex: 'owner', key: 'owner', width: 120},
            {title: '成员数', dataIndex: 'memberCount', key: 'memberCount', width: 90},
            {
                title: '启用', dataIndex: 'enabled', key: 'enabled', width: 90,
                render: (v, g) => (
                    <Switch size='small' checked={v !== false} onChange={(c) => this.handleEnabledChange(g, c)}/>
                ),
            },
            {
                title: '操作', dataIndex: 'option', key: 'option', width: 110,
                render: (_, g) => (
                    <PermActions actions={[
                        {label: '删除', icon: <DeleteOutlined/>, perm: 'zsxq:manage', danger: true,
                         onClick: () => this.handleDelete(g)},
                    ]}/>
                ),
            },
        ]

        return (
            <Page>
                <ProTable
                    actionRef={this.tableRef}
                    rowKey='id'
                    request={(params) => HttpClient.get('admin/zsxq/groups', params).then((rs) => {
                        const list = Array.isArray(rs.data) ? rs.data : []
                        return {...rs, data: {content: list, totalElements: list.length, size: list.length}}
                    })}
                    columns={columns}
                    toolBarRightRender={() => (
                        <PermActions actions={[
                            {label: '刷新', type: 'default', icon: <ReloadOutlined/>, perm: 'zsxq:read',
                             onClick: () => this.tableRef.current?.reload?.()},
                        ]}/>
                    )}
                />
            </Page>
        )
    }
}
