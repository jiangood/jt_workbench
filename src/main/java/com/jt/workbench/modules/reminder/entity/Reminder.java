package com.jt.workbench.modules.reminder.entity;

import io.github.jiangood.openadmin.framework.data.BaseEntity;
import jakarta.persistence.*;
import lombok.Data;

@Entity
@Table(name = "reminder")
@Data
public class Reminder extends BaseEntity {

    private String title;

    @Column(columnDefinition = "TEXT")
    private String description;

    private String type; // daily, weekly, monthly, yearly

    private Boolean lunar; // 是否农历

    /** 农历月（1-12，仅 lunar=true 且按年重复时使用） */
    private Integer lunarMonth;

    /** 农历日（1-30，仅 lunar=true 且按年重复时使用） */
    private Integer lunarDay;

    /** 是否闰月（仅 lunar=true 且按年重复时使用） */
    private Boolean lunarLeap;

    private Integer remindOffsets; // 提前天数（整数表示单一值，或用JSON表示列表）

    private String remindOffsetsJson; // JSON格式的提前天数列表

    private String remindAt; // 提醒时刻（HH:mm）

    /** 事件日期（公历锚点/参考日期；农历每年提醒时可作为展示或回退参考） */
    private java.time.LocalDate eventDate;

    /** 最近一次发送时间（epoch 毫秒），用于同一天不重复发送 */
    private Long lastSentAt;

    /** 最近一次发送失败原因 */
    @Column(columnDefinition = "TEXT")
    private String lastError;

    private Boolean enabled = true;
}