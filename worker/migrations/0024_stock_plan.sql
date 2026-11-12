-- 0024 · 自选股计划价：入场价 / 重仓价（参考旧 stock-helper 的 entry / heavy）
-- 手工维护的交易计划价，页面展示与现价的偏差；NULL = 未设置
-- 语义：重仓价 < 入场价（重仓价高于入场价属于录入错误，接口拒绝）

ALTER TABLE stock_watch ADD COLUMN entry_price REAL;
ALTER TABLE stock_watch ADD COLUMN heavy_price REAL;
