-- 0001 · 调度与状态基础设施表（方案「任务表设计 + 节点协议」节，v4.10）
-- 约定：时间 epoch 毫秒 INTEGER；索引单独 CREATE INDEX

CREATE TABLE job (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,             -- 节点任务: rss_fetch / stock_eod / zsxq_sync / http_json_sync / html_extract
  payload TEXT,                   -- 参数 JSON（如 {"sourceId": 3}）
  cron TEXT,                      -- Quartz 风格原样沿用，Worker 侧 croner 解析
  enabled INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'leased', 'done', 'failed')),
  lease_until INTEGER,            -- 心跳续约；过期即节点死亡，任务回 pending
  node_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  result TEXT,                    -- 最近一次结果摘要 + lastError
  next_run_at INTEGER,            -- last_run_at + croner.next() 推进；停机向前跳
  last_run_at INTEGER
);
CREATE INDEX idx_job_due ON job (status, next_run_at);
CREATE INDEX idx_job_lease ON job (lease_until);

CREATE TABLE job_run (            -- 运行历史（替代原 SysJobLog；保留 90 天，过期清理顺带删）
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  message TEXT,
  ms INTEGER,
  run_at INTEGER NOT NULL,
  node_id TEXT,
  agent_version TEXT              -- 版本漂移在运维页面可见
);
CREATE INDEX idx_job_run_job ON job_run (job_id, run_at);
CREATE INDEX idx_job_run_expiry ON job_run (run_at);

CREATE TABLE auth_state (         -- 登录撤销（单行表，id 固定 1）
  id INTEGER PRIMARY KEY CHECK (id = 1),
  password_changed_at INTEGER     -- JWT iat（秒）早于它（毫秒，比较前统一单位）即 401
);

CREATE TABLE cache (              -- 通用 TTL 缓存（行情现价/历史K线/搜索）
  k TEXT PRIMARY KEY,
  v TEXT,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_cache_exp ON cache (expires_at);

CREATE TABLE tick_state (         -- poll 限频锁（单行表；窗口 10min，只护内置任务）
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_tick_at INTEGER
);
INSERT INTO tick_state (id, last_tick_at) VALUES (1, 0);

CREATE TABLE node_state (         -- 节点心跳（每节点一行，poll upsert；离线判定 30min）
  node_id TEXT PRIMARY KEY,
  agent_version TEXT,
  last_seen_at INTEGER NOT NULL
);
