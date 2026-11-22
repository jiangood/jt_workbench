import {MailOutlined, PlusOutlined, ReloadOutlined} from '@ant-design/icons'
import {
    Alert, Button, Checkbox, DatePicker, Form, Input, InputNumber, message, Radio, Select, Space,
    Switch, Tag, TimePicker, Tooltip, Typography
} from 'antd'
import dayjs from 'dayjs'
import React from 'react'
import {FormModal, HttpClient, Page, PermActions, ProTable} from '@jiangood/open-admin'

const {Text} = Typography

const TYPE_LABELS = {
    '': '单次',
    daily: '每天',
    weekly: '每周',
    monthly: '每月',
    yearly: '每年',
}

const TYPE_OPTIONS = [
    {value: 'daily', label: '每天'},
    {value: 'weekly', label: '每周'},
    {value: 'monthly', label: '每月'},
    {value: 'yearly', label: '每年'},
]

const OFFSET_OPTIONS = [
    {value: 30, label: '提前 30 天'},
    {value: 14, label: '提前 14 天'},
    {value: 7, label: '提前 1 周'},
    {value: 3, label: '提前 3 天'},
    {value: 1, label: '提前 1 天'},
    {value: 0, label: '当天'},
]

const LUNAR_MONTHS = ['正', '二', '三', '四', '五', '六', '七', '八', '九', '十', '冬', '腊']
const LUNAR_DAYS = [
    '初一', '初二', '初三', '初四', '初五', '初六', '初七', '初八', '初九', '初十',
    '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十',
    '廿一', '廿二', '廿三', '廿四', '廿五', '廿六', '廿七', '廿八', '廿九', '三十',
]
const LUNAR_MONTH_OPTIONS = LUNAR_MONTHS.map((label, index) => ({value: index + 1, label: `${label}月`}))
const LUNAR_DAY_OPTIONS = LUNAR_DAYS.map((label, index) => ({value: index + 1, label}))

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

function repeatLabel(record) {
    if (record?.lunar) return '每年'
    return TYPE_LABELS[record?.type || ''] || record?.type
}

/** remindOffsetsJson 按逗号分隔存（与旧作业的 remind_offsets 兼容），如 "30,7,0" */
function parseOffsets(row) {
    const raw = row?.remindOffsetsJson
    if (raw && typeof raw === 'string') {
        const list = raw.split(',').map(x => Number(String(x).trim())).filter(n => Number.isInteger(n) && n >= 0)
        if (list.length) return list
    }
    return Number.isInteger(row?.remindOffsets) ? [row.remindOffsets] : [0]
}

function offsetText(row) {
    const list = parseOffsets(row)
    const leads = list.filter(n => n > 0).sort((a, b) => b - a)
    const sameDay = list.includes(0)
    if (!leads.length) return '当天'
    return `提前 ${leads.join('/')} 天${sameDay ? ' + 当天' : ''}`
}

function lunarText(month, day, leap) {
    if (!month || !day) return ''
    return `${leap ? '闰' : ''}${LUNAR_MONTHS[month - 1]}月${LUNAR_DAYS[day - 1]}`
}

function weekdayText(date) {
    return date ? WEEKDAYS[dayjs(date).day()] : ''
}

function previewText(item) {
    const weekday = item.weekday || weekdayText(item.date)
    const value = Number(item.days)
    const days = value === 0 ? '今天' : value === 1 ? '明天' : `${value} 天后`
    return `${item.date} ${weekday} · ${days}${item.lunar ? ` · 农历${item.lunar}` : ''}`
}

function timeValue(value) {
    if (dayjs.isDayjs(value)) return value
    const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value || ''))
    return dayjs().hour(match ? Number(match[1]) : 9).minute(match ? Number(match[2]) : 0).second(0)
}

function countdownView(value, record) {
    if (value === 0) return <Tag color='volcano'>今天</Tag>
    if (value === 1) return <Tag color='orange'>明天</Tag>
    if (Number.isInteger(value) && value > 0) {
        return <Tag color={value <= 7 ? 'gold' : 'default'}>{value} 天后</Tag>
    }
    if (record?.expired || record?.status === 'expired') {
        return <Text type='secondary'>已结束</Text>
    }
    return <Text type='secondary'>—</Text>
}

function statusTag(record) {
    switch (record?.status) {
        case 'error':
            return (
                <Tooltip title={record.lastError || '发送失败'}>
                    <Tag color='red'>发送失败</Tag>
                </Tooltip>
            )
        case 'sent':
            return <Tag color='green'>今日已发</Tag>
        case 'done':
            return <Tag color='green'>已完成</Tag>
        case 'disabled':
            return <Tag>已停用</Tag>
        case 'expired':
            return <Tag>已过期</Tag>
        default:
            return <Tag color='blue'>待发送</Tag>
    }
}

/** 提醒：列表 + 新建/编辑弹窗（重复方式、农历、多个提前提醒点） */
export default class ReminderPage extends React.Component {

    state = {
        editing: null,
        scanning: false,
        mailConfigured: null,
        customOffset: null,
        preview: [],
        previewHint: '填写日期后显示接下来 3 次',
    }

    tableRef = React.createRef()
    modalRef = React.createRef()
    previewSeq = 0
    previewTimer = null

    componentDidMount() {
        HttpClient.get('admin/reminder/meta').then(rs => {
            this.setState({mailConfigured: !!rs.data?.mailConfigured})
        }).catch(() => {
            // 元信息失败不影响列表
        })
    }

    componentWillUnmount() {
        if (this.previewTimer) clearTimeout(this.previewTimer)
    }

    openAdd = () => {
        this.setState({editing: null, customOffset: null, preview: [], previewHint: '填写日期后显示接下来 3 次'})
        this.modalRef.current.open({
            id: undefined,
            title: '',
            description: '',
            type: null,
            offsets: [0],
            enabled: true,
            lunar: false,
            lunarMonth: null,
            lunarDay: null,
            lunarLeap: false,
            remindAt: dayjs().hour(9).minute(0).second(0),
        })
    }

    openEdit = (record) => {
        this.setState({editing: record, customOffset: null, preview: [], previewHint: '填写日期后显示接下来 3 次'})
        this.modalRef.current.open({
            ...record,
            offsets: parseOffsets(record),
            lunarLeap: !!record.lunarLeap,
            remindAt: timeValue(record.remindAt),
            eventDate: record.eventDate ? dayjs(record.eventDate) : null,
        })
        // FormModal 在下一轮事件循环里回填表单，稍后再取最新值预览
        if (this.previewTimer) clearTimeout(this.previewTimer)
        this.previewTimer = setTimeout(() => this.loadPreview(), 150)
    }

    handleValuesChange = (changed) => {
        if (Object.prototype.hasOwnProperty.call(changed, 'lunar')) {
            const form = this.modalRef.current?.formInstance
            form?.setFieldsValue({type: changed.lunar ? 'yearly' : null})
        }
        const relevant = ['lunar', 'lunarMonth', 'lunarDay', 'lunarLeap', 'eventDate', 'type']
        if (relevant.some(key => Object.prototype.hasOwnProperty.call(changed, key))) {
            this.schedulePreview()
        }
    }

    schedulePreview = () => {
        if (this.previewTimer) clearTimeout(this.previewTimer)
        this.previewTimer = setTimeout(() => this.loadPreview(), 250)
    }

    loadPreview = async () => {
        const form = this.modalRef.current?.formInstance
        if (!form) return
        const values = form.getFieldsValue(['lunar', 'lunarMonth', 'lunarDay', 'lunarLeap', 'eventDate', 'type'])
        const lunar = !!values.lunar
        if (lunar && (!values.lunarMonth || !values.lunarDay)) {
            this.setState({preview: [], previewHint: '填写日期后显示接下来 3 次'})
            return
        }
        if (!lunar && !values.eventDate) {
            this.setState({preview: [], previewHint: '填写日期后显示接下来 3 次'})
            return
        }

        const payload = {
            lunar,
            lunarMonth: lunar ? values.lunarMonth : null,
            lunarDay: lunar ? values.lunarDay : null,
            lunarLeap: lunar ? !!values.lunarLeap : false,
            type: lunar ? 'yearly' : (values.type || null),
            eventDate: (!lunar && values.eventDate)
                ? (dayjs.isDayjs(values.eventDate) ? values.eventDate.format('YYYY-MM-DD') : values.eventDate)
                : null,
        }
        const seq = ++this.previewSeq
        try {
            const rs = await HttpClient.post('admin/reminder/preview', payload, null, {toastError: false})
            if (seq === this.previewSeq) {
                const preview = rs.data || []
                this.setState({
                    preview,
                    previewHint: preview.length ? '' : '没有找到未来发生日期（单次已过期或该日期多年才出现一次）',
                })
            }
        } catch {
            if (seq === this.previewSeq) this.setState({preview: [], previewHint: '预览加载失败'})
        }
    }

    sendTestMail = async () => {
        const rs = await HttpClient.post('admin/reminder/test-mail')
        message.success(rs.data || '测试邮件已发送')
    }

    addCustomOffset = () => {
        const value = Number(this.state.customOffset)
        if (!Number.isInteger(value) || value <= 0) {
            message.warning('请输入大于 0 的整数天数')
            return
        }
        const form = this.modalRef.current?.formInstance
        const current = form?.getFieldValue('offsets') || []
        if (!current.includes(value)) {
            form?.setFieldsValue({offsets: [...current, value].sort((a, b) => b - a)})
        }
        this.setState({customOffset: null})
    }

    handleSubmit = async (values) => {
        const lunar = !!values.lunar
        const offsets = Array.isArray(values.offsets) && values.offsets.length ? values.offsets : [0]
        const normalizedOffsets = [...new Set(offsets.map(Number))]
            .filter(n => Number.isInteger(n) && n >= 0)
            .sort((a, b) => b - a)
        if (!normalizedOffsets.length) normalizedOffsets.push(0)
        const remindAt = dayjs.isDayjs(values.remindAt)
            ? values.remindAt.format('HH:mm')
            : (values.remindAt || '09:00')
        const payload = {
            id: values.id,
            title: values.title,
            description: values.description,
            type: lunar ? 'yearly' : (values.type || null),
            lunar,
            lunarMonth: lunar ? values.lunarMonth : null,
            lunarDay: lunar ? values.lunarDay : null,
            lunarLeap: lunar ? !!values.lunarLeap : null,
            remindOffsets: Math.max(...normalizedOffsets),
            remindOffsetsJson: normalizedOffsets.join(','),
            remindAt,
            eventDate: (!lunar && values.eventDate)
                ? (dayjs.isDayjs(values.eventDate) ? values.eventDate.format('YYYY-MM-DD') : values.eventDate)
                : null,
            enabled: !!values.enabled,
        }
        await HttpClient.post('admin/reminder/save', payload)
        message.success(values.id ? '已保存' : '已创建')
        this.tableRef.current?.reload()
    }

    toggleEnabled = async (record) => {
        await HttpClient.post('admin/reminder/toggle', {id: record.id, enabled: !record.enabled})
        this.tableRef.current?.reload()
    }

    scanAll = async () => {
        this.setState({scanning: true})
        try {
            const rs = await HttpClient.post('admin/reminder/scan')
            message.success(rs.data || '扫描完成')
            this.tableRef.current?.reload()
        } finally {
            this.setState({scanning: false})
        }
    }

    scanOne = async (record) => {
        const rs = await HttpClient.post(`admin/reminder/${record.id}/scan`)
        message.info(rs.data || '已检查')
        this.tableRef.current?.reload()
    }

    deleteRecord = async (record) => {
        await HttpClient.post('admin/reminder/delete', {id: record.id})
        message.success('已删除')
        this.tableRef.current?.reload()
    }

    render() {
        const {editing, scanning, mailConfigured, customOffset, preview, previewHint} = this.state
        return <Page>
            {mailConfigured === false
                ? <Alert
                    type='warning'
                    showIcon
                    style={{marginBottom: 12}}
                    message='邮件通知尚未配置，提醒暂时发不出去'
                    description='请先在系统设置中完成邮件参数配置；配置完成后可点「立即扫描」验证。'
                />
                : null}

            <ProTable
                actionRef={this.tableRef}
                rowKey='id'
                emptyText={<div style={{padding: '24px 0', color: '#999'}}>
                    还没有提醒，点击右上角「新建提醒」开始
                </div>}
                toolBarRightRender={() => (
                    <PermActions actions={[
                        {
                            label: scanning ? '扫描中…' : '立即扫描',
                            icon: <ReloadOutlined/>,
                            perm: 'reminder:edit',
                            disabled: scanning,
                            confirm: '将检查所有启用的提醒，命中提前提醒规则且已到提醒时刻的会立即发送邮件。是否继续？',
                            onClick: this.scanAll,
                        },
                        {
                            label: '发送测试',
                            icon: <MailOutlined/>,
                            perm: 'reminder:edit',
                            disabled: mailConfigured === false,
                            confirm: '向系统配置的收件邮箱发送一封测试邮件？',
                            onClick: this.sendTestMail,
                        },
                        {
                            label: '新建提醒', type: 'primary', icon: <PlusOutlined/>, perm: 'reminder:edit',
                            onClick: this.openAdd,
                        },
                    ]}/>
                )}
                request={(params) => HttpClient.post('admin/reminder/page', null, params)}
                searchFormRender={() => (
                    <>
                        <Form.Item label='关键字' name='keyword'>
                            <Input placeholder='标题或备注' allowClear/>
                        </Form.Item>
                        <Form.Item label='重复方式' name='type'>
                            <Select allowClear placeholder='全部' options={TYPE_OPTIONS}/>
                        </Form.Item>
                        <Form.Item label='状态' name='enabled'>
                            <Select allowClear placeholder='全部' options={[
                                {value: true, label: '启用'},
                                {value: false, label: '停用'},
                            ]}/>
                        </Form.Item>
                        <Form.Item label='范围' name='scope'>
                            <Select allowClear placeholder='全部' options={[
                                {value: 'today', label: '今天'},
                                {value: 'week', label: '7 天内'},
                                {value: 'overdue', label: '已过期'},
                            ]}/>
                        </Form.Item>
                    </>
                )}
                columns={[
                    {
                        title: '提醒', dataIndex: 'title',
                        render: (v, record) => <div>
                            <a href='#' onClick={(event) => {
                                event.preventDefault()
                                this.openEdit(record)
                            }}>{v || '(未命名)'}</a>
                            {record.description
                                ? <div style={{fontSize: 12, color: '#999', marginTop: 2}}>{record.description}</div>
                                : null}
                            <div style={{marginTop: 4}}>
                                {record.lunar
                                    ? <Tag color='purple'>
                                        农历{lunarText(record.lunarMonth, record.lunarDay, record.lunarLeap)} · 每年
                                    </Tag>
                                    : <Tag>{repeatLabel(record)}</Tag>}
                            </div>
                        </div>,
                    },
                    {
                        title: '下次发生', dataIndex: 'nextOccurrenceDate', width: 165,
                        render: (v, record) => {
                            if (!v) {
                                if (record.expired) return <Text type='secondary'>已结束</Text>
                                if (record.lunar) {
                                    return <Tooltip title='未来 400 天内没有对应的农历日期（闰月可能多年才出现一次）'>
                                        <Text type='secondary'>暂未排到</Text>
                                    </Tooltip>
                                }
                                return <Text type='secondary'>—</Text>
                            }
                            return <div>
                                <div>{v} <Text type='secondary'>{weekdayText(v)}</Text></div>
                                <Text type='secondary' style={{fontSize: 12}}>
                                    {record.remindAt || '09:00'} 提醒
                                </Text>
                            </div>
                        },
                    },
                    {
                        title: '倒计时', dataIndex: 'countdownDays', width: 90,
                        render: (v, record) => countdownView(v, record),
                    },
                    {
                        title: '提前提醒', dataIndex: 'remindOffsetsJson', width: 160,
                        render: (_, record) => offsetText(record),
                    },
                    {
                        title: '状态', dataIndex: 'status', width: 170,
                        render: (_, record) => (
                            <Space direction='vertical' size={2}>
                                <Space size={6}>
                                    {statusTag(record)}
                                    <Switch
                                        aria-label='启用提醒'
                                        checked={!!record.enabled}
                                        size='small'
                                        onChange={() => this.toggleEnabled(record)}
                                    />
                                </Space>
                                {record.lastSentAt
                                    ? <Text type='secondary' style={{fontSize: 11}}>
                                        上次 {dayjs(record.lastSentAt).format('MM-DD HH:mm')}
                                    </Text>
                                    : null}
                            </Space>
                        ),
                    },
                    {
                        title: '操作', dataIndex: 'option', width: 100,
                        render: (_, record) => (
                            <PermActions more visibleCount={1} actions={[
                                {label: '编辑', perm: 'reminder:edit', onClick: () => this.openEdit(record)},
                                {
                                    label: '立即检查', perm: 'reminder:edit',
                                    confirm: `立即检查「${record.title}」并按规则发送？`,
                                    onClick: () => this.scanOne(record),
                                },
                                {
                                    label: '删除', danger: true, perm: 'reminder:edit',
                                    confirm: `确定删除提醒「${record.title}」？`,
                                    onClick: () => this.deleteRecord(record),
                                },
                            ]}/>
                        ),
                    },
                ]}
            />

            <FormModal ref={this.modalRef} title={editing ? '编辑提醒' : '新建提醒'}
                       onFinish={this.handleSubmit}
                       onValuesChange={this.handleValuesChange}
                       labelCol={{flex: '96px'}} width={680}>
                <Form.Item label='标题' name='title' rules={[{required: true, message: '请输入标题'}]}>
                    <Input placeholder='例如：妈妈生日' maxLength={80}/>
                </Form.Item>
                <Form.Item label='备注' name='description'>
                    <Input.TextArea autoSize={{minRows: 2, maxRows: 4}} placeholder='备注（可选）'/>
                </Form.Item>
                <Form.Item label='历法' name='lunar' initialValue={false}>
                    <Radio.Group optionType='button' options={[
                        {value: false, label: '公历'},
                        {value: true, label: '农历'},
                    ]}/>
                </Form.Item>
                <Form.Item noStyle shouldUpdate={(prev, cur) => prev.lunar !== cur.lunar}>
                    {({getFieldValue}) => {
                        const lunar = !!getFieldValue('lunar')
                        if (lunar) {
                            return <>
                                <Form.Item label='农历日期' required>
                                    <Space wrap>
                                        <Form.Item name='lunarMonth' noStyle rules={[{required: true, message: '请选择月份'}]}>
                                            <Select style={{width: 110}} placeholder='月' options={LUNAR_MONTH_OPTIONS}/>
                                        </Form.Item>
                                        <Form.Item name='lunarDay' noStyle rules={[{required: true, message: '请选择日期'}]}>
                                            <Select style={{width: 110}} placeholder='日' options={LUNAR_DAY_OPTIONS}/>
                                        </Form.Item>
                                        <Form.Item name='lunarLeap' valuePropName='checked' noStyle>
                                            <Checkbox>闰月</Checkbox>
                                        </Form.Item>
                                    </Space>
                                </Form.Item>
                                <Form.Item noStyle shouldUpdate>
                                    {({getFieldValue: get}) => {
                                        const month = get('lunarMonth')
                                        const day = get('lunarDay')
                                        if (!month || !day) return null
                                        return <div style={{
                                            margin: '-8px 0 14px 96px',
                                            color: '#999',
                                            fontSize: 12,
                                        }}>
                                            即：农历{lunarText(month, day, !!get('lunarLeap'))}，每年自动换算当年公历日期
                                        </div>
                                    }}
                                </Form.Item>
                                <Form.Item label='重复方式'>
                                    <Text type='secondary'>每年（农历日期固定）</Text>
                                </Form.Item>
                            </>
                        }
                        return <>
                            <Form.Item label='事件日期' name='eventDate'
                                       rules={[{required: true, message: '请选择事件日期（生日/纪念日当天）'}]}>
                                <DatePicker style={{width: 200}} placeholder='选择日期'/>
                            </Form.Item>
                            <Form.Item label='重复方式' name='type'>
                                <Select allowClear placeholder='单次' options={TYPE_OPTIONS}/>
                            </Form.Item>
                        </>
                    }}
                </Form.Item>
                <Form.Item label='接下来'>
                    {preview.length
                        ? <div style={{
                            background: '#fafafa',
                            border: '1px solid #f0f0f0',
                            borderRadius: 6,
                            padding: '8px 12px',
                        }}>
                            {preview.map((item, index) => (
                                <div key={`${item.date}-${index}`} style={{
                                    fontSize: 12,
                                    color: index === 0 ? '#1677ff' : '#666',
                                    lineHeight: '22px',
                                }}>
                                    {previewText(item)}
                                </div>
                            ))}
                        </div>
                        : <Text type='secondary' style={{fontSize: 12}}>{previewHint}</Text>}
                </Form.Item>
                <Form.Item label='提醒时刻' name='remindAt'
                           rules={[{required: true, message: '请选择提醒时刻'}]}>
                    <TimePicker format='HH:mm' minuteStep={5} style={{width: 140}}/>
                </Form.Item>
                <Form.Item label='提前提醒' required>
                    <Form.Item noStyle shouldUpdate={(prev, cur) => prev.offsets !== cur.offsets}>
                        {({getFieldValue}) => {
                            const values = getFieldValue('offsets') || []
                            const extra = values
                                .filter(value => !OFFSET_OPTIONS.some(option => option.value === value))
                                .sort((a, b) => b - a)
                                .map(value => ({value, label: `提前 ${value} 天`}))
                            const options = [...extra, ...OFFSET_OPTIONS]
                            return <Form.Item name='offsets' noStyle
                                              rules={[{required: true, message: '请至少选择一个提前提醒时间'}]}>
                                <Checkbox.Group options={options}/>
                            </Form.Item>
                        }}
                    </Form.Item>
                    <Space style={{marginTop: 8}} wrap>
                        <InputNumber min={1} max={3650} precision={0} placeholder='自定义天数'
                                     value={customOffset}
                                     onChange={value => this.setState({customOffset: value})}
                                     style={{width: 120}}/>
                        <Button size='small' onClick={this.addCustomOffset} disabled={!customOffset}>
                            添加
                        </Button>
                        <Text type='secondary' style={{fontSize: 12}}>可多选；同一天只发一封</Text>
                    </Space>
                </Form.Item>
                <Form.Item label='启用' name='enabled' valuePropName='checked'>
                    <Switch/>
                </Form.Item>
            </FormModal>
        </Page>
    }
}
