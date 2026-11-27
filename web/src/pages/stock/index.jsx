import {
    DeleteOutlined,
    EditOutlined,
    EllipsisOutlined,
    PlusOutlined,
    ReloadOutlined,
    SearchOutlined,
} from '@ant-design/icons'
import {
    AutoComplete,
    Button,
    Col,
    Dropdown,
    Form,
    Input,
    InputNumber,
    Modal,
    Row,
    Select,
    Switch,
    Tag,
} from 'antd'
import React from 'react'
import {FormModal, HttpClient, Page, PermActions, PermUtils, ProTable} from '@jiangood/open-admin'

const CODE_PATTERN = /^(sh|sz|bj)\d{6}$/i

function fmtNum(v, dec = 2) {
    if (v === null || v === undefined || v === '' || Number.isNaN(Number(v))) return null
    return Number(v).toFixed(dec)
}

function marketSession(now = new Date()) {
    const day = now.getDay()
    if (day === 0 || day === 6) return 'holiday'
    const t = now.getHours() * 60 + now.getMinutes()
    if (t < 9 * 60 + 15) return 'closed'
    if (t < 9 * 60 + 30) return 'pre'
    if (t <= 11 * 60 + 30) return 'open'
    if (t < 13 * 60) return 'lunch'
    if (t <= 15 * 60) return 'open'
    return 'closed'
}

function isMarketOpen() {
    return marketSession() === 'open'
}

function refreshIntervalMs() {
    const s = marketSession()
    return (s === 'open' || s === 'pre') ? 3000 : null
}

function getSignalRank(stock, price) {
    const entry = stock.entryPrice
    const heavy = stock.heavyPrice
    if (price == null || entry == null) return null
    if (heavy != null && price <= heavy) return 0
    if (price <= entry) return 1
    if (stock.tp1 && price >= stock.tp1) return 4
    if (stock.tp1 && price >= stock.tp1 * 0.95) return 3
    return 2
}

function diffPct(price, ref) {
    if (price == null || ref == null || ref === 0) return null
    return (price - ref) / ref * 100
}

const SIGNAL_CFG = [
    {label: '买入', cls: 'sig sig-buy-strong'},
    {label: '可买入', cls: 'sig sig-buy'},
    {label: '持有', cls: 'sig sig-hold'},
    {label: '接近止盈', cls: 'sig sig-near-tp'},
    {label: '已到止盈', cls: 'sig sig-tp'},
]

export default class StockPage extends React.Component {
    state = {
        groups: [],
        prices: {}, // code -> {price, prevClose, todayChange, preOpen, time}
        total: 0,
        editing: null,
        clock: new Date(),
        lastUpdate: null,
    }

    tableRef = React.createRef()
    searchFormRef = React.createRef()
    modalRef = React.createRef()
    refreshTimer = null
    clockTimer = null

    componentDidMount() {
        this.loadPrices()
        this.clockTimer = setInterval(() => this.setState({clock: new Date()}), 1000)
        this.scheduleRefresh()
    }

    componentWillUnmount() {
        if (this.refreshTimer) clearTimeout(this.refreshTimer)
        if (this.clockTimer) clearInterval(this.clockTimer)
    }

    reload = () => {
        this.tableRef.current?.reload?.()
    }

    refresh = () => {
        this.reload()
        this.loadPrices()
    }

    priceOf = (stock) => (stock?.code ? this.state.prices[stock.code] : null)

    rowClassOf = (stock) => {
        const price = this.priceOf(stock)?.price
        const hasCode = !!(stock?.code && String(stock.code).trim())
        if (!hasCode || price == null || stock.entryPrice == null) return 'row-na'
        if (stock.heavyPrice != null && price <= stock.heavyPrice) return 'row-buy'
        if (price <= stock.entryPrice) return 'row-below'
        return 'row-above'
    }

    getSortValue = (stock, col) => {
        const price = this.priceOf(stock)?.price
        switch (col) {
            case 'name':
                return stock.name || ''
            case 'price':
                return price
            case 'entryPrice':
                return diffPct(price, stock.entryPrice)
            case 'heavyPrice':
                return diffPct(price, stock.heavyPrice)
            case 'prevChg':
                return stock.prevChg
            case 'tp1':
                return stock.tp1
            case 'tp2':
                return stock.tp2
            case 'yearInit':
                return stock.yearInit
            case 'updDate':
                return stock.updDate || ''
            default:
                return null
        }
    }

    sortBy = (field) => (a, b) => {
        const av = this.getSortValue(a, field)
        const bv = this.getSortValue(b, field)
        if (av == null) return (bv == null) ? 0 : 1
        if (bv == null) return -1
        if (typeof av === 'string' || typeof bv === 'string') {
            return String(av).localeCompare(String(bv), 'zh')
        }
        return Number(av) - Number(bv)
    }

    updateMeta = (stocks, total) => {
        const groups = Array.from(new Set(stocks.map(s => s.groupName).filter(Boolean)))
            .sort((a, b) => a.localeCompare(b, 'zh'))
        this.setState(prev => {
            const sameGroups = prev.groups.length === groups.length
                && prev.groups.every((g, i) => g === groups[i])
            if (sameGroups && prev.total === total) return null
            return {groups: sameGroups ? prev.groups : groups, total}
        })
    }

    request = async (params) => {
        const rs = await HttpClient.get('admin/stock/list')
        const all = Array.isArray(rs?.data) ? rs.data : []

        const keyword = String(params.keyword || '').trim().toLowerCase()
        const groupName = params.groupName
        let list = all
        if (groupName) list = list.filter(s => s.groupName === groupName)
        if (keyword) {
            list = list.filter(s =>
                (s.name || '').toLowerCase().includes(keyword)
                || (s.code || '').toLowerCase().includes(keyword)
            )
        }
        this.updateMeta(all, list.length)

        return {...rs, data: {content: list, totalElements: list.length, size: list.length}}
    }

    loadPrices = async () => {
        try {
            const rs = await HttpClient.get('admin/stock/quote')
            const quotes = rs?.data?.quotes || []
            const prices = {}
            quotes.forEach(q => {
                if (!q || !q.code) return
                prices[q.code] = {
                    price: q.price == null ? null : Number(q.price),
                    prevClose: q.prevClose == null ? null : Number(q.prevClose),
                    todayChange: q.changePct == null ? null : Number(q.changePct),
                    preOpen: q.preOpen === true,
                    time: q.time || '',
                }
            })
            this.setState({prices, lastUpdate: new Date()})
        } catch (e) {
            // 行情失败不打断页面
        }
    }

    scheduleRefresh = () => {
        if (this.refreshTimer) clearTimeout(this.refreshTimer)
        const ms = refreshIntervalMs()
        if (ms == null) return
        this.refreshTimer = setTimeout(async () => {
            await this.loadPrices()
            this.scheduleRefresh()
        }, ms)
    }

    openAdd = () => {
        this.setState({editing: null})
        this.modalRef.current.open({enabled: true})
    }

    openEdit = (record) => {
        this.setState({editing: record})
        this.modalRef.current.open({...record})
    }

    handleSubmit = async (values) => {
        const payload = {...(this.state.editing || {}), ...values}
        if (typeof payload.code === 'string') {
            const c = payload.code.trim().toLowerCase()
            payload.code = c || null
        }
        const url = payload.id ? 'admin/stock/update' : 'admin/stock/create'
        await HttpClient.post(url, payload)
        this.modalRef.current?.close?.()
        this.refresh()
    }

    handleDelete = (record) => {
        Modal.confirm({
            title: '删除自选股',
            content: `确定删除「${record.name || ''}${record.code ? `（${record.code}）` : ''}」？`,
            okButtonProps: {danger: true},
            onOk: async () => {
                await HttpClient.post('admin/stock/delete', {id: record.id}, null)
                this.refresh()
            },
        })
    }

    diffSpan = (pct) => {
        if (pct == null || !Number.isFinite(pct)) return <span className="no-data">—</span>
        const cls = pct > 0 ? 'up' : pct < 0 ? 'down' : 'neutral'
        const sign = pct > 0 ? '+' : ''
        return <span className={`diff-col ${cls}`}>{sign}{pct.toFixed(2)}%</span>
    }

    renderName = (v, record) => {
        const hasCode = !!(record.code && String(record.code).trim())
        const rank = getSignalRank(record, hasCode ? this.priceOf(record)?.price : null)
        return (
            <div className="stock-name-cell">
                <span className="stock-name">{v || <span className="no-data">—</span>}</span>
                {hasCode
                    ? <span className="stock-code">{String(record.code).replace(/^(sh|sz|bj)/i, '')}</span>
                    : <span className="name-pending-tag">待确认</span>}
                {record.groupName ? <Tag className="stock-group-tag">{record.groupName}</Tag> : null}
                {rank != null ? <span className={SIGNAL_CFG[rank].cls}>{SIGNAL_CFG[rank].label}</span> : null}
                {record.enabled === false ? <Tag color="default">停用</Tag> : null}
            </div>
        )
    }

    renderPrice = (_, record) => {
        const pd = this.priceOf(record)
        const price = pd?.price
        const hasCode = !!(record.code && String(record.code).trim())

        if (!hasCode) return <span className="pending-badge">代码待确认</span>
        if (price == null || price === 0) return <span className="loading">加载中...</span>

        const isUp = pd && pd.prevClose != null && price > pd.prevClose
        const isDown = pd && pd.prevClose != null && price < pd.prevClose
        const cls = isUp ? 'up' : isDown ? 'down' : 'neutral'

        let today = <span className="no-data">—</span>
        if (pd && !pd.preOpen && pd.prevClose > 0 && pd.todayChange != null) {
            const chg = pd.todayChange
            const chgCls = chg > 0 ? 'up' : chg < 0 ? 'down' : 'neutral'
            today = <span className={`diff-col ${chgCls}`}>{chg > 0 ? '+' : ''}{chg.toFixed(2)}%</span>
        } else if (pd && pd.preOpen) {
            today = <span className="no-data">未开盘</span>
        }

        return (
            <div className="price-wrap">
                <div className="price-line">
                    <span className={`price-cell ${cls}`}>{Number(price).toFixed(2)}</span>
                    {!isMarketOpen() ? <span className="closing-tag">收盘</span> : null}
                </div>
                <div className="sub-diff">{today}</div>
            </div>
        )
    }

    renderEntry = (_, record) => {
        const val = fmtNum(record.entryPrice)
        if (!val) return <span className="no-data">—</span>
        const price = this.priceOf(record)?.price
        let diff = <span className="no-data">—</span>
        if (record.code && price != null && price > 0 && record.entryPrice) {
            diff = this.diffSpan(diffPct(price, record.entryPrice))
        } else if (record.code && price == null) {
            diff = <span className="loading">…</span>
        }
        return <div>{val}<div className="sub-diff">{diff}</div></div>
    }

    renderHeavy = (_, record) => {
        const val = fmtNum(record.heavyPrice)
        if (!val) return <span className="no-data">—</span>
        const price = this.priceOf(record)?.price
        let diff = <span className="no-data">—</span>
        if (record.code && price != null && price > 0 && record.heavyPrice) {
            diff = this.diffSpan(diffPct(price, record.heavyPrice))
        } else if (record.code && price == null) {
            diff = <span className="loading">…</span>
        }
        return <div>{val}<div className="sub-diff">{diff}</div></div>
    }

    renderPrevChg = (v) => {
        if (v == null) return <span className="no-data">—</span>
        const num = Number(v)
        const cls = num > 0 ? 'up' : num < 0 ? 'down' : 'neutral'
        return <span className={cls}>{num > 0 ? '+' : ''}{num.toFixed(2)}%</span>
    }

    renderTp1 = (_, record) => {
        if (!record.tp1) return <span className="no-data">—</span>
        const price = this.priceOf(record)?.price
        if (record.code && price != null && price > 0) {
            if (price >= record.tp1) return <span className="over-tp1">{Number(record.tp1).toFixed(2)} ✓</span>
            const pct = ((record.tp1 - price) / price * 100).toFixed(1)
            return <span className="tp-col">{Number(record.tp1).toFixed(2)}<span className="tp-space">+{pct}%</span></span>
        }
        return <span className="tp-col">{Number(record.tp1).toFixed(2)}</span>
    }

    renderTp2 = (_, record) => {
        if (!record.tp2) return <span className="no-data">—</span>
        const price = this.priceOf(record)?.price
        if (record.code && price != null && price > 0 && price >= record.tp2) {
            return <span className="over-tp2">{Number(record.tp2).toFixed(2)} ✓</span>
        }
        return <span className="tp-col">{Number(record.tp2).toFixed(2)}</span>
    }

    renderYear = (_, record) => {
        const val = fmtNum(record.yearInit)
        return val ? <span className="neutral">{val}</span> : <span className="no-data">—</span>
    }

    renderDate = (v) => (v
        ? <span className="date-col">{v}</span>
        : <span className="no-data">—</span>)

    renderActions = (_, record) => {
        if (!PermUtils.hasPermission('stock:manage')) return null
        const items = [
            {
                key: 'edit',
                label: '编辑',
                icon: <EditOutlined/>,
                onClick: () => this.openEdit(record),
            },
            {
                key: 'delete',
                label: '删除',
                icon: <DeleteOutlined/>,
                danger: true,
                onClick: () => this.handleDelete(record),
            },
        ]
        return (
            <Dropdown menu={{items}} placement="bottomRight" trigger={['click']}>
                <Button size="small" type="text" icon={<EllipsisOutlined/>} aria-label="更多操作"/>
            </Dropdown>
        )
    }

    render() {
        const {groups, editing, clock, lastUpdate, total} = this.state
        const pad = (n) => String(n).padStart(2, '0')
        const clockText = clock
            ? `${pad(clock.getHours())}:${pad(clock.getMinutes())}:${pad(clock.getSeconds())}`
            : ''
        const updateText = lastUpdate
            ? `${pad(lastUpdate.getHours())}:${pad(lastUpdate.getMinutes())}:${pad(lastUpdate.getSeconds())}`
            : '—'
        const priceHeader = isMarketOpen() ? '实时价格' : '收盘价'
        const rowCell = (record) => ({className: this.rowClassOf(record)})

        const columns = [
            {
                title: '名称', dataIndex: 'name', width: 280, sorter: this.sortBy('name'),
                onCell: (record) => ({className: `${this.rowClassOf(record)} col-name`}),
                render: this.renderName,
            },
            {
                title: priceHeader, dataIndex: 'price', width: 130, align: 'right', sorter: this.sortBy('price'),
                onCell: rowCell, render: this.renderPrice,
            },
            {
                title: '入场', dataIndex: 'entryPrice', width: 120, align: 'right', sorter: this.sortBy('entryPrice'),
                onCell: rowCell, render: this.renderEntry,
            },
            {
                title: '重仓', dataIndex: 'heavyPrice', width: 120, align: 'right', sorter: this.sortBy('heavyPrice'),
                onCell: rowCell, render: this.renderHeavy,
            },
            {
                title: '昨日', dataIndex: 'prevChg', width: 100, align: 'right', sorter: this.sortBy('prevChg'),
                onCell: rowCell, render: this.renderPrevChg,
            },
            {
                title: '止盈 1', dataIndex: 'tp1', width: 130, align: 'right', sorter: this.sortBy('tp1'),
                onCell: rowCell, render: this.renderTp1,
            },
            {
                title: '止盈 2', dataIndex: 'tp2', width: 120, align: 'right', sorter: this.sortBy('tp2'),
                onCell: rowCell, render: this.renderTp2,
            },
            {
                title: '年初价', dataIndex: 'yearInit', width: 100, align: 'right', sorter: this.sortBy('yearInit'),
                onCell: rowCell, render: this.renderYear,
            },
            {
                title: '更新', dataIndex: 'updDate', width: 110, sorter: this.sortBy('updDate'),
                onCell: rowCell, render: this.renderDate,
            },
            {
                title: '操作', dataIndex: 'option', width: 70, align: 'center', fixed: 'right',
                onCell: rowCell, render: this.renderActions,
            },
        ]

        return (
            <Page>
                <div className="jt-stock-monitor">
                    <style>{monitorCss}</style>
                    <ProTable
                        actionRef={this.tableRef}
                        formRef={this.searchFormRef}
                        rowKey="id"
                        treeMode
                        scrollX={1280}
                        searchInline
                        searchFormRender={() => (
                            <>
                                <Form.Item name="keyword" noStyle>
                                    <Input prefix={<SearchOutlined/>} allowClear
                                           placeholder="搜索名称 / 代码..." style={{width: 220}}/>
                                </Form.Item>
                                <Form.Item name="groupName" noStyle>
                                    <Select allowClear placeholder="全部分组" style={{width: 140}}
                                            options={groups.map(g => ({label: g, value: g}))}
                                            onChange={(value) => {
                                                if (value) this.searchFormRef.current?.submit()
                                            }}/>
                                </Form.Item>
                            </>
                        )}
                        toolBarRender={() => (
                            <div className="sm-meta-group">
                                <span className="sm-count"><b>{total}</b>支</span>
                                <span className="sm-meta">时间 <b>{clockText}</b></span>
                                <span className="sm-meta">行情 <b>{updateText}</b></span>
                                <span className="sm-legend">
                                    <span className="dot" style={{background: '#dc2626'}}/>高于入场
                                    <span className="dot" style={{background: '#16a34a', marginLeft: 8}}/>低于入场
                                    <span className="dot" style={{background: '#15803d', marginLeft: 8}}/>重仓区
                                </span>
                            </div>
                        )}
                        toolBarRightRender={() => (
                            <PermActions actions={[
                                {label: '刷新', icon: <ReloadOutlined/>, perm: 'stock:read', onClick: this.refresh},
                                {label: '添加', type: 'primary', icon: <PlusOutlined/>, perm: 'stock:manage', onClick: this.openAdd},
                            ]}/>
                        )}
                        request={this.request}
                        columns={columns}
                    />
                    <div className="sm-footer">
                        交易时段自动刷新（09:15–11:30 / 13:00–15:00），非交易时段显示收盘价。
                        <br/>
                        <span style={{fontSize: 11, color: '#94a3b8'}}>
                            免责声明：本页面仅供个人持仓记录参考，不构成任何投资建议。股市有风险，投资需谨慎。
                        </span>
                    </div>
                </div>

                <FormModal ref={this.modalRef} title={editing ? '编辑自选股' : '添加自选股'}
                           onFinish={this.handleSubmit} width={560} labelCol={{flex: '90px'}}>
                    <Form.Item label="代码" name="code"
                               rules={[{pattern: CODE_PATTERN, message: '格式如 sh600000 / sz000001 / bj430047（可留空表示待确认）'}]}>
                        <Input placeholder="sh600000（可留空=待确认）" disabled={!!(editing && editing.id && editing.code)}/>
                    </Form.Item>
                    <Form.Item label="名称" name="name" rules={[{required: true, message: '请输入名称'}]}>
                        <Input placeholder="股票名称"/>
                    </Form.Item>
                    <Form.Item label="分组" name="groupName">
                        <AutoComplete allowClear placeholder="如：银行 / 持仓"
                                      options={groups.map(g => ({value: g}))}
                                      filterOption={(input, option) => (option?.value || '').toLowerCase().includes((input || '').toLowerCase())}/>
                    </Form.Item>
                    <Row gutter={12}>
                        <Col span={12}>
                            <Form.Item label="入场价" name="entryPrice">
                                <InputNumber style={{width: '100%'}} min={0} step={0.01} placeholder="entry"/>
                            </Form.Item>
                        </Col>
                        <Col span={12}>
                            <Form.Item label="重仓价" name="heavyPrice"
                                       dependencies={['entryPrice']}
                                       rules={[({getFieldValue}) => ({
                                           validator(_, value) {
                                               const entry = getFieldValue('entryPrice')
                                               if (value != null && entry != null && Number(value) >= Number(entry)) {
                                                   return Promise.reject(new Error('重仓价应低于入场价'))
                                               }
                                               return Promise.resolve()
                                           },
                                       })]}>
                                <InputNumber style={{width: '100%'}} min={0} step={0.01} placeholder="heavy"/>
                            </Form.Item>
                        </Col>
                    </Row>
                    <Row gutter={12}>
                        <Col span={12}>
                            <Form.Item label="止盈 1" name="tp1">
                                <InputNumber style={{width: '100%'}} min={0} step={0.01}/>
                            </Form.Item>
                        </Col>
                        <Col span={12}>
                            <Form.Item label="止盈 2" name="tp2">
                                <InputNumber style={{width: '100%'}} min={0} step={0.01}/>
                            </Form.Item>
                        </Col>
                    </Row>
                    <Row gutter={12}>
                        <Col span={12}>
                            <Form.Item label="年初价" name="yearInit">
                                <InputNumber style={{width: '100%'}} min={0} step={0.01}/>
                            </Form.Item>
                        </Col>
                        <Col span={12}>
                            <Form.Item label="昨日涨跌" name="prevChg" tooltip="昨日涨跌幅(%)，如 1.23 或 -0.5">
                                <InputNumber style={{width: '100%'}} step={0.01} placeholder="%"/>
                            </Form.Item>
                        </Col>
                    </Row>
                    <Row gutter={12}>
                        <Col span={12}>
                            <Form.Item label="更新日期" name="updDate">
                                <Input placeholder="YYYY-MM-DD"/>
                            </Form.Item>
                        </Col>
                        <Col span={12}>
                            <Form.Item label="启用" name="enabled" valuePropName="checked" initialValue={true}>
                                <Switch/>
                            </Form.Item>
                        </Col>
                    </Row>
                </FormModal>
            </Page>
        )
    }
}

const monitorCss = `
.jt-stock-monitor .ant-table-thead > tr > th{background:#f8fafc;color:#64748b;font-size:11px;font-weight:600;letter-spacing:.4px;white-space:nowrap;border-bottom:1px solid #d1d9e0}
.jt-stock-monitor .ant-table-tbody > tr > td{height:52px;padding:8px 12px;white-space:nowrap;font-variant-numeric:tabular-nums;border-bottom:1px solid #e8ecf1}
.jt-stock-monitor .ant-table-tbody > tr > td.row-below{background:rgba(22,163,74,.04)}
.jt-stock-monitor .ant-table-tbody > tr > td.row-buy{background:rgba(22,163,74,.09)}
.jt-stock-monitor .ant-table-tbody > tr:hover > td{background:#f1f5f9!important}
.jt-stock-monitor .ant-table-tbody > tr > td.col-name.row-above{box-shadow:inset 3px 0 0 #dc2626}
.jt-stock-monitor .ant-table-tbody > tr > td.col-name.row-below{box-shadow:inset 3px 0 0 #16a34a}
.jt-stock-monitor .ant-table-tbody > tr > td.col-name.row-buy{box-shadow:inset 3px 0 0 #15803d}
.jt-stock-monitor .stock-name-cell{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.jt-stock-monitor .stock-name{font-size:13px;font-weight:500;color:#0f172a}
.jt-stock-monitor .stock-code{font-size:11px;color:#94a3b8;font-variant-numeric:tabular-nums}
.jt-stock-monitor .stock-group-tag{margin-inline-end:0}
.jt-stock-monitor .price-wrap{display:flex;flex-direction:column;align-items:flex-end;gap:2px}
.jt-stock-monitor .price-line{display:flex;align-items:center;gap:4px}
.jt-stock-monitor .price-cell{font-size:15px;font-weight:700;line-height:1;letter-spacing:-.3px}
.jt-stock-monitor .closing-tag{font-size:9px;font-weight:600;letter-spacing:.6px;text-transform:uppercase;color:#94a3b8;background:#f8fafc;border:1px solid #d1d9e0;border-radius:3px;padding:1px 5px}
.jt-stock-monitor .up{color:#dc2626}
.jt-stock-monitor .down{color:#16a34a}
.jt-stock-monitor .neutral{color:#64748b}
.jt-stock-monitor .sub-diff{font-size:11px;opacity:.9;margin-top:1px}
.jt-stock-monitor .diff-col{font-size:12px;font-weight:500}
.jt-stock-monitor .tp-col{color:#64748b;font-size:12px}
.jt-stock-monitor .tp-space{margin-left:4px;font-size:10px;color:#16a34a;font-weight:500}
.jt-stock-monitor .over-tp1{color:#c2410c!important;font-weight:700}
.jt-stock-monitor .over-tp2{color:#9333ea!important;font-weight:700}
.jt-stock-monitor .date-col{font-size:11px;color:#94a3b8}
.jt-stock-monitor .loading{color:#94a3b8!important;font-size:12px}
.jt-stock-monitor .no-data{color:#94a3b8}
.jt-stock-monitor .pending-badge{display:inline-flex;align-items:center;gap:5px;padding:3px 9px;border-radius:5px;font-size:11px;color:#92400e;background:#fef3c7;border:1px solid #fde68a}
.jt-stock-monitor .name-pending-tag{display:inline-flex;align-items:center;padding:1px 5px;border-radius:3px;font-size:10px;font-weight:500;color:#92400e;background:#fef3c7;border:1px solid #fde68a}
.jt-stock-monitor .sig{display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;white-space:nowrap}
.jt-stock-monitor .sig-buy{background:rgba(22,163,74,.12);color:#16a34a}
.jt-stock-monitor .sig-buy-strong{background:rgba(22,163,74,.22);color:#15803d}
.jt-stock-monitor .sig-hold{background:rgba(100,116,139,.1);color:#64748b}
.jt-stock-monitor .sig-near-tp{background:rgba(245,158,11,.12);color:#d97706}
.jt-stock-monitor .sig-tp{background:rgba(168,85,247,.12);color:#9333ea}
.jt-stock-monitor .sm-meta-group{display:flex;align-items:center;gap:12px;flex-wrap:wrap;font-size:12px;color:#64748b}
.jt-stock-monitor .sm-count{display:flex;align-items:center;gap:4px}
.jt-stock-monitor .sm-count b{font-size:14px;color:#0f172a}
.jt-stock-monitor .sm-meta{display:flex;align-items:center;gap:4px}
.jt-stock-monitor .sm-meta b{color:#0f172a;font-variant-numeric:tabular-nums;font-weight:500}
.jt-stock-monitor .sm-legend{display:flex;align-items:center;gap:4px;font-size:11px;color:#94a3b8}
.jt-stock-monitor .sm-legend .dot{width:6px;height:6px;border-radius:50%;display:inline-block;margin-right:4px}
.jt-stock-monitor .sm-footer{padding:12px 8px 0;text-align:center;font-size:12px;color:#64748b}
@media (max-width: 768px){
  .jt-stock-monitor .ant-table-tbody > tr > td{height:46px;padding:6px 8px}
}
`
