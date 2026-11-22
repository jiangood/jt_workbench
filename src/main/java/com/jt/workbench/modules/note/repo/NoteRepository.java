package com.jt.workbench.modules.note.repo;

import com.jt.workbench.modules.note.entity.Note;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface NoteRepository extends JpaRepository<Note, String> {

    /** 按目录分页（目录页） */
    @Query("select n from Note n where n.folderId = :folderId order by n.updateTime desc")
    Page<Note> pageByFolder(@Param("folderId") String folderId, Pageable pageable);

    /** 未分类（folder_id 为空） */
    @Query("select n from Note n where n.folderId is null order by n.updateTime desc")
    Page<Note> pageUnfiled(Pageable pageable);

    /** 标题 / 正文关键字搜索 */
    @Query("select n from Note n where n.title like %:keyword% or n.content like %:keyword% order by n.updateTime desc")
    Page<Note> pageByKeyword(@Param("keyword") String keyword, Pageable pageable);
}
