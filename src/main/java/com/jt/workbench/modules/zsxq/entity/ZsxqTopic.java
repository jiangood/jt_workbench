package com.jt.workbench.modules.zsxq.entity;

import io.github.jiangood.openadmin.framework.data.BaseEntity;
import jakarta.persistence.*;
import lombok.Data;

@Entity
@Table(name = "zsxq_topic")
@Data
public class ZsxqTopic extends BaseEntity {

    /** 摘要上限（同步作业对摘要的截断值，与列长一致） */
    public static final int DIGEST_MAX_LENGTH = 1900;

    @Column(length = DIGEST_MAX_LENGTH)
    private String digest;

    /** 话题作者（发帖人姓名，来自话题内容的 owner；历史帖子由同步作业逐步补齐） */
    private String author;

    /** 话题作者 ID（来自话题内容的 owner；用于“只看星主”按 ID 匹配） */
    private String authorId;

    private String lastCommentTime;

    private Integer commentCount;

    /** 附件信息JSON */
    @Column(length = 4096)
    private String attach;

    /**
     * 正文图片对象 key 列表（JSON 数组，元素形如 {@code zsxq-img/<sha1>.<ext>}）。
     *
     * <p>同步时把源图下载到对象存储后写入；空列表表示该帖没有图片，
     * {@code null} 表示尚未回填（由图片回填作业处理）。前端经 {@code admin/zsxq/image} 读取。</p>
     */
    @Lob
    private String images;

    /** 图片入对象存储完成时间（epoch 毫秒，null 表示待回填） */
    private Long imageSyncedAt;

    /** 图片回填失败次数（连续失败 3 次后不再自动重试） */
    private Integer imageFailCount = 0;

    /** 附件清单抓取完成时间（epoch 毫秒，null 表示尚未从星球接口确认过） */
    private Long fileSyncedAt;

    /** 附件清单抓取失败次数（历史帖子补齐清单时使用） */
    private Integer fileFailCount = 0;

    /** 封面：图片对象 key（新数据）或源站图片 URL（未回填的旧数据） */
    @Column(length = 2048)
    private String cover;

    private Boolean visible = true;

    /** 内容质量标识：DRY=干货，WATER=水帖，null=未标识 */
    @Column(length = 16)
    private String quality;

    /** 星球原始帖子 ID（同步幂等键） */
    private String topicId;

    /** 所属星球 ID */
    private String groupId;

    /** 所属专栏 ID（来自专栏同步；普通话题为空） */
    private String columnId;

    /** 专栏文章标题（普通话题为空） */
    @Column(length = 1024)
    private String articleTitle;

    /** 长文章原文地址（专栏文章同步/回填后写入；普通话题为空） */
    @Column(length = 1024)
    private String articleUrl;

    /** 专栏文章完整正文 HTML（普通话题为空；前端展示前经 DOMPurify 清洗） */
    @Lob
    private String articleContent;

    /** 专栏文章完整正文回填完成时间（epoch 毫秒，null 表示待回填） */
    private Long articleSyncedAt;

    /** 专栏文章回填失败次数（连续失败 3 次后不再自动重试） */
    private Integer articleFailCount = 0;

    /** 原始发帖时间（ISO 字符串，保留源值；不与 BaseEntity.createTime 冲突） */
    private String sourceCreateTime;

    private Integer likesCount;
}
