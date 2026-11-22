package com.jt.workbench.modules.zsxq.repo;

import com.jt.workbench.modules.zsxq.entity.ZsxqTopic;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface ZsxqTopicRepository extends JpaRepository<ZsxqTopic, String> {

    /** 关键字匹配摘要，可按专栏过滤、只看星主 */
    @Query("""
            select t from ZsxqTopic t
            where (:keyword is null or lower(coalesce(t.digest, '')) like lower(concat('%', :keyword, '%')))
              and (:columnId is null or t.columnId = :columnId)
              and (:ownerOnly = false
                   or t.authorId = (select g.ownerId from ZsxqGroup g where g.id = t.groupId)
                   or t.author = (select g.owner from ZsxqGroup g where g.id = t.groupId))
            """)
    Page<ZsxqTopic> search(@Param("keyword") String keyword,
                           @Param("columnId") String columnId,
                           @Param("ownerOnly") boolean ownerOnly,
                           Pageable pageable);

    /** 同步幂等：按星球原始帖子 ID 查找 */
    java.util.Optional<ZsxqTopic> findByTopicId(String topicId);
}
