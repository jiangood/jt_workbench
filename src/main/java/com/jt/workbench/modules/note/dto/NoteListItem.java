package com.jt.workbench.modules.note.dto;

import java.time.LocalDateTime;

/**
 * 笔记列表行（不返回富文本正文，避免分页接口传输大量 HTML）。
 */
public record NoteListItem(String id,
                           String title,
                           String folderId,
                           String content,
                           Integer readState,
                           Integer category,
                           LocalDateTime updateTime,
                           int attachmentCount,
                           String sourceUrl) {
}
