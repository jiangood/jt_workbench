-- 0027 · 知识星球增量对账（issue #7 后续）
--
-- 1) 主题可能被删除：列表里消失 / 详情接口查不到时标记 deleted=1（软删除，正文与评论继续保留）
--    miss_count 连续缺失次数，>=2 才判定删除，避免接口偶发过滤导致误标；
--    checked_at = 上次详情探测时间，Worker 每轮按最久未探测轮流下发，保证老帖也能全量覆盖。
-- 2) 评论会持续新增：comments_checked_at = 上次评论对账时间，Worker 按最久未对账轮流下发，
--    列表页里看到 comments_count 变化的帖子仍会当轮立即补拉。
--
-- 纯加法（expand）：老代码的 INSERT / SELECT 不受影响，新列都有默认值。

ALTER TABLE zsxq_topic ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE zsxq_topic ADD COLUMN deleted_at INTEGER;
ALTER TABLE zsxq_topic ADD COLUMN miss_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE zsxq_topic ADD COLUMN last_missing_at INTEGER;
ALTER TABLE zsxq_topic ADD COLUMN checked_at INTEGER;
ALTER TABLE zsxq_topic ADD COLUMN comments_checked_at INTEGER;

-- 页面按状态筛选（正常 / 已删除）
CREATE INDEX idx_zsxq_topic_deleted ON zsxq_topic (deleted, create_time DESC);
-- 删除探测轮转：最久没探测的先来
CREATE INDEX idx_zsxq_topic_checked ON zsxq_topic (deleted, checked_at);
-- 评论对账轮转：最久没对账的先来
CREATE INDEX idx_zsxq_topic_comments_checked ON zsxq_topic (deleted, comments_checked_at);
