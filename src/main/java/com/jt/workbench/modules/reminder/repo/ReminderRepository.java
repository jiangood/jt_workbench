package com.jt.workbench.modules.reminder.repo;

import com.jt.workbench.modules.reminder.entity.Reminder;
import java.util.List;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface ReminderRepository extends JpaRepository<Reminder, String> {

    /** 关键字匹配标题 / 描述，可按类型、启用状态过滤。 */
    @Query("""
            select r from Reminder r
            where (:keyword is null or lower(r.title) like lower(concat('%', :keyword, '%'))
                   or lower(coalesce(r.description, '')) like lower(concat('%', :keyword, '%')))
              and (:type is null or r.type = :type)
              and (:enabled is null or r.enabled = :enabled)
            """)
    List<Reminder> searchAll(@Param("keyword") String keyword,
                             @Param("type") String type,
                             @Param("enabled") Boolean enabled);

    long countByEnabledTrue();

    /** 定时扫描用：全部启用提醒 */
    List<Reminder> findByEnabledTrue();
}
