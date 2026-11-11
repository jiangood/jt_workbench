-- 0012 · 提醒收件箱改为全局参数：个人使用，所有提醒统一发到 app_config.reminder_to
-- 去掉逐条收件人列（避免每条都填同一个邮箱）；SQLite 改列约束需重建表，历史数据保留、旧 email 值丢弃。

CREATE TABLE reminder_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  note TEXT,
  remind_at INTEGER NOT NULL,     -- 下次提醒时间（epoch ms）
  repeat TEXT NOT NULL DEFAULT 'none' CHECK (repeat IN ('none', 'daily', 'weekly', 'monthly')),
  enabled INTEGER NOT NULL DEFAULT 1,
  last_sent_at INTEGER,
  last_error TEXT
);
INSERT INTO reminder_new (id, title, note, remind_at, repeat, enabled, last_sent_at, last_error)
  SELECT id, title, note, remind_at, repeat, enabled, last_sent_at, last_error FROM reminder;
DROP TABLE reminder;
ALTER TABLE reminder_new RENAME TO reminder;
CREATE INDEX idx_reminder_due ON reminder (enabled, remind_at);
