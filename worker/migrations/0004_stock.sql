-- 0004 · 股票模块表（原 wb_stock_* 对应；盘中行情砍掉，现价页打开实时拉）

CREATE TABLE stock_watch (        -- 自选股
  code TEXT PRIMARY KEY,          -- sh600000 / sz000001 / bj430047
  name TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE stock_daily (        -- 日线（收盘同步落库）
  code TEXT NOT NULL,
  trade_date TEXT NOT NULL,       -- YYYY-MM-DD（行情源提供）
  open REAL, high REAL, low REAL, close REAL,
  volume REAL,                    -- 股
  fetched_at INTEGER NOT NULL,
  UNIQUE (code, trade_date)
);
CREATE INDEX idx_stock_daily ON stock_daily (code, trade_date DESC);
