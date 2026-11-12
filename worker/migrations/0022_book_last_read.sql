-- 0022 · 书架「最近阅读」：阅读器打开 / 翻页回写进度时记录阅读时间，书架默认排序按它倒序
-- 可空：还没打开过的书（不参与置顶，按 id 排在后面）
-- expand：Worker 回滚后旧 INSERT / UPDATE 不写该列仍可成功

ALTER TABLE book ADD COLUMN last_read_at INTEGER;
