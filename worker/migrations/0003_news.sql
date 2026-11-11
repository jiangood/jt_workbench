-- 0003 · 资讯模块表（原 H2 wb_news_* 对应；正文原文入库，展示时浏览器端 DOMPurify 消毒）

CREATE TABLE news_source (
  id TEXT PRIMARY KEY,             -- wb-src-xxx
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'RSS',
  url TEXT NOT NULL,
  category TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE news_item (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL,
  external_id TEXT NOT NULL,       -- guid 或 link（幂等键：source_id + external_id 唯一）
  title TEXT,
  link TEXT,
  author TEXT,
  published_at INTEGER,
  content_html TEXT,               -- 原文入库
  fetched_at INTEGER NOT NULL,
  UNIQUE (source_id, external_id)
);
CREATE INDEX idx_news_item_feed ON news_item (source_id, published_at DESC);
CREATE INDEX idx_news_item_published ON news_item (published_at DESC);

CREATE TABLE news_block_word (    -- 屏蔽词（浏览器端过滤用）
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  keyword TEXT NOT NULL,
  source_id TEXT NOT NULL DEFAULT '',  -- '' = 全局
  enabled INTEGER NOT NULL DEFAULT 1
);
