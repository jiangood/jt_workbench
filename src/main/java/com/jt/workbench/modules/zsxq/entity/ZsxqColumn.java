package com.jt.workbench.modules.zsxq.entity;

import io.github.jiangood.openadmin.framework.data.BaseEntity;
import jakarta.persistence.*;
import lombok.Data;

/**
 * 知识星球专栏（星球内的文章合集）。
 *
 * <p>数据由「知识星球专栏同步」定时任务维护，源字段保留星球侧原值。</p>
 */
@Entity
@Table(name = "zsxq_column")
@Data
public class ZsxqColumn extends BaseEntity {

    /** 星球原始专栏 ID（同步幂等键） */
    @Column(unique = true)
    private String columnId;

    /** 所属星球 ID */
    private String groupId;

    @Column(length = 512)
    private String name;

    @Column(length = 2048)
    private String description;

    @Column(length = 2048)
    private String coverUrl;

    private Integer topicsCount;

    /** 专栏话题增量游标（最近一次同步到的话题发帖时间） */
    private String syncCursor;

    /** 最近同步时间（epoch 毫秒） */
    private Long lastSyncAt;

    private Boolean visible = true;
}
