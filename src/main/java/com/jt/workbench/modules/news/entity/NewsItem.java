package com.jt.workbench.modules.news.entity;

import io.github.jiangood.openadmin.framework.data.BaseEntity;
import jakarta.persistence.*;
import lombok.Data;

/** 资讯条目 */
@Entity
@Table(name = "news_item")
@Data
public class NewsItem extends BaseEntity {

    private String title;

    @Column(columnDefinition = "TEXT")
    private String content;

    private String author;

    private String sourceId;

    private String externalId;

    private String status = "unread";

    /** AI 摘要（一到两句话，由定时任务调用 OpenAI-compatible 接口生成；null=未生成，空串=无可摘要内容） */
    @Column(name = "ai_summary", columnDefinition = "TEXT")
    private String summary;

    /** 发布时间（北京墙钟；pub_time 列为 TIMESTAMP(6) WITH TIME ZONE，按会话时区 Asia/Shanghai 读写） */
    private java.time.LocalDateTime pubTime;

    private Boolean top = false;

    private String tags;
}