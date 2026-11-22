import React from 'react'
import {LeftOutlined, UnorderedListOutlined} from '@ant-design/icons'
import {Drawer, Dropdown, Empty, Spin} from 'antd'
import './SwipeReader.css'

/**
 * 通用滑动阅读区。
 *
 * 负责：顶栏、横向滑动翻页、进度条、左侧列表 Drawer、加载/空态/加载更多。
 * 数据获取、条目渲染、业务动作由调用方控制。
 */
export default class SwipeReader extends React.Component {
    state = {
        listOpen: false,
    }

    swipeRef = React.createRef()

    componentDidUpdate(prevProps) {
        if (prevProps.index !== this.props.index) {
            this.scrollToIndex(this.index, this.props.smoothScroll !== false)
        }
        if (prevProps.items !== this.props.items) {
            const max = Math.max(0, (this.props.items?.length || 0) - 1)
            if (this.index > max && max >= 0) this.props.onIndexChange?.(max)
        }
    }

    get index() {
        return Math.max(0, Number(this.props.index) || 0)
    }

    get items() {
        return Array.isArray(this.props.items) ? this.props.items : []
    }

    changeIndex = (index, smooth = true) => {
        const clamped = Math.max(0, Math.min(index, Math.max(0, this.items.length - 1)))
        this.scrollToIndex(clamped, smooth)
        if (clamped !== this.index) this.props.onIndexChange?.(clamped)
    }

    scrollToIndex = (index, smooth = true) => {
        const el = this.swipeRef.current
        if (!el) return
        const left = index * (el.clientWidth || 0)
        if (smooth && el.scrollTo) el.scrollTo({left, behavior: 'smooth'})
        else el.scrollLeft = left
    }

    onSwipeScroll = () => {
        const el = this.swipeRef.current
        if (!el) return
        const w = el.clientWidth || 1
        const rawIdx = Math.round(el.scrollLeft / w)
        const maxItemIdx = Math.max(0, this.items.length - 1)
        const clamped = Math.max(0, Math.min(rawIdx, maxItemIdx))
        if (clamped !== this.index) this.props.onIndexChange?.(clamped)
        if (this.props.hasMore && !this.props.loading && clamped >= this.items.length - 2) {
            this.props.onLoadMore?.()
        }
    }

    openList = () => this.setState({listOpen: true})
    closeList = () => this.setState({listOpen: false})

    render() {
        const {
            title, subtitle, badges = [], posText, progressPct = 0,
            onBack, moreItems, onMore, rightExtra,
            initialLoading, loading, hasMore, items,
            renderArticle, renderListItem,
            emptyDescription = '暂无内容',
            drawerTitle = '列表', drawerControls, drawerFooter,
            listEmptyDescription = '暂无内容',
        } = this.props
        const list = this.items
        const {listOpen} = this.state

        return <div className='swipe-reader-root'>
            <header className='swipe-reader-topbar'>
                <div className='swipe-reader-left'>
                    <button type='button' className='swipe-reader-iconbtn' onClick={onBack} aria-label='返回'>
                        <LeftOutlined />
                    </button>
                    <div className='swipe-reader-meta'>
                        <div className='swipe-reader-title'>{title}</div>
                        {subtitle ? <div className='swipe-reader-sub'>{subtitle}</div> : null}
                    </div>
                </div>
                <div className='swipe-reader-right'>
                    {badges.map((b, i) => <span key={i} className={`swipe-reader-badge${b.accent ? ' swipe-reader-badge-accent' : ''}`}>{b.text}</span>)}
                    {posText ? <span className='swipe-reader-pos'>{posText}</span> : null}
                    {rightExtra}
                    <button type='button' className='swipe-reader-iconbtn' onClick={this.openList} aria-label='列表'>
                        <UnorderedListOutlined />
                    </button>
                    {moreItems?.length ? <Dropdown menu={{items: moreItems, onClick: onMore}} trigger={['click']} placement='bottomRight'>
                        <button type='button' className='swipe-reader-iconbtn' aria-label='更多'>
                            {this.props.moreIcon || <span style={{fontSize: 18, lineHeight: 1}}>⋯</span>}
                        </button>
                    </Dropdown> : null}
                </div>
            </header>

            <div className='swipe-reader-stage'>
                {initialLoading ? (
                    <div className='swipe-reader-center'><Spin /></div>
                ) : list.length === 0 ? (
                    <div className='swipe-reader-center'>
                        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={emptyDescription} />
                    </div>
                ) : (
                    <div className='swipe-reader-track' ref={this.swipeRef} onScroll={this.onSwipeScroll}>
                        {list.map((item, idx) => <div className='swipe-reader-slide' key={item.id ?? idx}>
                            <article className='swipe-reader-article'>
                                {renderArticle(item, idx, idx === this.index)}
                            </article>
                        </div>)}
                        {hasMore || loading ? (
                            <div className='swipe-reader-slide'><div className='swipe-reader-center' style={{height: '100%'}}>{loading ? <Spin /> : null}</div></div>
                        ) : null}
                    </div>
                )}
            </div>

            <div className='swipe-reader-progress-line'>
                <div style={{width: `${Math.max(0, Math.min(100, progressPct))}%`}} />
            </div>

            <Drawer title={drawerTitle} placement='left' width={Math.min(typeof window !== 'undefined' ? window.innerWidth * 0.92 : 380, 420)}
                open={listOpen} onClose={this.closeList}
                styles={{body: {padding: '12px 12px 16px', display: 'flex', flexDirection: 'column', minHeight: 0}}}>
                {drawerControls ? <div className='swipe-reader-list-controls'>{drawerControls}</div> : null}
                <div className='swipe-reader-list'>
                    {initialLoading ? <div className='swipe-reader-center' style={{padding: 24}}><Spin size='small' /></div>
                        : list.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={listEmptyDescription} style={{marginTop: 24}} />
                        : list.map((item, idx) => renderListItem
                            ? renderListItem(item, idx, idx === this.index, () => { this.changeIndex(idx); this.closeList() })
                            : <button key={item.id ?? idx} type='button' className={`swipe-reader-list-item${idx === this.index ? ' active' : ''}`} onClick={() => { this.changeIndex(idx); this.closeList() }}>
                                <div className='swipe-reader-list-title'>{String(item.title || item.digest || '(无内容)')}</div>
                            </button>)}
                    {!initialLoading && hasMore ? <div className='swipe-reader-list-more'>{loading ? <Spin size='small' /> : '继续浏览可加载更多'}</div> : null}
                    {drawerFooter}
                </div>
            </Drawer>
        </div>
    }
}
