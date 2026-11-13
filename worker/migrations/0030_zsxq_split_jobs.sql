-- 0030 · 知识星球任务拆分：按阶段 + 按星球分片（方案 2+3）
--
-- 将单一 zsxq_sync 拆为三类任务（每个启用星球各一条）：
--   zsxq_backfill  帖子增量/历史回溯（时间窗口切片：未完成时由 Worker 立即续跑下一片）
--   zsxq_comments  老帖评论对账（refresh 队列）
--   zsxq_probe     删除探测（check 队列）
-- 迁移幂等：已存在同类型同星球任务则跳过；旧 zsxq_sync 统一停用。
-- 向后兼容：仅新增/更新 job 行与数据，不改表结构。

-- 旧的单体同步任务停用（新任务接管）
UPDATE job SET enabled = 0, status = 'done', next_run_at = NULL
WHERE type = 'zsxq_sync';

-- 为当前启用的星球创建拆分后的任务（cron：每 10 分钟，排除 00:00-06:00，与 0029 一致）
INSERT INTO job (type, payload, cron, enabled, status, next_run_at)
SELECT 'zsxq_backfill',
       json_object('groupId', g.id, 'count', 20),
       '*/10 6-23 * * *',
       1,
       'pending',
       CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM zsxq_group g
WHERE g.enabled = 1
  AND NOT EXISTS (
    SELECT 1 FROM job j
    WHERE j.type = 'zsxq_backfill'
      AND json_extract(CASE WHEN json_valid(j.payload) THEN j.payload ELSE '{}' END, '$.groupId') = g.id
  );

INSERT INTO job (type, payload, cron, enabled, status, next_run_at)
SELECT 'zsxq_comments',
       json_object('groupId', g.id),
       '*/10 6-23 * * *',
       1,
       'pending',
       CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM zsxq_group g
WHERE g.enabled = 1
  AND NOT EXISTS (
    SELECT 1 FROM job j
    WHERE j.type = 'zsxq_comments'
      AND json_extract(CASE WHEN json_valid(j.payload) THEN j.payload ELSE '{}' END, '$.groupId') = g.id
  );

INSERT INTO job (type, payload, cron, enabled, status, next_run_at)
SELECT 'zsxq_probe',
       json_object('groupId', g.id),
       '*/10 6-23 * * *',
       1,
       'pending',
       CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM zsxq_group g
WHERE g.enabled = 1
  AND NOT EXISTS (
    SELECT 1 FROM job j
    WHERE j.type = 'zsxq_probe'
      AND json_extract(CASE WHEN json_valid(j.payload) THEN j.payload ELSE '{}' END, '$.groupId') = g.id
  );
