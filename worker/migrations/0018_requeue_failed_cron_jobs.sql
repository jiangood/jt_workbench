-- 修复：周期任务连续失败 3 次后被置为 failed，但此前没有任何路径把它改回 pending，
-- 订阅源 / 同步任务会永久停摆。Worker 侧已改为「失败后按 cron 续排」，这里把存量行放回队列。
-- 幂等：只动带 cron 的 failed 行；next_run_at=1 = 立即到期，下一次 poll 领取。
UPDATE job SET status = 'pending', attempts = 0, next_run_at = 1, lease_until = NULL
WHERE status = 'failed' AND cron IS NOT NULL;
