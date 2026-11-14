-- 0033 · 知识星球评论失败退避
-- 失败帖子暂时退出评论对账队列；成功对账后清零并恢复正常轮转。
ALTER TABLE zsxq_topic ADD COLUMN comments_fail_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE zsxq_topic ADD COLUMN comments_retry_at INTEGER;
ALTER TABLE zsxq_topic ADD COLUMN comments_last_error TEXT;

CREATE INDEX idx_zsxq_topic_comments_retry
  ON zsxq_topic (group_id, deleted, comments_retry_at, comments_checked_at);
