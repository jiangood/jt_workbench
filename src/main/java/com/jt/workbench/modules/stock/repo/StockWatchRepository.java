package com.jt.workbench.modules.stock.repo;

import com.jt.workbench.modules.stock.entity.StockWatch;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;

public interface StockWatchRepository extends JpaRepository<StockWatch, String> {

    @Query("select s from StockWatch s where s.code = ?1")
    StockWatch findByCodeNative(String code);

    Page<StockWatch> findByGroupName(String groupName, Pageable pageable);
}
