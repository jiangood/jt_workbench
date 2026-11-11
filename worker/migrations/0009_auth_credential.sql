-- 0009 · 管理员凭据入库：后台可改密 + 首次访问初始化
-- auth_state 仍是单行表；pwd_hash/pwd_salt 为空表示「D1 尚无凭据」，
-- 登录会退回 wrangler secret 引导（老部署），首次成功后自动写入这三列。
-- 改密时 password_changed_at 前移，撤销全部已签发 JWT。

ALTER TABLE auth_state ADD COLUMN username TEXT;
ALTER TABLE auth_state ADD COLUMN pwd_hash TEXT;
ALTER TABLE auth_state ADD COLUMN pwd_salt TEXT;
