-- 0002 · Spike 用去重验证表（M3 会由业务表 news 取代；spike 结束后可弃置）
CREATE TABLE spike_item (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  title TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (source_id, external_id)
);
