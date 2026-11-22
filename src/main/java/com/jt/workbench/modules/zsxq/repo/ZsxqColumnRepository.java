package com.jt.workbench.modules.zsxq.repo;

import com.jt.workbench.modules.zsxq.entity.ZsxqColumn;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;

public interface ZsxqColumnRepository extends JpaRepository<ZsxqColumn, String> {

    /** 同步幂等：按星球原始专栏 ID 查找 */
    Optional<ZsxqColumn> findByColumnId(String columnId);

    List<ZsxqColumn> findByGroupIdOrderByName(String groupId);

    List<ZsxqColumn> findByVisibleTrueOrderByGroupIdAscNameAsc();

    long countByVisibleTrue();
}
