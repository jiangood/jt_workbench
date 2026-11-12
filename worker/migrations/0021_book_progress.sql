-- 0021 · 书架阅读进度：epub / txt 阅读器回写 0–100 的百分比，书架卡片底部显示进度条
-- 可空：老书目 / 还没读过的书（0 也不显示）；pdf 走浏览器原生查看器拿不到页码，不回写
-- expand：Worker 回滚后旧 INSERT 不写该列仍可成功

ALTER TABLE book ADD COLUMN progress INTEGER;
