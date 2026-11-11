-- 0004 · 提醒模块表（原 wb_reminder_* 对应；外发走 Resend 免费 100 封/天）

CREATE TABLE reminder (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  note TEXT,
  email TEXT NOT NULL,            -- 收件人
  remind_at INTEGER NOT NULL,     -- 下次提醒时间（epoch ms）
  repeat TEXT NOT NULL DEFAULT 'none' CHECK (repeat IN ('none', 'daily', 'weekly', 'monthly')),
  enabled INTEGER NOT NULL DEFAULT 1,
  last_sent_at INTEGER,
  last_error TEXT
);
CREATE INDEX idx_reminder_due ON reminder (enabled, remind_at);
