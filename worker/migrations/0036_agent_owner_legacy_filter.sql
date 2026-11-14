-- 0036 · 仅由永久 owner 领取尚未迁移到远程脚本的 legacy job 类型
ALTER TABLE agent_runtime_owner
  ADD COLUMN remote_script_ids_json TEXT NOT NULL DEFAULT '[]';
