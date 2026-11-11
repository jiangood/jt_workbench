-- 0014 · 资讯已读状态（expand：只加列与索引）
-- 老数据统一标记为已读，避免发布后首页一次性冒出上千条未读；
-- 此后 agent 新插入的行不写该列 → 默认 0（未读）。

ALTER TABLE news_item ADD COLUMN read_flag INTEGER NOT NULL DEFAULT 0;
UPDATE news_item SET read_flag = 1;
CREATE INDEX idx_news_item_unread ON news_item (read_flag);
