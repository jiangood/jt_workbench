package com.jt.workbench.modules.music.entity;

import io.github.jiangood.openadmin.framework.data.BaseEntity;
import jakarta.persistence.*;
import lombok.Data;

@Entity
@Table(name = "music")
@Data
public class Music extends BaseEntity {

    private String title;

    private String artist;

    private String album;

    private String filePath;

    private String format;

    private Double duration;

    private Integer playCount = 0;

    private String coverUrl;
}