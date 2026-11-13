-- 0032 · TTS 语音合成缓存（Piper 开源 TTS，按段落缓存到 R2）
-- 向后兼容：只加表，不改既有结构。

CREATE TABLE IF NOT EXISTS tts_segment (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL,
  segment_key TEXT NOT NULL,
  voice TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE (book_id, segment_key, voice)
);

CREATE INDEX IF NOT EXISTS idx_tts_segment_book ON tts_segment(book_id);
