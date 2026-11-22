package com.jt.workbench.modules.news.repo;

import com.jt.workbench.modules.news.entity.NewsSource;
import org.springframework.data.jpa.repository.JpaRepository;

/** NewsSource 接口 */
public interface NewsSourceRepository extends JpaRepository<NewsSource, String> {}