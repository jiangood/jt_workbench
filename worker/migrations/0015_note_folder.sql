-- 0015 · 笔记目录树：note_folder 自关联（parent_id NULL = 根），note 增加 folder_id（NULL = 未分类）
-- 约定：时间 epoch 毫秒 INTEGER；索引单独 CREATE INDEX；迁移只做向后兼容的加表/加列

CREATE TABLE note_folder (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  parent_id INTEGER,              -- 父目录 id；NULL = 根目录
  sort INTEGER NOT NULL DEFAULT 0, -- 同级排序（当前按创建顺序，预留手工排序）
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_note_folder_parent ON note_folder (parent_id, sort);

ALTER TABLE note ADD COLUMN folder_id INTEGER; -- NULL = 未分类
CREATE INDEX idx_note_folder_id ON note (folder_id, updated_at);
