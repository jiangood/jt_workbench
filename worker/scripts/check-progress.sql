SELECT
  (SELECT count(*) FROM news_item) AS items,
  (SELECT count(DISTINCT source_id) FROM news_item) AS sources,
  (SELECT count(*) FROM job WHERE type='rss_fetch' AND status='pending') AS pending,
  (SELECT count(*) FROM job WHERE type='rss_fetch' AND status='leased') AS leased,
  (SELECT count(*) FROM job WHERE type='rss_fetch' AND status='failed') AS failed;
