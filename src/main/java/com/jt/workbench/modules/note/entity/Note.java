package com.jt.workbench.modules.note.entity;

import io.github.jiangood.openadmin.framework.data.BaseEntity;
import io.github.jiangood.openadmin.framework.file.FileField;
import jakarta.persistence.*;
import lombok.Data;

import java.util.List;

@Entity
@Table(name = "note")
@Data
public class Note extends BaseEntity {

    private String title;

    /** 纯文本正文：由富文本派生，用于列表预览与关键字搜索 */
    @Column(columnDefinition = "TEXT")
    private String content;

    /** 富文本正文（HTML）；其中引用的图片会由框架标记为笔记关联文件 */
    @Lob
    @FileField(html = true)
    private String contentHtml;

    /** 附件：逗号分隔的 objectName 列表（框架 FieldUploadFile 约定） */
    @Lob
    @FileField
    private String attachments;

    private String folderId;

    private Integer readState = 0; // 0未读 1阅读中 2已读

    private Integer category; // 分类自由文本

    /** 来源类型：目前仅 zsxq（由知识星球话题转来的笔记），手工新建为空 */
    private String sourceType;

    /** 来源话题 ID，用于避免同一帖子重复转笔记 */
    private String sourceTopicId;

    /** 来源链接（原文地址） */
    @Column(length = 1024)
    private String sourceUrl;

    /** 详情展示用：目录名称（不落库） */
    @Transient
    private String folderName;

    /** 详情展示用：附件元数据（不落库） */
    @Transient
    private List<NoteAttachment> attachmentFiles;
}