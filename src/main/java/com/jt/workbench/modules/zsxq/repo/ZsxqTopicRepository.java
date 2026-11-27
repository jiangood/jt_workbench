package com.jt.workbench.modules.zsxq.repo;

import com.jt.workbench.modules.zsxq.entity.ZsxqTopic;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface ZsxqTopicRepository extends JpaRepository<ZsxqTopic, String> {

    /**
     * 关键字匹配摘要、标题和专栏正文，可按专栏过滤、只看星主、按质量标识过滤。
     *
     * <p>不指定 {@code columnId} 时只返回星球话题，排除归档到专栏的文章
     * （专栏内容只在专栏页展示，避免混入主信息流）。</p>
     *
     * <p>正文列映射为 CLOB，需先转换为字符串再调用 {@code lower()}；
     * 否则 Hibernate 7 会在启动校验仓库查询时因参数类型不匹配而失败。</p>
     */
    @Query("""
            select t from ZsxqTopic t
            where (:keyword is null
                   or lower(coalesce(t.digest, '')) like lower(concat('%', :keyword, '%'))
                   or lower(coalesce(t.articleTitle, '')) like lower(concat('%', :keyword, '%'))
                   or lower(cast(coalesce(t.articleContent, '') as string)) like lower(concat('%', :keyword, '%')))
              and (:columnId is null or t.columnId = :columnId)
              and (:columnId is not null or t.columnId is null or t.columnId = '')
              and (:ownerOnly = false
                   or t.authorId = (select g.ownerId from ZsxqGroup g where g.id = t.groupId)
                   or t.author = (select g.owner from ZsxqGroup g where g.id = t.groupId))
              and (:quality is null
                   or (:quality = 'NONE' and (t.quality is null or t.quality = ''))
                   or (:quality <> 'NONE' and t.quality = :quality))
            """)
    Page<ZsxqTopic> search(@Param("keyword") String keyword,
                           @Param("columnId") String columnId,
                           @Param("ownerOnly") boolean ownerOnly,
                           @Param("quality") String quality,
                           Pageable pageable);

    /** 星球话题（不含专栏文章）分页：首页卡片等只读展示用。 */
    @Query("select t from ZsxqTopic t where t.columnId is null or t.columnId = ''")
    Page<ZsxqTopic> findMainTopics(Pageable pageable);

    /** 星球话题（不含专栏文章）总数。 */
    @Query("select count(t) from ZsxqTopic t where t.columnId is null or t.columnId = ''")
    long countMainTopics();

    /** 同步幂等：按星球原始帖子 ID 查找 */
    java.util.Optional<ZsxqTopic> findByTopicId(String topicId);
}
