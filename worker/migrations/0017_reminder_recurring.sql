-- 0017 · 提醒升级：每年重复 / 农历 / 多个提前天数
-- 1) repeat 增加 yearly（SQLite 改 CHECK 必须重建表，沿用 0012 的做法）
-- 2) anchor_at：规则锚点（原始事件时刻），年/月递推用它保住 2/29、每月 31 号
-- 3) event_at：本轮事件发生时刻（农历是换算后的公历时刻）；旧行回填 remind_at
-- 4) calendar_type / lunar_month / lunar_day / lunar_leap：农历生日（仅每年）
-- 5) remind_offsets：降序逗号分隔的提前天数，0 = 当天，如 30,7,1,0
--
-- 发布窗口兼容：新列都可空或带默认值，迁移完成到新 Worker 上线之间旧 Worker 仍能 INSERT。

CREATE TABLE reminder_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  note TEXT,
  calendar_type TEXT NOT NULL DEFAULT 'solar' CHECK (calendar_type IN ('solar', 'lunar')),
  lunar_month INTEGER,
  lunar_day INTEGER,
  lunar_leap INTEGER NOT NULL DEFAULT 0,
  anchor_at INTEGER,
  event_at INTEGER,
  remind_at INTEGER NOT NULL,
  remind_offsets TEXT NOT NULL DEFAULT '0',
  repeat TEXT NOT NULL DEFAULT 'none' CHECK (repeat IN ('none', 'daily', 'weekly', 'monthly', 'yearly')),
  enabled INTEGER NOT NULL DEFAULT 1,
  last_sent_at INTEGER,
  last_error TEXT
);

INSERT INTO reminder_new (
  id, title, note, calendar_type, anchor_at, event_at,
  remind_at, remind_offsets, repeat, enabled, last_sent_at, last_error
)
SELECT
  id, title, note, 'solar', remind_at, remind_at,
  remind_at, '0', repeat, enabled, last_sent_at, last_error
FROM reminder;

DROP TABLE reminder;
ALTER TABLE reminder_new RENAME TO reminder;
CREATE INDEX idx_reminder_due ON reminder (enabled, remind_at);
