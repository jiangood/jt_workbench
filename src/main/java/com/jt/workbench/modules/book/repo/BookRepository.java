package com.jt.workbench.modules.book.repo;

import com.jt.workbench.modules.book.entity.Book;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.transaction.annotation.Transactional;

public interface BookRepository extends JpaRepository<Book, String> {

    @Query("select b from Book b where b.isbn = :isbn")
    Book findByIsbn(@Param("isbn") String isbn);

    /** 关键字匹配书名 / 分类 / 出版社，可按阅读状态与分组（分类）过滤 */
    @Query("""
            select b from Book b
            where (:keyword is null or lower(b.title) like lower(concat('%', :keyword, '%'))
                   or lower(coalesce(b.publisher, '')) like lower(concat('%', :keyword, '%')))
              and (:status is null or b.status = :status)
              and (:category is null or b.category = :category)
            """)
    Page<Book> search(@Param("keyword") String keyword,
                      @Param("status") String status,
                      @Param("category") String category,
                      Pageable pageable);

    @Query("select distinct b.category from Book b where b.category is not null and b.category <> '' order by b.category")
    java.util.List<String> findCategories();

    /** 读书入口：最近阅读且已上传 EPUB 的书 */
    @Query("""
            select b from Book b
            where b.r2Key is not null and b.r2Key <> ''
              and b.lastReadAt is not null
            order by b.lastReadAt desc, b.updateTime desc
            """)
    Page<Book> findLatestRead(Pageable pageable);

    /** 书架顶部统计：按阅读状态计数（null 视为待读） */
    long countByStatus(String status);

    long countByStatusIsNull();

    // ---------- 阅读状态回写：批量 UPDATE 不触发 @LastModifiedDate，避免打乱书架按 updateTime 的排序 ----------

    /** 打开阅读器：刷新最近阅读时间，待读 → 阅读中 */
    @Modifying(clearAutomatically = true)
    @Transactional
    @Query("update Book b set b.lastReadAt = :ts, "
            + "b.status = case when b.status = 'unread' then 'reading' else b.status end "
            + "where b.id = :id")
    int markReading(@Param("id") String id, @Param("ts") long ts);

    /** 阅读进度（已读的书不再回写，避免已读徽标挂一条残留进度） */
    @Modifying(clearAutomatically = true)
    @Transactional
    @Query("update Book b set b.progress = :progress, b.lastReadAt = :ts "
            + "where b.id = :id and (b.status is null or b.status <> 'read')")
    int updateProgress(@Param("id") String id, @Param("progress") int progress, @Param("ts") long ts);

    /** 阅读位置与进度同一次 UPDATE 落库，避免两个请求乱序导致 CFI 与百分比不一致。 */
    @Modifying(clearAutomatically = true)
    @Transactional
    @Query("update Book b set b.readCfi = :cfi, b.readCfiVersion = :version, b.lastReadAt = :ts, "
            + "b.progress = case when b.status = 'read' then b.progress else :progress end, "
            + "b.status = case when b.status = 'unread' then 'reading' else b.status end "
            + "where b.id = :id")
    int updateReadingPosition(@Param("id") String id, @Param("cfi") String cfi,
                              @Param("version") String version, @Param("progress") int progress,
                              @Param("ts") long ts);
}
