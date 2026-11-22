package com.jt.workbench.modules.news.repo;

import com.jt.workbench.modules.news.entity.NewsBlockWord;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;

/** NewsBlockWord 接口 */
public interface NewsBlockWordRepository extends JpaRepository<NewsBlockWord, String> {

    List<NewsBlockWord> findByEnabledTrue();
}