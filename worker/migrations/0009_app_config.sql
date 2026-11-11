-- 0009 · 参数中心：Worker 的可运维参数统一入库（决策 #23）
-- 取值：D1 为准；JWT 密钥缺失时随机生成并落库，其余为空即未配置。
-- 不再使用 wrangler secret：后台「参数与密钥」可查看 / 自定义 / 随机重置。
-- 键名与 core/config.ts 的 CONFIG_FIELDS 一一对应，新增参数只需改代码，无需再迁移。

CREATE TABLE app_config (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL DEFAULT 0
);
