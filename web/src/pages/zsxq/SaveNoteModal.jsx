import React from 'react'
import {Form, Input, Modal, Select, message} from 'antd'
import {HttpClient, history} from '@jiangood/open-admin'
import {zsxqPlainText} from './richText'

function defaultTitle(topic) {
    const text = topic?.articleTitle || zsxqPlainText(topic?.digest || '')
    const line = String(text).split(/\n/).map(s => s.trim()).find(Boolean)
    if (line) return line.slice(0, 120)
    const today = new Date().toISOString().slice(0, 10)
    return `知识星球笔记 ${today}`
}

/** 知识星球话题 -> 笔记：确认标题与目录后交给后端复制正文、图片和附件 */
export default class SaveNoteModal extends React.Component {

    state = {
        folders: [],
        saving: false,
    }

    formRef = React.createRef()
    foldersLoaded = false

    componentDidUpdate(prevProps) {
        const opened = this.props.open && !prevProps.open
        const switched = this.props.open && prevProps.open
            && (prevProps.topic?.id !== this.props.topic?.id)
        if (!opened && !switched) return

        this.formRef.current?.setFieldsValue({
            title: defaultTitle(this.props.topic),
            folderId: undefined,
        })
        if (!this.foldersLoaded) this.loadFolders()
    }

    loadFolders = () => {
        this.foldersLoaded = true
        HttpClient.get('admin/note/folders', null, {autoShowErrorMessage: false}).then(rs => {
            this.setState({folders: rs.data || []})
        }).catch(() => {})
    }

    handleOk = async () => {
        const topic = this.props.topic
        if (!topic?.id) return
        let values
        try {
            values = await this.formRef.current?.validateFields()
        } catch {
            return
        }
        this.setState({saving: true})
        try {
            const rs = await HttpClient.post('admin/zsxq/note', {
                id: topic.id,
                title: values.title,
                folderId: values.folderId,
            })
            const note = rs.data
            this.props.onCancel?.()
            if (note?.id) {
                Modal.success({
                    title: '已转为笔记',
                    content: '正文、图片与附件已保存到笔记，可在「笔记」中查看和继续编辑。',
                    okText: '打开笔记',
                    onOk: () => history.push(`/note/view?id=${encodeURIComponent(note.id)}`),
                })
            } else {
                message.success('已转为笔记')
            }
        } catch {
            // HttpClient 已提示错误
        } finally {
            this.setState({saving: false})
        }
    }

    render() {
        const {open, topic, onCancel} = this.props
        const {folders, saving} = this.state
        const folderOptions = [...folders]
            .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0) || String(a.name).localeCompare(String(b.name)))
            .map(folder => ({label: folder.name, value: folder.id}))

        return <Modal
            title='转为笔记'
            open={open}
            onCancel={onCancel}
            onOk={this.handleOk}
            okText='保存笔记'
            confirmLoading={saving}
            destroyOnHidden
        >
            <Form ref={this.formRef} layout='vertical' preserve={false}>
                <Form.Item label='标题' name='title' rules={[{required: true, message: '请输入标题'}]}>
                    <Input placeholder='笔记标题' maxLength={200}/>
                </Form.Item>
                <Form.Item label='目录' name='folderId'>
                    <Select allowClear placeholder='未分类' options={folderOptions}/>
                </Form.Item>
            </Form>
            <div style={{color: 'var(--oa-color-text-secondary, #8c8c8c)', fontSize: 12, lineHeight: 1.7}}>
                正文会保留原帖排版与图片；话题附件会复制到笔记文件库。同一帖子再次转换会直接打开已有笔记。
            </div>
        </Modal>
    }
}
