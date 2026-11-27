package com.jt.workbench.modules.note.entity;

/**
 * 笔记附件展示元数据（非持久化字段）。
 *
 * @param objectName 对象存储 objectName（同时作为附件字段中的取值）
 * @param name       原始文件名
 * @param size       文件大小（字节，未知时为空）
 */
public record NoteAttachment(String objectName, String name, Long size) {
}
