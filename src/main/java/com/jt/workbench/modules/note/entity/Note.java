package com.jt.workbench.modules.note.entity;

import io.github.jiangood.openadmin.framework.data.BaseEntity;
import jakarta.persistence.*;
import lombok.Data;

@Entity
@Table(name = "note")
@Data
public class Note extends BaseEntity {

    private String title;

    @Column(columnDefinition = "TEXT")
    private String content;

    private String folderId;

    private Integer readState = 0; // 0未读 1阅读中 2已读

    private Integer category; // 分类自由文本
}