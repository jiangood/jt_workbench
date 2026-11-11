-- 0020 · 音乐时长：上传时由浏览器 music-metadata 解析后随 query 提交，单位秒
-- 可空：老数据 / 解析失败时前端只显示「—」，不影响播放（expand：Worker 回滚后旧 INSERT 仍可写）

ALTER TABLE music ADD COLUMN duration INTEGER;
