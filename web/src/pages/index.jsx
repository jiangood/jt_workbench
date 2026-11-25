import React from 'react';
import {
    Badge,
    Button,
    Card,
    Col,
    Empty,
    Row,
    Segmented,
    Space,
    Spin,
    Tag,
    Typography,
    message,
} from 'antd';
import {
    ArrowDownOutlined,
    ArrowUpOutlined,
    BellOutlined,
    BookOutlined,
    DollarOutlined,
    FileTextOutlined,
    FundOutlined,
    ReloadOutlined,
    StockOutlined,
    TeamOutlined,
} from '@ant-design/icons';
import {HttpClient, Page} from '@jiangood/open-admin';
import {zsxqPlainText} from './zsxq/richText';
import ExchangeRateChart from './index/exchangeRateChart';

const {Text, Title, Paragraph} = Typography;

const REPEAT = {
    '': '单次',
    daily: '每天',
    weekly: '每周',
    monthly: '每月',
    yearly: '每年',
};

const FX_RANGES = [
    {label: '1月', value: '1m'},
    {label: '3月', value: '3m'},
    {label: '6月', value: '6m'},
    {label: '1年', value: '1y'},
];
const FX_RANGE_LABELS = Object.fromEntries(FX_RANGES.map((item) => [item.value, item.label]));

function pad(n) {
    return String(n).padStart(2, '0');
}

function fmtDateTime(v) {
    if (!v) return '';
    const s = String(v);
    if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
        const d = new Date(s);
        if (!Number.isNaN(d.getTime())) {
            const sameDay = d.toDateString() === new Date().toDateString();
            const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
            if (sameDay) return hm;
            return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`;
        }
        return s.replace('T', ' ').slice(0, 16).replace(/-/g, '/');
    }
    if (/^\d+$/.test(s)) {
        const d = new Date(Number(s));
        if (!Number.isNaN(d.getTime())) {
            const sameDay = d.toDateString() === new Date().toDateString();
            const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
            if (sameDay) return hm;
            return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`;
        }
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s.slice(5);
    return s.slice(0, 16);
}

function offsetText(offsets) {
    const list = Array.isArray(offsets) ? offsets : [];
    const leads = list.filter((o) => o > 0).sort((a, b) => b - a);
    const sameDay = list.includes(0);
    if (!leads.length) return '当天';
    return `提前 ${leads.join('/')} 天${sameDay ? ' + 当天' : ''}`;
}

function remindTone(daysLeft) {
    const d = Number(daysLeft);
    if (!Number.isFinite(d)) return {text: '—', color: 'default'};
    if (d < 0) return {text: '待发送', color: 'red'};
    if (d === 0) return {text: '今天', color: 'red'};
    if (d <= 3) return {text: `${d} 天后`, color: 'orange'};
    return {text: `${d} 天后`, color: 'default'};
}

function lunarLabel(r) {
    if (!r?.lunar || !r.lunarMonth || !r.lunarDay) return null;
    return `农历${r.lunarLeap ? '闰' : ''}${r.lunarMonth}月${r.lunarDay}日`;
}

function VixSparkline({history = []}) {
    const points = (history || [])
        .filter((p) => p && Number.isFinite(Number(p.close)))
        .slice(-30);
    if (points.length < 2) {
        return <div style={{height: 80, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#999', fontSize: 12}}>暂无走势数据</div>;
    }
    const values = points.map((p) => Number(p.close));
    const min = Math.min(...values);
    const max = Math.max(...values);
    const w = 420;
    const h = 90;
    const padX = 6;
    const padY = 8;
    const range = Math.max(max - min, 0.0001);
    const sx = (i) => padX + (i * (w - padX * 2)) / (values.length - 1);
    const sy = (v) => h - padY - ((v - min) * (h - padY * 2)) / range;
    const line = values.map((v, i) => `${i === 0 ? 'M' : 'L'} ${sx(i).toFixed(2)} ${sy(v).toFixed(2)}`).join(' ');
    const area = `${line} L ${sx(values.length - 1).toFixed(2)} ${(h - padY).toFixed(2)} L ${sx(0).toFixed(2)} ${(h - padY).toFixed(2)} Z`;
    const last = values[values.length - 1];
    const first = values[0];
    const up = last >= first;
    const stroke = up ? '#cf1322' : '#389e0d';
    const fill = up ? 'rgba(207,19,34,0.10)' : 'rgba(56,158,13,0.10)';
    return (
        <svg viewBox={`0 0 ${w} ${h}`} width="100%" height="90" preserveAspectRatio="none" style={{display: 'block'}}>
            <path d={area} fill={fill} stroke="none"/>
            <path d={line} fill="none" stroke={stroke} strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round"/>
            <circle cx={sx(values.length - 1)} cy={sy(last)} r="3.2" fill={stroke}/>
        </svg>
    );
}

function CardHead({icon, title, extra, href, linkText = '查看全部'}) {
    return (
        <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12}}>
            <Space size={8}>
                {icon}
                <span style={{fontSize: 16, fontWeight: 600}}>{title}</span>
                {extra}
            </Space>
            {href ? <a href={href} style={{fontSize: 13}}>{linkText} →</a> : null}
        </div>
    );
}

function EmptyHint({text, href, action}) {
    return (
        <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
                <div>
                    <div style={{marginBottom: href ? 6 : 0}}>{text}</div>
                    {href ? <a href={href}>{action} →</a> : null}
                </div>
            }
        />
    );
}

export default class HomePage extends React.Component {
    state = {
        loading: true,
        summary: null,
        vix: null,
        vixFailed: false,
        quotes: [],
        quoteFailed: false,
        exchangeRate: null,
        exchangeRange: '3m',
        exchangeLoading: false,
        exchangeFailed: false,
        updatedAt: null,
    };

    exchangeRequestId = 0;

    componentDidMount() {
        this.load();
    }

    componentWillUnmount() {
        this.exchangeRequestId += 1;
    }

    load = async () => {
        this.setState({loading: true, exchangeLoading: true});
        const [sumRs, vixRs, quoteRs, exchangeRs] = await Promise.allSettled([
            HttpClient.get('admin/dashboard/summary'),
            HttpClient.get('admin/stock/vix'),
            HttpClient.get('admin/stock/quote'),
            HttpClient.get(`admin/exchange/usd-cny?range=${this.state.exchangeRange}`),
        ]);

        const next = {loading: false, exchangeLoading: false, updatedAt: new Date()};
        if (sumRs.status === 'fulfilled') {
            next.summary = sumRs.value?.data || null;
        } else {
            next.summary = null;
            message.error('首页数据加载失败');
        }

        if (vixRs.status === 'fulfilled') {
            next.vix = vixRs.value?.data || null;
            next.vixFailed = false;
        } else {
            next.vix = null;
            next.vixFailed = true;
        }

        if (quoteRs.status === 'fulfilled') {
            next.quotes = quoteRs.value?.data?.quotes || [];
            next.quoteFailed = false;
        } else {
            next.quotes = [];
            next.quoteFailed = true;
        }

        if (exchangeRs.status === 'fulfilled') {
            next.exchangeRate = exchangeRs.value?.data || null;
            next.exchangeFailed = !next.exchangeRate?.available;
        } else {
            next.exchangeRate = null;
            next.exchangeFailed = true;
        }

        this.setState(next);
    };

    loadExchangeRate = async (range) => {
        const requestId = ++this.exchangeRequestId;
        this.setState({exchangeRange: range, exchangeLoading: true, exchangeFailed: false});
        try {
            const response = await HttpClient.get(`admin/exchange/usd-cny?range=${range}`);
            if (requestId !== this.exchangeRequestId) return;
            const data = response?.data || null;
            this.setState({
                exchangeRate: data,
                exchangeLoading: false,
                exchangeFailed: !data?.available,
            });
        } catch (e) {
            if (requestId !== this.exchangeRequestId) return;
            this.setState({exchangeRate: null, exchangeLoading: false, exchangeFailed: true});
        }
    };

    renderExchangeRateCard() {
        const {exchangeRate: rate, exchangeRange, exchangeLoading, exchangeFailed} = this.state;
        const available = rate && rate.available !== false && Number.isFinite(Number(rate.price));
        const change = rate?.change == null ? null : Number(rate.change);
        const changePct = rate?.changePct == null ? null : Number(rate.changePct);
        const rising = change > 0;
        const falling = change < 0;
        const deltaColor = rising ? '#cf1322' : falling ? '#389e0d' : '#666';
        const deltaIcon = rising ? <ArrowUpOutlined/> : falling ? <ArrowDownOutlined/> : null;
        const history = (rate?.history || []).filter((point) => Number.isFinite(Number(point?.close)));
        const values = history.map((point) => Number(point.close));
        const low = values.length ? Math.min(...values) : null;
        const high = values.length ? Math.max(...values) : null;
        const loading = (this.state.loading && !rate) || (exchangeLoading && !rate);

        return (
            <Card bordered={false} style={{height: '100%'}} bodyStyle={{padding: 18}}>
                <CardHead icon={<DollarOutlined style={{color: '#1677ff'}}/>} title="美元兑人民币" extra={<Tag>USD/CNY</Tag>}/>
                {loading ? (
                    <div style={{textAlign: 'center', padding: '52px 0'}}><Spin/></div>
                ) : available ? (
                    <div>
                        <div style={{display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap'}}>
                            <div>
                                <div style={{fontSize: 32, fontWeight: 700, lineHeight: 1.1, color: '#222', fontFamily: 'monospace'}}>
                                    {Number(rate.price).toFixed(4)}
                                    <span style={{fontSize: 13, fontWeight: 400, color: '#999', marginLeft: 6}}>CNY</span>
                                </div>
                                <div style={{marginTop: 6, fontSize: 14, color: deltaColor, fontWeight: 500}}>
                                    {deltaIcon} {Number.isFinite(change) ? `${change > 0 ? '+' : ''}${change.toFixed(4)}` : '—'}
                                    {Number.isFinite(changePct) ? ` (${changePct > 0 ? '+' : ''}${changePct.toFixed(2)}%)` : ''}
                                </div>
                            </div>
                            <Segmented
                                size="small"
                                value={exchangeRange}
                                options={FX_RANGES}
                                disabled={this.state.loading || exchangeLoading}
                                onChange={this.loadExchangeRate}
                            />
                        </div>
                        <div style={{marginTop: 8, color: '#999', fontSize: 12}}>
                            较前一交易日{rate.asOf ? ` · 数据日期 ${rate.asOf}` : ' · 日线参考汇率'}
                        </div>
                        <div style={{marginTop: 12, opacity: exchangeLoading ? 0.55 : 1}} aria-busy={exchangeLoading}>
                            <Spin spinning={exchangeLoading}>
                                <ExchangeRateChart history={rate.history || []}/>
                            </Spin>
                        </div>
                        <div style={{display: 'flex', justifyContent: 'space-between', gap: 12, color: '#999', fontSize: 12, marginTop: 4}}>
                            <span>近 {FX_RANGE_LABELS[exchangeRange] || '3月'} · {low == null || high == null ? '—' : `${low.toFixed(4)} – ${high.toFixed(4)}`}</span>
                            <span>{history.length} 个交易日</span>
                        </div>
                        <div style={{marginTop: 6, color: '#999', fontSize: 12}}>
                            来源：{rate.sourceName || '欧洲央行参考汇率'} · 日线参考数据
                        </div>
                    </div>
                ) : (
                    <Empty
                        image={Empty.PRESENTED_IMAGE_SIMPLE}
                        description={
                            <div>
                                <div style={{marginBottom: 8}}>{exchangeFailed ? '汇率数据暂不可用（行情源连接失败）' : '暂无汇率趋势数据'}</div>
                                <Button size="small" onClick={() => this.loadExchangeRate(exchangeRange)} loading={exchangeLoading}>重新加载</Button>
                            </div>
                        }
                    />
                )}
            </Card>
        );
    }

    renderVixCard() {
        const {vix, vixFailed} = this.state;
        const loading = this.state.loading && !vix;
        const available = vix && vix.available;
        let deltaColor = '#666';
        let deltaIcon = null;
        if (available && Number.isFinite(Number(vix.change))) {
            if (Number(vix.change) > 0) {
                deltaColor = '#cf1322';
                deltaIcon = <ArrowUpOutlined/>;
            } else if (Number(vix.change) < 0) {
                deltaColor = '#389e0d';
                deltaIcon = <ArrowDownOutlined/>;
            }
        }
        return (
            <Card bordered={false} style={{height: '100%'}} bodyStyle={{padding: 18}}>
                <CardHead icon={<StockOutlined style={{color: '#722ed1'}}/>} title="VIX 指数看板"/>
                {loading ? (
                    <div style={{textAlign: 'center', padding: '24px 0'}}><Spin/></div>
                ) : available ? (
                    <div>
                        <div style={{display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap'}}>
                            <div>
                                <div style={{fontSize: 34, fontWeight: 700, lineHeight: 1.1, color: '#222'}}>
                                    {Number(vix.price).toFixed(2)}
                                </div>
                                <div style={{marginTop: 6, fontSize: 14, color: deltaColor, fontWeight: 500}}>
                                    {deltaIcon} {Number.isFinite(Number(vix.change)) ? `${vix.change > 0 ? '+' : ''}${Number(vix.change).toFixed(2)}` : '—'}
                                    {Number.isFinite(Number(vix.changePct)) ? ` (${vix.changePct > 0 ? '+' : ''}${Number(vix.changePct).toFixed(2)}%)` : ''}
                                </div>
                            </div>
                            <div style={{textAlign: 'right', color: '#888', fontSize: 12}}>
                                <div>恐慌指数 (CBOE Volatility Index)</div>
                                <div style={{marginTop: 4}}>前收 {Number.isFinite(Number(vix.prevClose)) ? Number(vix.prevClose).toFixed(2) : '—'}</div>
                                {vix.marketTime ? <div style={{marginTop: 2}}>更新 {fmtDateTime(new Date(Number(vix.marketTime)).toISOString())}</div> : null}
                            </div>
                        </div>
                        <div style={{marginTop: 14}}>
                            <VixSparkline history={vix.history || []}/>
                            <div style={{display: 'flex', justifyContent: 'space-between', color: '#999', fontSize: 12, marginTop: 2}}>
                                <span>近 {(vix.history || []).length || 0} 个交易日</span>
                                <span>数值越高通常代表市场波动预期越强</span>
                            </div>
                        </div>
                    </div>
                ) : (
                    <EmptyHint
                        text={vixFailed ? 'VIX 数据暂不可用（行情源连接失败）' : '暂无 VIX 数据'}
                        href="#/stock"
                        action="查看股票"
                    />
                )}
            </Card>
        );
    }

    renderReminderCard() {
        const reminders = this.state.summary?.reminders || {};
        const items = reminders.upcoming || [];
        return (
            <Card bordered={false} style={{height: '100%'}} bodyStyle={{padding: 18}}>
                <CardHead icon={<BellOutlined style={{color: '#fa8c16'}}/>} title="近期提醒" href="#/reminder"/>
                {items.length ? (
                    <div>
                        {items.map((r) => {
                            const tone = remindTone(r.daysLeft);
                            const when = r.lunar ? (lunarLabel(r) || `农历 ${r.eventDate}`) : r.eventDate;
                            const lead = offsetText(r.offsets);
                            const repeat = REPEAT[r.type || ''] || (r.type || '单次');
                            return (
                                <a key={r.id} href="#/reminder" style={{display: 'flex', justifyContent: 'space-between', gap: 12, padding: '10px 0', borderBottom: '1px solid #f5f5f5', color: 'inherit'}}>
                                    <div style={{minWidth: 0}}>
                                        <div style={{fontSize: 14, color: '#222', lineHeight: 1.5}}>{r.title || '(未命名)'}</div>
                                        <div style={{fontSize: 12, color: '#999', marginTop: 2}}>
                                            {when}{r.remindAt ? ` ${r.remindAt}` : ''} · {repeat}{lead === '当天' ? '' : ` · ${lead}`}
                                        </div>
                                    </div>
                                    <div style={{flex: 'none', paddingTop: 1}}>
                                        <Tag color={tone.color}>{tone.text}</Tag>
                                    </div>
                                </a>
                            );
                        })}
                    </div>
                ) : (
                    <EmptyHint text="未来 30 天暂无提醒" href="#/reminder" action="新建提醒"/>
                )}
            </Card>
        );
    }

    renderNoteCard() {
        const notes = this.state.summary?.notes || {};
        const items = notes.latest || [];
        return (
            <Card bordered={false} style={{height: '100%'}} bodyStyle={{padding: 18}}>
                <CardHead icon={<FileTextOutlined style={{color: '#52c41a'}}/>} title="最近笔记" href="#/note"/>
                {items.length ? (
                    <div>
                        {items.map((n) => (
                            <a key={n.id} href={`#/note/edit?id=${encodeURIComponent(n.id)}`} style={{display: 'flex', justifyContent: 'space-between', gap: 12, padding: '10px 0', borderBottom: '1px solid #f5f5f5', color: 'inherit'}}>
                                <div style={{minWidth: 0}}>
                                    <div style={{fontSize: 14, color: '#222', lineHeight: 1.5}}>{n.title || '无标题'}</div>
                                    <div style={{fontSize: 12, color: '#999', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'}}>
                                        {n.preview || '暂无内容'}
                                    </div>
                                </div>
                                <div style={{flex: 'none', fontSize: 12, color: '#999', paddingTop: 2}}>
                                    {fmtDateTime(n.updateTime)}
                                </div>
                            </a>
                        ))}
                    </div>
                ) : (
                    <EmptyHint text="还没有笔记，去记录一个想法" href="#/note/edit" action="新建笔记"/>
                )}
            </Card>
        );
    }

    renderZsxqCard() {
        const zsxq = this.state.summary?.zsxq || {};
        const items = zsxq.latest || [];
        return (
            <Card bordered={false} style={{height: '100%'}} bodyStyle={{padding: 18}}>
                <CardHead icon={<TeamOutlined style={{color: '#eb2f96'}}/>} title="知识星球" href="#/zsxq"/>
                {items.length ? (
                    <div>
                        {items.map((t) => (
                            <a key={t.id} href="#/zsxq" style={{display: 'flex', justifyContent: 'space-between', gap: 12, padding: '10px 0', borderBottom: '1px solid #f5f5f5', color: 'inherit'}}>
                                <div style={{minWidth: 0, fontSize: 14, color: '#222', lineHeight: 1.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'}}>
                                    {zsxqPlainText(t.preview) || '(无内容)'}
                                </div>
                                <div style={{flex: 'none', fontSize: 12, color: '#999', paddingTop: 2}}>
                                    {fmtDateTime(t.time)}
                                </div>
                            </a>
                        ))}
                        <div style={{marginTop: 10, fontSize: 12, color: '#999'}}>
                            帖子 {zsxq.total ?? 0}
                        </div>
                    </div>
                ) : (
                    <EmptyHint text="暂无归档话题，等待同步任务拉取" href="#/zsxq" action="去知识星球"/>
                )}
            </Card>
        );
    }

    renderStocksCard() {
        const watch = this.state.summary?.stocks?.watch || [];
        const {quotes, quoteFailed} = this.state;
        const quoteMap = new Map((quotes || []).map((q) => [q.code, q]));

        // 参考价：离重仓价跌幅；无重仓价时按入场价；缺行情或未开盘则无法计算
        const ranked = [];
        watch.forEach((w) => {
            if (!w || !w.code) return;
            const q = quoteMap.get(w.code);
            const live = q && !q.preOpen && q.price != null ? Number(q.price) : null;
            const heavy = Number(w.heavyPrice);
            const entry = Number(w.entryPrice);
            const ref = Number.isFinite(heavy) && heavy !== 0
                ? heavy
                : (Number.isFinite(entry) && entry !== 0 ? entry : null);
            if (!Number.isFinite(live) || ref == null || ref === 0) return;
            ranked.push({
                code: w.code,
                name: w.name || w.code,
                groupName: w.groupName,
                live,
                pct: ((live - ref) / ref) * 100,
            });
        });
        // 跌幅最大（最低于参考价）排在前面，只取 top 5
        ranked.sort((a, b) => b.pct - a.pct);
        const top = ranked.slice(0, 5);

        return (
            <Card bordered={false} style={{height: '100%'}} bodyStyle={{padding: 18}}>
                <CardHead icon={<FundOutlined style={{color: '#13c2c2'}}/>} title="自选股跌幅榜" href="#/stock"/>
                {top.length ? (
                    <div>
                        {top.map((s) => (
                            <a key={s.code} href="#/stock" style={{display: 'flex', justifyContent: 'space-between', gap: 12, padding: '10px 0', borderBottom: '1px solid #f5f5f5', color: 'inherit'}}>
                                <div style={{minWidth: 0}}>
                                    <div style={{fontSize: 14, color: '#222', lineHeight: 1.5}}>
                                        {s.name || s.code}
                                        {s.groupName ? <Tag style={{marginLeft: 6}}>{s.groupName}</Tag> : null}
                                    </div>
                                    <div style={{fontSize: 12, color: '#999', marginTop: 2}}>{s.code}</div>
                                </div>
                                <div style={{flex: 'none', textAlign: 'right'}}>
                                    <div style={{fontSize: 14, fontWeight: 500, color: s.pct > 0 ? '#cf1322' : s.pct < 0 ? '#389e0d' : '#222', fontFamily: 'monospace'}}>
                                        {s.pct > 0 ? '+' : ''}{s.pct.toFixed(2)}%
                                    </div>
                                    <div style={{fontSize: 12, color: '#999', marginTop: 2, fontFamily: 'monospace'}}>
                                        {s.live.toFixed(2)}
                                    </div>
                                </div>
                            </a>
                        ))}
                    </div>
                ) : (
                    <EmptyHint
                        text={quoteFailed ? '行情暂不可用（行情源连接失败）' : '暂无可计算跌幅的股票'}
                        href="#/stock"
                        action="查看股票"
                    />
                )}
            </Card>
        );
    }

    render() {
        const {loading, summary, updatedAt} = this.state;
        return (
            <Page>
                <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 16, flexWrap: 'wrap', marginBottom: 16}}>
                    <div>
                        <Title level={4} style={{margin: 0}}>Dashboard</Title>
                        <Text type="secondary">今日概览 · 资讯、提醒与市场一屏可读</Text>
                    </div>
                    <Space>
                        <Text type="secondary" style={{fontSize: 12}}>
                            {updatedAt ? `更新于 ${pad(updatedAt.getHours())}:${pad(updatedAt.getMinutes())}` : ''}
                        </Text>
                        <Button icon={<ReloadOutlined/>} onClick={this.load} loading={loading}>刷新</Button>
                    </Space>
                </div>

                {loading && !summary ? (
                    <div style={{textAlign: 'center', padding: '80px 0'}}><Spin size="large"/></div>
                ) : (
                    <Row gutter={[16, 16]}>
                        <Col xs={24} xl={10}>
                            {this.renderVixCard()}
                        </Col>
                        <Col xs={24} lg={12} xl={8}>
                            {this.renderStocksCard()}
                        </Col>
                        <Col xs={24} lg={12} xl={8}>
                            {this.renderReminderCard()}
                        </Col>
                        <Col xs={24} lg={12} xl={8}>
                            {this.renderExchangeRateCard()}
                        </Col>
                        <Col xs={24} lg={12} xl={8}>
                            {this.renderNoteCard()}
                        </Col>
                        <Col xs={24} lg={12} xl={8}>
                            {this.renderZsxqCard()}
                        </Col>
                    </Row>
                )}
            </Page>
        );
    }
}
