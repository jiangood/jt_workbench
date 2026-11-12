-- 0025 · 知识星球全量采集（issue #7）：帖子补作者/星主/计数，新增评论、附件、同步游标三张表
--
-- 只做加法（expand）：旧列一个都不动，Worker 回滚后老代码的 INSERT/SELECT 照样能跑；
-- 新增列要么可空，要么带默认值，老 agent 回传的 items（没有 kind / authorId / isOwner 等字段）仍可入库。
-- 迁移由 wrangler d1 migrations 记录，只 apply 一次（ALTER 不能重复执行，所以没有 IF NOT EXISTS）。

-- 帖子：作者身份 + 星主标记 + 互动计数（评论/附件懒抓的判定依据）
ALTER TABLE zsxq_topic ADD COLUMN author_id TEXT;
ALTER TABLE zsxq_topic ADD COLUMN author_name TEXT;
ALTER TABLE zsxq_topic ADD COLUMN is_owner INTEGER NOT NULL DEFAULT 0;
ALTER TABLE zsxq_topic ADD COLUMN comments_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE zsxq_topic ADD COLUMN likes_count INTEGER NOT NULL DEFAULT 0;

-- 评论：只存帖子正文下的评论（回复链暂不展开），按 topic_id 聚合展示
CREATE TABLE zsxq_comment (
  id TEXT PRIMARY KEY,             -- comment_id
  topic_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  author_id TEXT,
  author_name TEXT,
  is_owner INTEGER NOT NULL DEFAULT 0,
  text TEXT,
  images TEXT,                     -- JSON [{u, w, h}]
  create_time INTEGER,
  fetched_at INTEGER NOT NULL
);
CREATE INDEX idx_zsxq_comment_topic ON zsxq_comment (topic_id, create_time);

-- 附件（星球文件）：帖子附件 topic_id 有值、comment_id 为空；评论附件两者都有
-- r2_key / backup_status 由备份任务维护，ingest 只认领归属，不覆盖这两列
CREATE TABLE zsxq_file (
  id TEXT PRIMARY KEY,             -- file_id
  topic_id TEXT,
  comment_id TEXT,
  group_id TEXT,
  name TEXT,
  size INTEGER,
  is_owner INTEGER NOT NULL DEFAULT 0,
  r2_key TEXT,
  backup_status TEXT,
  error TEXT,
  create_time INTEGER,
  fetched_at INTEGER NOT NULL
);
CREATE INDEX idx_zsxq_file_topic ON zsxq_file (topic_id);
CREATE INDEX idx_zsxq_file_backup ON zsxq_file (is_owner, backup_status);

-- 全量回溯游标：每个星球一行；cursor = 已回溯到的最老 create_time（下一轮的 end_time）
-- done=1 表示已回溯到历史尽头，此后每轮只扫首页找新帖
CREATE TABLE zsxq_sync_state (
  group_id TEXT PRIMARY KEY,
  cursor TEXT,
  done INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  updated_at INTEGER NOT NULL
);
