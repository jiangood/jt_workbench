package com.jt.workbench.modules.stock.entity;

import io.github.jiangood.openadmin.framework.data.BaseEntity;
import jakarta.persistence.*;
import lombok.Data;

@Entity
@Table(name = "stock_watch")
@Data
public class StockWatch extends BaseEntity {

    /** 证券代码，如 sh600000 / sz000001 / bj430047；为空表示待确认 */
    private String code;

    private String name;

    private String groupName;

    /** 入场价 */
    private Double entryPrice;

    /** 重仓价 */
    private Double heavyPrice;

    /** 止盈价 1 */
    private Double tp1;

    /** 止盈价 2 */
    private Double tp2;

    /** 年初价 */
    private Double yearInit;

    /** 昨日涨跌幅(%)，手工维护 */
    private Double prevChg;

    /** 更新日期，如 2026-03-05 */
    private String updDate;

    private Boolean enabled = true;
}