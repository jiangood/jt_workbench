-- 0016 · 自选股分组：自由文本分组名（NULL = 未分组），下拉候选由现有股票去重派生
-- 与旧系统 wb_stock.group_name 语义一致（≤50 字符，不单独建分组表）

ALTER TABLE stock_watch ADD COLUMN group_name TEXT;
CREATE INDEX idx_stock_watch_group ON stock_watch (group_name, sort);
