import React from 'react'
import {ReadOutlined, ReloadOutlined, RightOutlined, SearchOutlined, TeamOutlined} from '@ant-design/icons'
import {Button, Empty, Input, Spin, Tooltip} from 'antd'
import {HttpClient, Page, history} from '@jiangood/open-admin'
import './columns.css'

export const pageMeta = {title: '知识星球专栏'}

/** 知识星球专栏：简洁列表，按名称/简介搜索，点击进入专栏信息流 */
export default class ZsxqColumnsPage extends React.Component {
    state = {
        loading: true,
        columns: [],
        groups: [],
        keyword: '',
    }

    componentDidMount() {
        this.load()
    }

    load = async () => {
        this.setState({loading: true})
        try {
            const [columnsRs, groupsRs] = await Promise.all([
                HttpClient.get('admin/zsxq/columns'),
                HttpClient.get('admin/zsxq/groups'),
            ])
            this.setState({
                columns: Array.isArray(columnsRs.data) ? columnsRs.data : [],
                groups: Array.isArray(groupsRs.data) ? groupsRs.data : [],
            })
        } catch (_) {
            /* HttpClient 已提示错误 */
        } finally {
            this.setState({loading: false})
        }
    }

    groupName = (groupId) => {
        if (!groupId) return ''
        return this.state.groups.find(g => String(g.id) === String(groupId))?.name || ''
    }

    filteredColumns = () => {
        const {columns, keyword} = this.state
        const kw = keyword.trim().toLowerCase()
        if (!kw) return columns
        return columns.filter(c => [c.name, c.description].filter(Boolean).join(' ').toLowerCase().includes(kw))
    }

    openColumn = (column) => {
        if (!column?.columnId) return
        history.push(`/zsxq/column/${encodeURIComponent(column.columnId)}`)
    }

    renderRow(column) {
        const groupName = this.groupName(column.groupId)
        return <button type='button' key={column.id || column.columnId} className='zsxq-column-row'
                       onClick={() => this.openColumn(column)}>
            <span className='zsxq-column-row-icon'><ReadOutlined/></span>
            <span className='zsxq-column-row-main'>
                <span className='zsxq-column-row-name'>{column.name || column.columnId || '未命名专栏'}</span>
                {column.description ? <span className='zsxq-column-row-desc'>{column.description}</span> : null}
            </span>
            <span className='zsxq-column-row-side'>
                {groupName ? <span className='zsxq-column-row-group'><TeamOutlined/> {groupName}</span> : null}
                <span className='zsxq-column-row-count'>{Number(column.topicsCount) || 0} 篇</span>
                <RightOutlined className='zsxq-column-row-arrow'/>
            </span>
        </button>
    }

    renderList() {
        const {loading, columns, keyword} = this.state
        if (loading && !columns.length) {
            return <div className='zsxq-column-empty'><Spin/></div>
        }

        const list = this.filteredColumns()
        if (!list.length) {
            return <div className='zsxq-column-empty'>
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE}
                       description={keyword.trim() ? '没有符合条件的专栏' : '暂无专栏，等待专栏同步任务执行'}/>
            </div>
        }

        return <div className={`zsxq-column-list${loading ? ' is-loading' : ''}`} aria-busy={loading}>
            {list.map(column => this.renderRow(column))}
        </div>
    }

    render() {
        const {loading, columns, keyword} = this.state
        const filtered = this.filteredColumns().length

        return <Page>
            <div className='zsxq-columns-page'>
                <header className='zsxq-columns-head'>
                    <div className='zsxq-columns-heading'>
                        <h1>知识星球专栏</h1>
                        <p>共 {columns.length} 个专栏{keyword.trim() ? ` · 当前筛选 ${filtered} 个` : ''}</p>
                    </div>
                    <div className='zsxq-columns-filters'>
                        <Input
                            className='zsxq-columns-search'
                            allowClear
                            prefix={<SearchOutlined/>}
                            placeholder='搜索专栏名称 / 简介'
                            value={keyword}
                            onChange={e => this.setState({keyword: e.target.value})}
                        />
                        <Tooltip title='刷新专栏'>
                            <Button icon={<ReloadOutlined/>} loading={loading} onClick={this.load} aria-label='刷新专栏'/>
                        </Tooltip>
                    </div>
                </header>
                {this.renderList()}
            </div>
        </Page>
    }
}
