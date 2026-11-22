package com.jt.workbench.modules.music.repo;

import com.jt.workbench.modules.music.entity.Music;
import org.springframework.data.domain.Sort;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.List;

public interface MusicRepository extends JpaRepository<Music, String> {

    /** 关键字匹配标题 / 艺术家 / 专辑，可按艺术家精确过滤 */
    @Query("""
            select m from Music m
            where (:keyword is null or lower(m.title) like lower(concat('%', :keyword, '%'))
                   or lower(coalesce(m.artist, '')) like lower(concat('%', :keyword, '%'))
                   or lower(coalesce(m.album, '')) like lower(concat('%', :keyword, '%')))
              and (:artist is null or m.artist = :artist)
            """)
    List<Music> search(@Param("keyword") String keyword,
                       @Param("artist") String artist,
                       Sort sort);

    @Query("select count(m) from Music m where m.artist is not null and m.artist <> ''")
    long countWithArtist();
}
