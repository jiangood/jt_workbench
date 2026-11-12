-- 0023 · 修复定时抓取停摆（issue #16）+ 失败可见 / 单源熔断
--
-- 根因：Quartz 的 `?` 在 croner 8 里会被替换成「解析这一刻」的日期分量
--       （源码 parts[5].replace('?', initDate.getDay())）。`0 0 */2 * * ?` 的 `?` 在周位 →
--       变成「每周解析当天 0/2/4…22 点」，next_run_at 因此被排到 5 天后，11 小时无新资讯。
-- 处理：1) job 加 fail_streak（熔断计数）；2) 存量 Quartz cron 精确匹配改成标准 5 段；
--       3) type='rss_fetch' 的 next_run_at 重置为当前毫秒，发布后下一个 poll 立刻恢复抓取。
-- 顺序：先 ALTER 再加列后的 UPDATE（新列带 DEFAULT 0，存量行自动补 0）。
-- 可重复执行：UPDATE 都以旧值精确匹配，重跑不再命中；ALTER 由 wrangler migrations 表保证只跑一次。
-- 向后兼容（expand）：只加列 + 改数据，旧 Worker 不读 fail_streak，回滚不会炸。

ALTER TABLE job ADD COLUMN fail_streak INTEGER NOT NULL DEFAULT 0;

-- Quartz 6 段 → 标准 5 段（秒位只有 0，直接去掉；`?` 视为 `*`）
UPDATE job SET cron = '0 */2 * * *' WHERE cron = '0 0 */2 * * ?';            -- 资讯抓取：每 2 小时整点
UPDATE job SET cron = '20 * * * *' WHERE cron = '0 20 * * * ?';              -- 知识星球：每小时 20 分
UPDATE job SET cron = '35 15 * * MON-FRI' WHERE cron = '0 35 15 ? * MON-FRI'; -- 股票收盘：工作日 15:35

-- 发布后立刻恢复：所有资讯抓取任务立即到期（epoch 毫秒；leased 行会被 complete/fail 覆盖，无副作用）
UPDATE job SET next_run_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE type = 'rss_fetch';
