-- 0007 · 知识星球模块表（topics 同步；评论与附件懒获取列为 backlog；图片经 Worker 懒代理入 R2）

CREATE TABLE zsxq_group (
  id TEXT PRIMARY KEY,            -- group_id
  name TEXT,
  enabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE zsxq_topic (
  id TEXT PRIMARY KEY,            -- topic_id
  group_id TEXT NOT NULL,
  title TEXT,
  talk_text TEXT,
  images TEXT,                    -- JSON [{u, w, h}]
  files TEXT,                     -- JSON [{name, size}]
  create_time INTEGER,
  fetched_at INTEGER NOT NULL
);
CREATE INDEX idx_zsxq_topic_time ON zsxq_topic (group_id, create_time DESC);
