-- 0011 · 待认领节点（v4.12）：点「添加节点」只生成 10 分钟有效的待认领凭据，节点列表不显示；
-- agent 首次用该密钥 poll 时自动写入 node_registry（这才是第一笔节点记录），页面轮询到后提示安装成功。
-- 过期凭据由后续「添加节点」顺带清理，也可忽略（鉴权按 expires_at 过滤）。

CREATE TABLE node_claim (
  node_key TEXT PRIMARY KEY,
  node_id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_node_claim_expiry ON node_claim (expires_at);
