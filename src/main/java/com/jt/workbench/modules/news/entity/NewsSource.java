package com.jt.workbench.modules.news.entity;

import io.github.jiangood.openadmin.framework.data.BaseEntity;
import jakarta.persistence.*;
import lombok.Data;

/** 资讯来源 */
@Entity
@Table(name = "news_source")
@Data
public class NewsSource extends BaseEntity {

    private String name;

    private String url;

    private String type;

    private Boolean enabled = true;

    private String remark;
}