import {DeleteOutlined, EditOutlined, PlusOutlined, ReloadOutlined, SearchOutlined} from '@ant-design/icons'
import {AutoComplete, Button, Col, Form, Input, InputNumber, Modal, Row, Select, Switch, Tag, message} from 'antd'
import React from 'react'
import {FormModal, HttpClient, Page, PermActions} from '@jiangood/open-admin'

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

const SIGNAL_CFG = [
    {label: '买入', cls: 'sig sig-buy-strong'},
    {label: '可买入', cls: 'sig sig-buy'},
    {label: '持有', cls: 'sig sig-hold'},
    {label: '接近止盈', cls: 'sig sig-near-tp'},
    {label: '已到止盈', cls: 'sig sig-tp'},
]

const SORT_COLS = ['name', 'price', 'entry', 'heavy', 'today', 'prevChg', 'tp1', 'tp2', 'yearInit', 'updDate']

export default class StockPage extends React.Component {
    state = {
        stocks: [],
        filtered: [],
        prices: {}, // code -> {price, prevClose, todayChange, preOpen, time}
        groups: [],
        groupFilter: '',
        search: '',
        loading: true,
        sortCol: null,
        sortDir: 1,
        editing: null,
        clock: new Date(),
        lastUpdate: null,
    }

    modalRef = React.createRef()
    refreshTimer = null
    clockTimer = null

    componentDidMount() {
        this.loadStocks()
        this.clockTimer = setInterval(() => this.setState({clock: new Date()}), 1000)
        this.scheduleRefresh()
    }

    componentWillUnmount() {
        if (this.refreshTimer) clearTimeout(this.refreshTimer)
        if (this.clockTimer) clearInterval(this.clockTimer)
    }

    loadStocks = async () => {
        this.setState({loading: true})
        try {
            const rs = await HttpClient.get('admin/stock/list')
            const stocks = Array.isArray(rs?.data) ? rs.data : []
            const groups = Array.from(new Set(stocks.map(s => s.groupName).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'zh'))
            this.setState({stocks, groups, loading: false}, () => {
                this.applyFilter()
                this.loadPrices()
            })
        } catch (e) {
            this.setState({loading: false})
            message.error('加载股票列表失败')
        }
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

    applyFilter = () => {
        const {stocks, search, groupFilter} = this.state
        const q = (search || '').trim().toLowerCase()
        let list = stocks
        if (groupFilter) list = list.filter(s => s.groupName === groupFilter)
        if (q) {
            list = list.filter(s =>
                (s.name || '').toLowerCase().includes(q) ||
                (s.code || '').toLowerCase().includes(q)
            )
        }
        this.setState({filtered: list})
    }

    onSearch = (e) => {
        this.setState({search: e.target.value}, this.applyFilter)
    }

    onGroupChange = (v) => {
        this.setState({groupFilter: v || ''}, this.applyFilter)
    }

    getSortValue = (stock, col) => {
        const pd = stock.code ? this.state.prices[stock.code] : null
        const price = pd && !pd.preOpen ? pd.price : (pd ? pd.price : null)
        const livePrice = pd ? pd.price : null
        switch (col) {
            case 'name': return stock.name || ''
            case 'price': return livePrice
            case 'today': return (pd && pd.prevClose > 0 && pd.todayChange != null) ? pd.todayChange : null
            case 'prevChg': return stock.prevChg
            case 'yearInit': return stock.yearInit
            case 'entry': return (livePrice != null && stock.entryPrice != null && stock.entryPrice !== 0)
                ? (livePrice - stock.entryPrice) / stock.entryPrice : null
            case 'heavy': return (livePrice != null && stock.heavyPrice != null && stock.heavyPrice !== 0)
                ? (livePrice - stock.heavyPrice) / stock.heavyPrice : null
            case 'tp1': return stock.tp1
            case 'tp2': return stock.tp2
            case 'updDate': return stock.updDate || ''
            default: return null
        }
    }

    sortedView = () => {
        const {filtered, sortCol, sortDir} = this.state
        if (!sortCol) return filtered
        return [...filtered].sort((a, b) => {
            const av = this.getSortValue(a, sortCol)
            const bv = this.getSortValue(b, sortCol)
            if (av === null || av === undefined) return (bv === null || bv === undefined) ? 0 : 1
            if (bv === null || bv === undefined) return -1
            if (typeof av === 'string' || typeof bv === 'string') {
                return String(av).localeCompare(String(bv), 'zh') * sortDir
            }
            return (Number(av) - Number(bv)) * sortDir
        })
    }

    sortTable = (col) => {
        this.setState(prev => {
            if (prev.sortCol === col) {
                if (prev.sortDir === 1) return {sortDir: -1}
                if (prev.sortDir === -1) return {sortCol: null, sortDir: 1}
            }
            return {sortCol: col, sortDir: 1}
        })
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
        this.loadStocks()
    }

    handleDelete = (record) => {
        Modal.confirm({
            title: '删除自选股',
            content: `确定删除「${record.name || ''}${record.code ? `（${record.code}）` : ''}」？`,
            okButtonProps: {danger: true},
            onOk: async () => {
                await HttpClient.post('admin/stock/delete', {id: record.id}, null)
                this.loadStocks()
            },
        })
    }

    renderSortTh = (key, label, alignRight = true) => {
        const {sortCol, sortDir} = this.state
        const cls = sortCol === key ? (sortDir === 1 ? 'sort-asc' : 'sort-desc') : ''
        return (
            <th key={key} className={cls} onClick={() => this.sortTable(key)}
                style={{textAlign: alignRight ? 'right' : 'left', cursor: 'pointer'}}>
                {label}<span className="sort-icon"/>
            </th>
        )
    }

    renderRow = (stock) => {
        const pd = stock.code ? this.state.prices[stock.code] : null
        const price = pd ? pd.price : null
        const hasCode = !!(stock.code && String(stock.code).trim())

        let rowClass = 'row-na'
        if (hasCode && price != null && stock.entryPrice != null) {
            if (stock.heavyPrice != null && price <= stock.heavyPrice) rowClass = 'row-buy'
            else if (price <= stock.entryPrice) rowClass = 'row-below'
            else rowClass = 'row-above'
        }

        const entryVal = fmtNum(stock.entryPrice)
        const heavyVal = fmtNum(stock.heavyPrice)
        const yearVal = fmtNum(stock.yearInit)
        const tp1Val = fmtNum(stock.tp1)
        const tp2Val = fmtNum(stock.tp2)

        // price cell
        let priceHtml
        if (!hasCode) {
            priceHtml = <span className="pending-badge">代码待确认</span>
        } else if (price == null || price === 0) {
            priceHtml = <span className="loading">加载中...</span>
        } else {
            const isUp = pd && pd.prevClose != null && price > pd.prevClose
            const isDown = pd && pd.prevClose != null && price < pd.prevClose
            const cls = isUp ? 'up' : isDown ? 'down' : 'neutral'
            priceHtml = (
                <span className="price-wrap">
                    <span className={`price-cell ${cls}`}>{Number(price).toFixed(2)}</span>
                    {!isMarketOpen() ? <span className="closing-tag">收盘</span> : null}
                </span>
            )
        }

        // today change (for combined cell, use diff style like entry/heavy sub-diff)
        let todaySubHtml = <span className="no-data">—</span>
        if (hasCode && pd && !pd.preOpen && pd.prevClose > 0 && pd.todayChange != null) {
            const chg = pd.todayChange
            const cls = chg > 0 ? 'up' : chg < 0 ? 'down' : 'neutral'
            const sign = chg > 0 ? '+' : ''
            todaySubHtml = <span className={`diff-col ${cls}`}>{sign}{chg.toFixed(2)}%</span>
        } else if (hasCode && pd && pd.preOpen) {
            todaySubHtml = <span className="no-data">未开盘</span>
        }

        // diffs
        const diffSpan = (pct) => {
            if (pct == null || !Number.isFinite(pct)) return <span className="no-data">—</span>
            const cls = pct > 0 ? 'up' : pct < 0 ? 'down' : 'neutral'
            const sign = pct > 0 ? '+' : ''
            return <span className={`diff-col ${cls}`}>{sign}{pct.toFixed(2)}%</span>
        }
        let entryDiff = <span className="no-data">—</span>
        let heavyDiff = <span className="no-data">—</span>
        if (hasCode && price != null && price > 0) {
            if (stock.entryPrice != null && stock.entryPrice !== 0) {
                entryDiff = diffSpan((price - stock.entryPrice) / stock.entryPrice * 100)
            }
            if (stock.heavyPrice != null && stock.heavyPrice !== 0) {
                heavyDiff = diffSpan((price - stock.heavyPrice) / stock.heavyPrice * 100)
            }
        } else if (!hasCode) {
            entryDiff = <span className="no-data">—</span>
            heavyDiff = <span className="no-data">—</span>
        } else {
            entryDiff = <span className="loading">…</span>
            heavyDiff = <span className="loading">…</span>
        }

        // TP1 / TP2
        let tp1Html = tp1Val ? <span className="tp-col">{tp1Val}</span> : <span className="no-data">—</span>
        if (hasCode && price != null && stock.tp1) {
            if (price >= stock.tp1) {
                tp1Html = <span className="over-tp1">{Number(stock.tp1).toFixed(2)} ✓</span>
            } else if (price > 0) {
                const pct = ((stock.tp1 - price) / price * 100).toFixed(1)
                tp1Html = <span className="tp-col">{Number(stock.tp1).toFixed(2)}<span className="tp-space">+{pct}%</span></span>
            }
        }
        let tp2Html = tp2Val ? <span className="tp-col">{tp2Val}</span> : <span className="no-data">—</span>
        if (hasCode && price != null && stock.tp2 && price >= stock.tp2) {
            tp2Html = <span className="over-tp2">{Number(stock.tp2).toFixed(2)} ✓</span>
        }

        // prevChg
        let prevChgHtml = <span className="no-data">—</span>
        if (stock.prevChg != null) {
            const v = Number(stock.prevChg)
            const cls = v > 0 ? 'up' : v < 0 ? 'down' : 'neutral'
            const sign = v > 0 ? '+' : ''
            prevChgHtml = <span className={cls}>{sign}{v.toFixed(2)}%</span>
        }

        // signal
        const rank = getSignalRank(stock, hasCode ? price : null)
        const signalHtml = rank != null ? <span className={SIGNAL_CFG[rank].cls}>{SIGNAL_CFG[rank].label}</span> : null

        const codeShort = hasCode ? String(stock.code).replace(/^(sh|sz|bj)/i, '') : ''

        return (
            <tr key={stock.id || stock.code || stock.name} className={rowClass}>
                <td className="col-name">
                    <div style={{display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap'}}>
                        <span>{stock.name || <span className="no-data">—</span>}</span>
                        {hasCode ? <span className="stock-code">{codeShort}</span> : <span className="name-pending-tag">待确认</span>}
                        {stock.groupName ? <Tag style={{marginInlineEnd: 0}}>{stock.groupName}</Tag> : null}
                        {signalHtml}
                        {stock.enabled === false ? <Tag color="default">停用</Tag> : null}
                    </div>
                </td>
                <td className="col-num price-today-col">
                    <div>
                        {priceHtml}
                        <div className="sub-diff">{todaySubHtml}</div>
                    </div>
                </td>
                <td className="col-num entry-col">
                    {entryVal ? <div>{entryVal}<div className="sub-diff">{entryDiff}</div></div> : <span className="no-data">—</span>}
                </td>
                <td className="col-num heavy-col">
                    {heavyVal ? <div>{heavyVal}<div className="sub-diff">{heavyDiff}</div></div> : <span className="no-data">—</span>}
                </td>
                <td>{prevChgHtml}</td>
                <td>{tp1Html}</td>
                <td>{tp2Html}</td>
                <td className="col-num neutral">{yearVal || <span className="no-data">—</span>}</td>
                <td className="date-col">{stock.updDate || <span className="no-data">—</span>}</td>
                <td className="actions-col">
                    <PermActions actions={[
                        {label: '编辑', icon: <EditOutlined/>, perm: 'stock:manage', onClick: () => this.openEdit(stock)},
                        {label: '删除', icon: <DeleteOutlined/>, perm: 'stock:manage', danger: true, onClick: () => this.handleDelete(stock)},
                    ]}/>
                </td>
            </tr>
        )
    }

    render() {
        const {groups, groupFilter, search, editing, clock, lastUpdate} = this.state
        const view = this.sortedView()
        const clockText = clock ? `${String(clock.getHours()).padStart(2,'0')}:${String(clock.getMinutes()).padStart(2,'0')}:${String(clock.getSeconds()).padStart(2,'0')}` : ''
        const updateText = lastUpdate ? `${String(lastUpdate.getHours()).padStart(2,'0')}:${String(lastUpdate.getMinutes()).padStart(2,'0')}:${String(lastUpdate.getSeconds()).padStart(2,'0')}` : '—'
        const priceHeader = isMarketOpen() ? '实时价格' : '收盘价'

        return (
            <Page>
                <div className="jt-stock-monitor">
                    <style>{monitorCss}</style>
                    <div className="sm-toolbar">
                        <div className="sm-left">
                            <div className="sm-search">
                                <SearchOutlined className="sm-search-icon"/>
                                <Input allowClear value={search} onChange={this.onSearch}
                                       placeholder="搜索名称 / 代码..." className="sm-search-input"/>
                            </div>
                            <Select allowClear placeholder="全部分组" value={groupFilter || undefined}
                                    onChange={this.onGroupChange} style={{minWidth: 140}}
                                    options={groups.map(g => ({label: g, value: g}))}/>
                            <div className="sm-count"><b>{view.length}</b><span>支</span></div>
                            <div className="sm-meta">时间 <b>{clockText}</b></div>
                            <div className="sm-meta">行情 <b>{updateText}</b></div>
                        </div>
                        <div className="sm-right">
                            <div className="sm-legend">
                                <span className="dot" style={{background:'#dc2626'}}/>高于入场
                                <span className="dot" style={{background:'#16a34a', marginLeft: 8}}/>低于入场
                                <span className="dot" style={{background:'#15803d', marginLeft: 8}}/>重仓区
                            </div>
                            <Button icon={<ReloadOutlined/>} onClick={() => { this.loadStocks(); this.loadPrices() }}>刷新</Button>
                            <PermActions actions={[
                                {label: '添加', type: 'primary', icon: <PlusOutlined/>, perm: 'stock:manage', onClick: this.openAdd},
                            ]}/>
                        </div>
                    </div>

                    <div className="sm-table-wrap">
                        <table className="sm-table">
                            <thead>
                            <tr>
                                {this.renderSortTh('name', '名称', false)}
                                {this.renderSortTh('today', priceHeader)}
                                {this.renderSortTh('entry', '入场')}
                                {this.renderSortTh('heavy', '重仓')}
                                {this.renderSortTh('prevChg', '昨日')}
                                {this.renderSortTh('tp1', '止盈 1')}
                                {this.renderSortTh('tp2', '止盈 2')}
                                {this.renderSortTh('yearInit', '年初价')}
                                {this.renderSortTh('updDate', '更新')}
                                <th style={{textAlign: 'right', width: 120}}>操作</th>
                            </tr>
                            </thead>
                            <tbody>
                            {view.length ? view.map(this.renderRow) : (
                                <tr><td colSpan={10} style={{textAlign:'center', padding: 32, color:'#94a3b8'}}>暂无数据</td></tr>
                            )}
                            </tbody>
                        </table>
                    </div>

                    <div className="sm-footer">
                        交易时段自动刷新（09:15–11:30 / 13:00–15:00），非交易时段显示收盘价。
                        <br/>
                        <span style={{fontSize: 11, color: '#94a3b8'}}>免责声明：本页面仅供个人持仓记录参考，不构成任何投资建议。股市有风险，投资需谨慎。</span>
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
.jt-stock-monitor { --bg:#f0f2f5; --surface:#fff; --elev:#f8fafc; --hover:#f1f5f9; --border:#e8ecf1; --border-med:#d1d9e0; --text:#0f172a; --text2:#64748b; --text3:#94a3b8; --up:#dc2626; --up-bg:#fef2f2; --up-border:#fecaca; --down:#16a34a; --down-bg:#f0fdf4; --down-border:#bbf7d0; --gold:#b45309; --orange:#c2410c; }
.jt-stock-monitor .sm-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:10px 14px;background:rgba(255,255,255,.95);border:1px solid var(--border);border-radius:10px;margin-bottom:10px}
.jt-stock-monitor .sm-left,.jt-stock-monitor .sm-right{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.jt-stock-monitor .sm-search{position:relative;display:flex;align-items:center}
.jt-stock-monitor .sm-search-icon{position:absolute;left:10px;color:var(--text3);font-size:12px;z-index:1}
.jt-stock-monitor .sm-search-input{width:220px}
.jt-stock-monitor .sm-search-input .ant-input,
.jt-stock-monitor .sm-search-input.ant-input-affix-wrapper{padding-left:30px}
.jt-stock-monitor .sm-count{font-size:12px;color:var(--text2);display:flex;align-items:center;gap:4px}
.jt-stock-monitor .sm-count b{font-size:14px;color:var(--text)}
.jt-stock-monitor .sm-meta{font-size:12px;color:var(--text2);display:flex;align-items:center;gap:4px}
.jt-stock-monitor .sm-meta b{color:var(--text);font-variant-numeric:tabular-nums;font-weight:500}
.jt-stock-monitor .sm-legend{display:flex;align-items:center;gap:4px;font-size:11px;color:var(--text3);margin-right:4px}
.jt-stock-monitor .sm-legend .dot{width:6px;height:6px;border-radius:50%;display:inline-block;margin-right:4px}
.jt-stock-monitor .sm-table-wrap{overflow:auto;border:1px solid var(--border);border-radius:10px;background:var(--surface)}
.jt-stock-monitor .sm-table{width:100%;border-collapse:collapse;min-width:1180px}
.jt-stock-monitor .sm-table thead th{height:38px;padding:0 12px;background:var(--elev);color:var(--text3);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.4px;text-align:right;white-space:nowrap;border-bottom:1px solid var(--border-med);user-select:none;position:sticky;top:0;z-index:2}
.jt-stock-monitor .sm-table thead th:first-child{text-align:left;padding-left:16px;position:sticky;left:0;z-index:3;box-shadow:2px 0 4px rgba(0,0,0,.04)}
.jt-stock-monitor .sm-table tbody tr{border-bottom:1px solid var(--border);transition:background .08s}
.jt-stock-monitor .sm-table tbody tr:hover td{background:var(--hover)!important}
.jt-stock-monitor .sm-table tbody tr:nth-child(even) td{background:#fafbfc}
.jt-stock-monitor .sm-table td{padding:8px 12px;height:52px;text-align:right;white-space:nowrap;vertical-align:middle;background:var(--surface);font-variant-numeric:tabular-nums}
.jt-stock-monitor .sm-table td:first-child{text-align:left;padding-left:16px;position:sticky;left:0;z-index:1;background:var(--surface);box-shadow:2px 0 4px rgba(0,0,0,.04), inset 3px 0 0 transparent}
.jt-stock-monitor .sm-table tbody tr:nth-child(even) td:first-child{background:#fafbfc}
.jt-stock-monitor .sm-table tbody tr:hover td:first-child{background:var(--hover)!important}
.jt-stock-monitor .row-above td:first-child{box-shadow:2px 0 4px rgba(0,0,0,.04), inset 3px 0 0 var(--up)}
.jt-stock-monitor .row-below td:first-child{box-shadow:2px 0 4px rgba(0,0,0,.04), inset 3px 0 0 var(--down)}
.jt-stock-monitor .row-buy td:first-child{box-shadow:2px 0 4px rgba(0,0,0,.04), inset 3px 0 0 #15803d}
.jt-stock-monitor .row-below td{background:rgba(22,163,74,.04)}
.jt-stock-monitor .row-buy td{background:rgba(22,163,74,.09)}
.jt-stock-monitor .col-name{font-size:13px;font-weight:500;color:var(--text)}
.jt-stock-monitor .stock-code{margin-left:2px;font-size:11px;font-weight:400;color:var(--text3);font-variant-numeric:tabular-nums}
.jt-stock-monitor .price-wrap{display:inline-flex;flex-direction:column;align-items:flex-end;gap:3px}
.jt-stock-monitor .price-cell{font-size:15px;font-weight:700;line-height:1;letter-spacing:-.3px}
.jt-stock-monitor .closing-tag{font-size:9px;font-weight:600;letter-spacing:.6px;text-transform:uppercase;color:var(--text3);background:var(--elev);border:1px solid var(--border-med);border-radius:3px;padding:1px 5px}
.jt-stock-monitor .change-badge{display:inline-flex;align-items:center;gap:3px;padding:3px 9px;border-radius:5px;font-size:12px;font-weight:600;min-width:70px;justify-content:center}
.jt-stock-monitor .badge-up{background:var(--up-bg);color:var(--up);border:1px solid var(--up-border)}
.jt-stock-monitor .badge-down{background:var(--down-bg);color:var(--down);border:1px solid var(--down-border)}
.jt-stock-monitor .badge-zero{background:var(--elev);color:var(--text2);border:1px solid var(--border-med)}
.jt-stock-monitor .badge-up::before{content:'▲';font-size:8px}
.jt-stock-monitor .badge-down::before{content:'▼';font-size:8px}
.jt-stock-monitor .up{color:var(--up)}
.jt-stock-monitor .down{color:var(--down)}
.jt-stock-monitor .neutral{color:var(--text2)}
.jt-stock-monitor .entry-col{color:#1d4ed8}
.jt-stock-monitor .heavy-col{color:#92400e}
.jt-stock-monitor .price-today-col{color:var(--text)}
.jt-stock-monitor .sub-diff{font-size:11px;opacity:.9;margin-top:1px}
.jt-stock-monitor .diff-col{font-size:12px;font-weight:500}
.jt-stock-monitor .tp-col{color:var(--text2);font-size:12px}
.jt-stock-monitor .tp-space{margin-left:4px;font-size:10px;color:var(--down);font-weight:500}
.jt-stock-monitor .near-tp1{color:var(--gold)!important;font-weight:700}
.jt-stock-monitor .over-tp1{color:var(--orange)!important;font-weight:700}
.jt-stock-monitor .over-tp2{color:#9333ea!important;font-weight:700}
.jt-stock-monitor .date-col{font-size:11px;color:var(--text3)}
.jt-stock-monitor .loading{color:var(--text3)!important;font-size:12px}
.jt-stock-monitor .no-data{color:var(--text3)}
.jt-stock-monitor .pending-badge{display:inline-flex;align-items:center;gap:5px;padding:3px 9px;border-radius:5px;font-size:11px;color:#92400e;background:#fef3c7;border:1px solid #fde68a}
.jt-stock-monitor .name-pending-tag{display:inline-flex;align-items:center;padding:1px 5px;border-radius:3px;font-size:10px;font-weight:500;color:#92400e;background:#fef3c7;border:1px solid #fde68a}
.jt-stock-monitor .sig{display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;white-space:nowrap}
.jt-stock-monitor .sig-buy{background:rgba(22,163,74,.12);color:#16a34a}
.jt-stock-monitor .sig-buy-strong{background:rgba(22,163,74,.22);color:#15803d}
.jt-stock-monitor .sig-hold{background:rgba(100,116,139,.1);color:var(--text2)}
.jt-stock-monitor .sig-near-tp{background:rgba(245,158,11,.12);color:#d97706}
.jt-stock-monitor .sig-tp{background:rgba(168,85,247,.12);color:#9333ea}
.jt-stock-monitor .sort-icon{margin-left:4px;font-size:9px;color:var(--text3)}
.jt-stock-monitor thead th.sort-asc .sort-icon::after{content:'▲';color:#2563eb}
.jt-stock-monitor thead th.sort-desc .sort-icon::after{content:'▼';color:#2563eb}
.jt-stock-monitor thead th:not(.sort-asc):not(.sort-desc) .sort-icon::after{content:'↕'}
.jt-stock-monitor thead th:hover{color:var(--text2)}
.jt-stock-monitor .actions-col{white-space:nowrap}
.jt-stock-monitor .sm-footer{padding:12px 8px 0;text-align:center;font-size:12px;color:var(--text2)}
@media (max-width: 768px){
  .jt-stock-monitor .sm-search-input{width:160px}
  .jt-stock-monitor .sm-table{min-width:980px;font-size:12px}
  .jt-stock-monitor .sm-table thead th{height:34px;padding:0 8px}
  .jt-stock-monitor .sm-table td{height:46px;padding:6px 8px}
}
`
