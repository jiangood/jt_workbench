-- 0035 · Agent 远程脚本执行协调（永久单 Agent、Cron 检查点、执行租约与恢复）
-- 所有时间均为 epoch 毫秒；脚本源码仍由 Worker Static Assets 发布，不存 D1。

CREATE TABLE agent_runtime_owner (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  node_id TEXT NOT NULL,
  claimed_at INTEGER NOT NULL
);

CREATE TABLE agent_script_state (
  script_id TEXT NOT NULL,
  schedule_revision TEXT NOT NULL,
  last_scheduled_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (script_id, schedule_revision)
);

CREATE TABLE agent_execution (
  execution_id TEXT PRIMARY KEY,
  script_id TEXT NOT NULL,
  script_version TEXT NOT NULL,
  script_sha256 TEXT NOT NULL,
  schedule_revision TEXT NOT NULL,
  scheduled_at INTEGER NOT NULL,
  trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('cron', 'catchup', 'startup')),
  reliability TEXT NOT NULL CHECK (reliability IN ('best_effort', 'reliable')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'interrupted', 'expired', 'needs_attention')),
  attempt INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 8,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER,
  lease_token TEXT,
  node_id TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  result_summary TEXT,
  last_error TEXT,
  last_report_id TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  updated_at INTEGER NOT NULL,
  UNIQUE (script_id, schedule_revision, scheduled_at)
);

CREATE INDEX idx_agent_execution_due
  ON agent_execution (status, next_attempt_at, created_at);
CREATE INDEX idx_agent_execution_lease
  ON agent_execution (status, lease_until);
CREATE INDEX idx_agent_execution_script_status
  ON agent_execution (script_id, status, created_at);
