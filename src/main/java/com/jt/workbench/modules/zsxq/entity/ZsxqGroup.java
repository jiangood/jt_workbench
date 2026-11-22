package com.jt.workbench.modules.zsxq.entity;

import io.github.jiangood.openadmin.framework.data.BaseEntity;
import jakarta.persistence.*;
import lombok.Data;

@Entity
@Table(name = "zsxq_group")
@Data
public class ZsxqGroup extends BaseEntity {

    @Column(length = 1024)
    private String name;

    @Column(length = 2048)
    private String introduction;

    /** 星主 ID（用于“只看星主”过滤，优先按 ID 匹配） */
    private String ownerId;

    /** 星主昵称（历史数据回退按昵称匹配） */
    private String owner;

    @Column(length = 1024)
    private String logo;

    private Integer memberCount;

    private Boolean enabled = true;
}
