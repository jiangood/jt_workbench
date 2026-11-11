-- 0010 · 节点登记表（v4.12）：密钥由后台生成，经一键安装脚本写进 compose；
-- agent 首次 poll 消费 node_claim 后写入本表（列表只显示已认领节点）。
-- 节点身份唯一来源：x-node-key → 本表 node_id（鉴权等值查询走唯一索引）。

CREATE TABLE node_registry (
  node_id TEXT PRIMARY KEY,
  node_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_node_registry_key ON node_registry (node_key);
