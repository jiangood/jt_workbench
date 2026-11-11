-- Spike 测试任务：立即到期、每 10 分钟粒度（Quartz 风格）
INSERT INTO job (type, payload, cron, enabled, status, next_run_at)
VALUES ('http_json_sync', '{"url":"https://example.com/api","itemsPath":"items"}', '0 */10 * * * ?', 1, 'pending', 1);
