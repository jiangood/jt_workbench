-- 0019 · 读书 → 书架：分类 / 阅读状态 / 豆瓣索引
-- 1) r2_key / filename / size 放开 NOT NULL：允许先由豆瓣索引建条目、有文件后再上传
-- 2) 新增 category / status / cover / summary / rating / pub_year / douban_* 列
-- SQLite 改列约束需重建表；历史书目一律默认「待读」，由用户自行标记已读/阅读中。

CREATE TABLE book_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  author TEXT,
  category TEXT,                       -- 自由文本分类（NULL = 未分类）
  status TEXT NOT NULL DEFAULT 'unread' CHECK (status IN ('unread', 'reading', 'read')),
  cover TEXT,                          -- 豆瓣封面 URL（页面经 /api/book/cover 代理，规避防盗链）
  summary TEXT,
  rating REAL,
  pub_year TEXT,
  douban_id TEXT,
  douban_url TEXT,
  fmt TEXT,                            -- epub / pdf；NULL = 尚未上传文件
  r2_key TEXT UNIQUE,
  filename TEXT,
  size INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT 0,  -- 默认 0：Worker 回滚时旧 INSERT 不写该列也能成功
  finished_at INTEGER
);

INSERT INTO book_new (id, title, author, status, fmt, r2_key, filename, size, created_at, updated_at, finished_at)
  SELECT id, COALESCE(title, filename), author, 'unread', fmt, r2_key, filename, size, created_at, created_at, NULL FROM book;

DROP TABLE book;
ALTER TABLE book_new RENAME TO book;

CREATE INDEX idx_book_created ON book (created_at DESC);
CREATE INDEX idx_book_status ON book (status, updated_at DESC);
CREATE INDEX idx_book_category ON book (category);
CREATE UNIQUE INDEX idx_book_douban ON book (douban_id) WHERE douban_id IS NOT NULL;
