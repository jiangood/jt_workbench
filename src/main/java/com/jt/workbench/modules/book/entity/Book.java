package com.jt.workbench.modules.book.entity;

import io.github.jiangood.openadmin.framework.data.BaseEntity;
import jakarta.persistence.*;
import lombok.Data;

@Entity
@Table(name = "book")
@Data
public class Book extends BaseEntity {

    private String isbn;

    private String title;

    private String author;

    @Column(columnDefinition = "TEXT")
    private String summary;

    private String publisher;

    /** 出版年月（旧库自由文本，如 2013-10） */
    private String pubYear;

    private String coverUrl;

    private String format;

    private String status;

    private Integer progress;

    private Integer readMinutes;

    private String category;

    private String rating;

    /** 对象存储 key（中文文件名 URL 编码后可能超过 255） */
    @Column(length = 1024)
    private String r2Key;

    /** 原始文件名 */
    private String filename;

    /** 文件格式（epub 等；对应旧库 fmt） */
    private String fmt;

    /** 文件大小（字节） */
    private Long size;

    /** 源库创建时间（epoch 毫秒；不与 BaseEntity.createTime 冲突） */
    private Long sourceCreatedAt;

    // ---------- 豆瓣与阅读进度（旧库迁移保留） ----------

    private String doubanId;

    private String doubanUrl;

    /** 读完时间（epoch 毫秒） */
    private Long finishedAt;

    /** 最后阅读时间（epoch 毫秒） */
    private Long lastReadAt;

    /** EPUB 阅读位置（CFI，可能较长） */
    @Column(columnDefinition = "TEXT")
    private String readCfi;

    /** 阅读位置对应的文件版本（r2Key 中的 uuid），换文件后旧位置自动失效 */
    @Column(columnDefinition = "TEXT")
    private String readCfiVersion;
}