-- 0026 · 跨节点调度（issue #4）：任务目标标识 + 「目标 × 节点」评分
--
-- 同一个站点在不同节点上的可达性可能不同（A 站节点 1 常超时、节点 2 正常）。
-- 给 rss_fetch 任务补 target_key（规范化域名），并记录每个节点对该目标的评分：
--   初始 50；抓取成功 +5；网络类失败 -30；钳制在 [-1, 100]。
-- 派单时优先给该目标评分最高的在线节点；低分节点在冷却窗口内被跳过。
-- 纯加法：老任务 target_key 为 NULL 时，首次领取由 Worker 从 payload.url 推导并回填。

ALTER TABLE job ADD COLUMN target_key TEXT;
CREATE INDEX idx_job_target ON job (target_key, status);

CREATE TABLE node_target_score (
  target_key TEXT NOT NULL,      -- 规范化目标（域名，如 example.com）
  node_id TEXT NOT NULL,
  score INTEGER NOT NULL DEFAULT 50,
  cooldown_until INTEGER,        -- 网络类失败后的临时避让截止（毫秒）；NULL = 无冷却
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (target_key, node_id)
);
-- 派单只按 target_key 查「哪个节点分最高」
CREATE INDEX idx_node_target_score_target ON node_target_score (target_key, score DESC);
