import {Spin} from 'antd'
import React from 'react'
import {HttpClient, history} from '@jiangood/open-admin'

export const pageMeta = {layout: 'blank', title: '书架'}

/** 书架入口：优先续读最近打开过的 EPUB，否则回到书架。 */
export default function BookEntry() {
    React.useEffect(() => {
        let cancelled = false

        HttpClient.get('admin/book/latest', null, {autoShowErrorMessage: false})
            .then(rs => {
                if (cancelled) return
                const id = rs?.data?.id
                history.replace(id ? `/book/read/${encodeURIComponent(id)}` : '/book/shelf')
            })
            .catch(() => {
                if (!cancelled) history.replace('/book/shelf')
            })

        return () => {
            cancelled = true
        }
    }, [])

    return <div style={{display: 'flex', minHeight: '100vh', alignItems: 'center', justifyContent: 'center'}}>
        <Spin size='large' tip='正在打开最近阅读…'>
            <div style={{width: 240, height: 120}}/>
        </Spin>
    </div>
}
