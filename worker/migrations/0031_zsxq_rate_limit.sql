-- 0031 · 知识星球采集降频 + 同域任务固定目标（配合同节点亲和调度）
-- 1059 为接口限流/瞬时错误：降低触发频率，target_key 交由 claim 时按类型补齐(api.zsxq.com)

UPDATE job
SET cron = '*/20 6-23 * * *'
WHERE type IN ('zsxq_backfill', 'zsxq_comments', 'zsxq_probe')
  AND cron = '*/10 6-23 * * *';

-- 已存在但尚未回填 target_key 的 zsxq 任务直接标记，便于立即命中同域亲和
UPDATE job
SET target_key = 'api.zsxq.com'
WHERE type IN ('zsxq_sync', 'zsxq_backfill', 'zsxq_comments', 'zsxq_probe', 'zsxq_groups')
  AND (target_key IS NULL OR target_key = '');
