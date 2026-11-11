SELECT id, type, status, node_id, lease_until, attempts, next_run_at, last_run_at, result FROM job;
SELECT count(*) AS spike_items FROM spike_item;
SELECT * FROM node_state;
SELECT * FROM tick_state;
