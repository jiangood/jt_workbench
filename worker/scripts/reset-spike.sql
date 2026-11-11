-- Spike 状态重置：任务回 pending 等待重测
UPDATE job SET status = 'pending', node_id = NULL, lease_until = NULL, attempts = 0,
  next_run_at = 1, last_run_at = NULL, result = NULL WHERE id = 1;
DELETE FROM spike_item;
