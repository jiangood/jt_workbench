package com.jt.workbench.modules.note.entity;

import io.github.jiangood.openadmin.framework.data.BaseEntity;
import jakarta.persistence.*;
import lombok.Data;

@Entity
@Table(name = "note_folder")
@Data
public class NoteFolder extends BaseEntity {

    private String name;

    private String parentId;

    private Integer seq;
}