package com.jt.workbench.modules.zsxq.repo;

import com.jt.workbench.modules.zsxq.entity.ZsxqFile;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.Collection;
import java.util.List;
import java.util.Optional;

public interface ZsxqFileRepository extends JpaRepository<ZsxqFile, String> {

    Optional<ZsxqFile> findByFileId(String fileId);

    List<ZsxqFile> findByTopicIdIn(Collection<String> topicIds);

    List<ZsxqFile> findByGroupId(String groupId);

    /** 待下载入库的附件：从未失败的优先，其次按元数据时间从旧到新，避免老文件永远排队。 */
    @Query("select f from ZsxqFile f where (f.s3Key is null or f.s3Key = '') "
            + "and coalesce(f.failCount, 0) < :maxFails "
            + "order by coalesce(f.failCount, 0) asc, coalesce(f.sourceCreateTime, '') asc")
    List<ZsxqFile> findPending(@Param("maxFails") int maxFails, Pageable pageable);

    long countByGroupId(String groupId);
}
