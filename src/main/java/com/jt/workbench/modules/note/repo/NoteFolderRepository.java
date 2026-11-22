package com.jt.workbench.modules.note.repo;

import com.jt.workbench.modules.note.entity.NoteFolder;
import org.springframework.data.jpa.repository.JpaRepository;

public interface NoteFolderRepository extends JpaRepository<NoteFolder, String> {
}