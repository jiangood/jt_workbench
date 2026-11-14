-- 0034 · 知识星球任务合并：所有启用星球共用一条总任务，每 3 小时执行一次
--
-- 新总任务由 agent 在一次执行中依次完成评论对账、删除探测和帖子回溯。
-- 保留旧任务行及 job_run 历史，仅停用拆分任务，避免破坏历史记录。

UPDATE job
SET enabled = 0, status = CASE WHEN status = 'leased' THEN 'leased' ELSE 'done' END,
    next_run_at = NULL
WHERE type IN ('zsxq_backfill', 'zsxq_comments', 'zsxq_probe');

UPDATE job
SET payload = json_object(
      'groupIds', json(COALESCE((SELECT json_group_array(id) FROM zsxq_group WHERE enabled = 1), '[]')),
      'count', 20
    ),
    cron = '0 */3 * * *',
    enabled = CASE WHEN EXISTS (SELECT 1 FROM zsxq_group WHERE enabled = 1) THEN 1 ELSE 0 END,
    status = CASE WHEN EXISTS (SELECT 1 FROM zsxq_group WHERE enabled = 1) THEN 'pending' ELSE 'done' END,
    next_run_at = CASE
      WHEN EXISTS (SELECT 1 FROM zsxq_group WHERE enabled = 1)
      THEN CAST(strftime('%s', 'now') AS INTEGER) * 1000
      ELSE NULL
    END
WHERE type = 'zsxq_sync';

INSERT INTO job (type, payload, cron, enabled, status, next_run_at)
SELECT
  'zsxq_sync',
  json_object(
    'groupIds', json(COALESCE((SELECT json_group_array(id) FROM zsxq_group WHERE enabled = 1), '[]')),
    'count', 20
  ),
  '0 */3 * * *',
  CASE WHEN EXISTS (SELECT 1 FROM zsxq_group WHERE enabled = 1) THEN 1 ELSE 0 END,
  CASE WHEN EXISTS (SELECT 1 FROM zsxq_group WHERE enabled = 1) THEN 'pending' ELSE 'done' END,
  CASE
    WHEN EXISTS (SELECT 1 FROM zsxq_group WHERE enabled = 1)
    THEN CAST(strftime('%s', 'now') AS INTEGER) * 1000
    ELSE NULL
  END
WHERE NOT EXISTS (SELECT 1 FROM job WHERE type = 'zsxq_sync');
