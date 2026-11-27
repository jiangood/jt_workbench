package com.jt.workbench.modules.zsxq.entity;

import io.github.jiangood.openadmin.framework.data.BaseEntity;
import jakarta.persistence.*;
import lombok.Data;

/**
 * 知识星球话题附件元数据。
 *
 * <p>只存文件名/大小等元数据与对象存储 key；真正的文件内容由 {@code ZsxqFileService}
 * 按需下载到对象存储，{@code s3Key} 为空表示尚未入库。</p>
 */
@Entity
@Table(name = "zsxq_file", indexes = {
        @Index(name = "idx_zsxq_file_topic", columnList = "topic_id"),
        @Index(name = "idx_zsxq_file_group", columnList = "group_id")
}, uniqueConstraints = {
        @UniqueConstraint(name = "uk_zsxq_file_file_id", columnNames = "file_id")
})
@Data
public class ZsxqFile extends BaseEntity {

    /** 所属话题 ID */
    @Column(length = 64)
    private String topicId;

    /** 所属星球 ID */
    @Column(length = 64)
    private String groupId;

    /** 星球文件 ID（换取下载地址、去重的幂等键） */
    @Column(length = 64)
    private String fileId;

    /** 原始文件名（下载时作为 Content-Disposition 文件名） */
    @Column(length = 1024)
    private String name;

    /** 文件大小（字节；星球未返回时为空） */
    private Long fileSize;

    /** 内容类型（下载时按文件名/响应头识别） */
    @Column(length = 200)
    private String contentType;

    /** 对象存储 key；为空表示尚未下载入库 */
    @Column(length = 1024)
    private String s3Key;

    /** 连续下载失败次数（达到上限后不再自动重试，仍可手动点击下载） */
    private Integer failCount = 0;

    /** 星球原始文件创建时间（ISO 字符串） */
    @Column(length = 40)
    private String sourceCreateTime;
}
