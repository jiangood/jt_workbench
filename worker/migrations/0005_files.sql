-- 0005 · 文件模块表（R2 本体；元数据在 D1；tag/epub 元数据由浏览器解析后随上传提交）

CREATE TABLE note (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  attachments TEXT NOT NULL DEFAULT '[]',  -- JSON [{key, filename, size, contentType}]
  updated_at INTEGER NOT NULL
);

CREATE TABLE music (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT,
  artist TEXT,
  album TEXT,
  r2_key TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_music_created ON music (created_at DESC);

CREATE TABLE book (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT,
  author TEXT,
  fmt TEXT NOT NULL,              -- epub / pdf
  r2_key TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_book_created ON book (created_at DESC);
