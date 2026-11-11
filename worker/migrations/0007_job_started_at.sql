-- 0007 · job.started_at：领取时刻（complete/fail 计算 ms 写 job_run）
ALTER TABLE job ADD COLUMN started_at INTEGER;
