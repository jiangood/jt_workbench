-- 0008 · 管理员凭据入库：后台可改密 + 首次访问初始化
-- auth_state 仍是单行表；pwd_hash/pwd_salt 为空表示「D1 尚无凭据」，
-- 首次访问由 /api/setup 初始化（并发只有一个生效）——不依赖任何 Worker 环境变量/secret。
-- 改密时 password_changed_at 前移，撤销全部已签发 JWT。

ALTER TABLE auth_state ADD COLUMN username TEXT;
ALTER TABLE auth_state ADD COLUMN pwd_hash TEXT;
ALTER TABLE auth_state ADD COLUMN pwd_salt TEXT;
