-- 0028 · 书架：预计阅读时长（分钟，上传 epub 时浏览器估算；旧书 / 无法估算为 NULL）
ALTER TABLE book ADD COLUMN read_minutes INTEGER;