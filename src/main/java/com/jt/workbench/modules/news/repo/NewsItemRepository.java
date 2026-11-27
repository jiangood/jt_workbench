package com.jt.workbench.modules.news.repo;

import com.jt.workbench.modules.news.entity.NewsItem;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.transaction.annotation.Transactional;

/** NewsItem 接口 */
public interface NewsItemRepository extends JpaRepository<NewsItem, String> {

    /** 列表：关键字 / 来源 / 状态都可选，按发布时间倒序 */
    @Query("""
            select n from NewsItem n
            where (:keyword is null or lower(n.title) like lower(concat('%', :keyword, '%'))
                   or lower(coalesce(n.content, '')) like lower(concat('%', :keyword, '%'))
                   or lower(coalesce(n.author, '')) like lower(concat('%', :keyword, '%')))
              and (:sourceId is null or n.sourceId = :sourceId)
              and (:status is null or n.status = :status)
            """)
    Page<NewsItem> search(@Param("keyword") String keyword,
                          @Param("sourceId") String sourceId,
                          @Param("status") String status,
                          Pageable pageable);

    /** 按外部ID查询（幂等校验） */
    @Query("select n from NewsItem n where n.externalId = :externalId")
    NewsItem findByExternalId(@Param("externalId") String externalId);

    long countByStatus(String status);

    /** 全部未读 → 已读 */
    @Modifying
    @Transactional
    @Query("update NewsItem n set n.status = 'read' where n.status = 'unread'")
    int markAllRead();

    /** 批量标记已读 */
    @Modifying
    @Transactional
    @Query("update NewsItem n set n.status = 'read' where n.id in :ids and n.status = 'unread'")
    int markReadByIds(@Param("ids") java.util.Collection<String> ids);

    /** 近 24 小时新增（pubTime 为北京墙钟，:since 同墙钟语义） */
    @Query("select count(n) from NewsItem n where n.pubTime >= :since")
    long countSince(@Param("since") java.time.LocalDateTime since);

    /** 删除标题或作者命中屏蔽词的资讯 */
    @Modifying
    @Transactional
    @Query("""
            delete from NewsItem n
            where lower(coalesce(n.title, '')) like lower(concat('%', :word, '%'))
               or lower(coalesce(n.author, '')) like lower(concat('%', :word, '%'))
            """)
    int deleteByBlockWord(@Param("word") String word);
}
