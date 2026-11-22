import React from 'react'
import {ReadOutlined, ReloadOutlined, SearchOutlined, TeamOutlined} from '@ant-design/icons'
import {Button, Empty, Input, Select, Tooltip} from 'antd'
import {HttpClient, Page, history} from '@jiangood/open-admin'
import {imageSrc} from './media'
import './columns.css'

export const pageMeta = {title: '知识星球专栏'}

/** 专栏封面：对象存储 key 走站内代理，源站 URL 经代理落对象存储；失败时退回占位图标 */
function ColumnCover({column}) {
    const src = imageSrc(column?.coverUrl)
    if (!src) {
        return <div className='zsxq-column-cover zsxq-column-cover-empty'><ReadOutlined/></div>
    }
    return <div className='zsxq-column-cover'>
        <div className='zsxq-column-cover-empty'><ReadOutlined/></div>
        <img src={src} alt='' loading='lazy' decoding='async'
             onError={(e) => { e.currentTarget.style.display = 'none' }}/>
    </div>
}

/** 知识星球专栏：按星球筛选、按名称/简介搜索，点击进入专栏阅读页 */
export default class ZsxqColumnsPage extends React.Component {
    state = {
        loading: true,
        columns: [],
        groups: [],
        stats: {},
        keyword: '',
        groupId: null,
    }

    componentDidMount() {
        this.load()
    }

    load = async () => {
        this.setState({loading: true})
        try {
            const [columnsRs, groupsRs, statsRs] = await Promise.all([
                HttpClient.get('admin/zsxq/columns'),
                HttpClient.get('admin/zsxq/groups'),
                HttpClient.get('admin/zsxq/stats'),
            ])
            this.setState({
                columns: Array.isArray(columnsRs.data) ? columnsRs.data : [],
                groups: Array.isArray(groupsRs.data) ? groupsRs.data : [],
                stats: statsRs.data || {},
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
        const {columns, keyword, groupId} = this.state
        const kw = keyword.trim().toLowerCase()
        return columns.filter(c => {
            if (groupId && String(c.groupId) !== String(groupId)) return false
            if (!kw) return true
            return [c.name, c.description].filter(Boolean).join(' ').toLowerCase().includes(kw)
        })
    }

    openColumn = (column) => {
        if (!column?.columnId) return
        history.push(`/zsxq/column/${encodeURIComponent(column.columnId)}`)
    }

    renderCard(column) {
        const groupName = this.groupName(column.groupId)
        const showGroup = this.state.groups.length > 1
        return <article key={column.id || column.columnId} className='zsxq-column-card'
                        onClick={() => this.openColumn(column)} title={column.name || '专栏'}>
            <ColumnCover column={column}/>
            <div className='zsxq-column-info'>
                <div className='zsxq-column-name'>{column.name || column.columnId || '未命名专栏'}</div>
                <div className='zsxq-column-desc'>{column.description || <span className='zsxq-column-muted'>暂无简介</span>}</div>
                <div className='zsxq-column-meta'>
                    {showGroup ? <span className='zsxq-column-group'><TeamOutlined/> {groupName || '未知星球'}</span> : <span/>}
                    <span className='zsxq-column-count'>{Number(column.topicsCount) || 0} 篇</span>
                </div>
            </div>
        </article>
    }

    renderGrid() {
        const {loading, columns} = this.state
        if (loading && !columns.length) {
            return <div className='zsxq-column-grid' aria-busy='true'>
                {Array.from({length: 8}).map((_, i) => <div className='zsxq-column-skeleton' key={i}>
                    <div className='zsxq-column-skeleton-cover'/>
                    <div className='zsxq-column-skeleton-line' style={{width: '76%'}}/>
                    <div className='zsxq-column-skeleton-line' style={{width: '48%'}}/>
                </div>)}
            </div>
        }

        const list = this.filteredColumns()
        if (!list.length) {
            const filtered = !!this.state.keyword.trim() || !!this.state.groupId
            return <div className='zsxq-column-empty'>
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE}
                       description={filtered ? '没有符合条件的专栏' : '暂无专栏，等待专栏同步任务执行'}/>
            </div>
        }

        return <div className={`zsxq-column-grid${loading ? ' is-loading' : ''}`} aria-busy={loading}>
            {list.map(column => this.renderCard(column))}
        </div>
    }

    render() {
        const {loading, columns, groups, stats, keyword, groupId} = this.state
        const total = stats.columns ?? columns.length
        const groupOptions = groups.map(g => ({label: g.name || g.id, value: g.id}))

        return <Page>
            <div className='zsxq-columns-page'>
                <header className='zsxq-columns-head'>
                    <div className='zsxq-columns-heading'>
                        <h1>知识星球专栏</h1>
                        <p>共 {total} 个专栏{groupId ? ` · 当前筛选 ${this.filteredColumns().length} 个` : ''}</p>
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
                        {groups.length > 1 ? <Select
                            className='zsxq-columns-group'
                            allowClear
                            showSearch
                            optionFilterProp='label'
                            placeholder='全部星球'
                            value={groupId}
                            options={groupOptions}
                            onChange={v => this.setState({groupId: v ?? null})}
                        /> : null}
                        <Tooltip title='刷新专栏'>
                            <Button icon={<ReloadOutlined/>} loading={loading} onClick={this.load} aria-label='刷新专栏'/>
                        </Tooltip>
                    </div>
                </header>
                {this.renderGrid()}
            </div>
        </Page>
    }
}
