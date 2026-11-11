SELECT j.id, s.name AS source, j.status, j.attempts, j.result, j.next_run_at
FROM job j LEFT JOIN news_source s ON j.payload LIKE '%' || s.id || '%'
WHERE j.type = 'rss_fetch' ORDER BY j.id;
SELECT count(*) AS total_items, count(DISTINCT source_id) AS sources FROM news_item;
