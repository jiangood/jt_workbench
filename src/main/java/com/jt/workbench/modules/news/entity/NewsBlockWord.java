package com.jt.workbench.modules.news.entity;

import io.github.jiangood.openadmin.framework.data.BaseEntity;
import jakarta.persistence.*;
import lombok.Data;

/** 屏蔽词 */
@Entity
@Table(name = "news_block_word")
@Data
public class NewsBlockWord extends BaseEntity {

    private String word;

    private Boolean enabled = true;
}