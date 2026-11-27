package com.jt.workbench.modules.note.service;

import com.jt.workbench.modules.note.dto.NoteListItem;
import com.jt.workbench.modules.note.entity.Note;
import com.jt.workbench.modules.note.entity.NoteAttachment;
import com.jt.workbench.modules.note.entity.NoteFolder;
import com.jt.workbench.modules.note.repo.NoteFolderRepository;
import com.jt.workbench.modules.note.repo.NoteRepository;
import com.jt.workbench.modules.note.util.NoteHtml;
import io.github.jiangood.openadmin.modules.system.entity.SysFile;
import io.github.jiangood.openadmin.modules.system.service.SysFileService;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * 笔记保存：维护纯文本正文，并在同一事务内确认/丢弃富文本与附件引用的临时文件。
 */
@Service
@RequiredArgsConstructor
public class NoteService {

    private final NoteRepository noteRepository;
    private final NoteFolderRepository noteFolderRepository;
    private final SysFileService sysFileService;

    @Transactional
    public Note create(Note input) {
        input.setId(null);
        normalize(input);
        if (input.getReadState() == null) input.setReadState(0);
        Note saved = noteRepository.save(input);
        sysFileService.confirmTempFiles(saved);
        return saved;
    }

    @Transactional
    public Note update(Note input) {
        Note old = input == null || input.getId() == null
                ? null : noteRepository.findById(input.getId()).orElse(null);
        if (old == null) return null;

        sysFileService.discardTempFiles(old);
        old.setTitle(input.getTitle());
        old.setFolderId(blankToNull(input.getFolderId()));
        old.setContentHtml(input.getContentHtml());
        old.setAttachments(cleanAttachments(input.getAttachments()));
        if (input.getReadState() != null) old.setReadState(input.getReadState());
        if (input.getCategory() != null) old.setCategory(input.getCategory());
        normalize(old);

        Note saved = noteRepository.save(old);
        sysFileService.confirmTempFiles(saved);
        return saved;
    }

    @Transactional
    public void delete(String id) {
        Note old = id == null ? null : noteRepository.findById(id).orElse(null);
        if (old == null) return;
        // 标记正文图片与附件待清理，物理文件由临时文件清理作业删除
        sysFileService.discardTempFiles(old);
        noteRepository.delete(old);
    }

    /** 填充目录名与附件展示元数据（info 接口使用） */
    public void enrich(Note note) {
        if (note == null) return;
        String folderId = blankToNull(note.getFolderId());
        if (folderId == null) {
            note.setFolderName(null);
        } else {
            note.setFolderName(noteFolderRepository.findById(folderId)
                    .map(NoteFolder::getName).orElse(null));
        }

        List<NoteAttachment> files = new ArrayList<>();
        for (String objectName : splitObjectNames(note.getAttachments())) {
            SysFile file = sysFileService.findByObjectName(objectName);
            String name = file != null && file.getOriginName() != null && !file.getOriginName().isBlank()
                    ? file.getOriginName() : fileNameOf(objectName);
            Long size = file == null ? null : file.getSize();
            files.add(new NoteAttachment(objectName, name, size));
        }
        note.setAttachmentFiles(files);
    }

    public NoteListItem toListItem(Note note) {
        return new NoteListItem(note.getId(), note.getTitle(), note.getFolderId(), note.getContent(),
                note.getReadState(), note.getCategory(), note.getUpdateTime(),
                splitObjectNames(note.getAttachments()).size());
    }

    /** 富文本为主；兼容历史纯文本笔记，保存后纯文本字段始终由富文本派生 */
    private void normalize(Note note) {
        String html = note.getContentHtml();
        if ((html == null || html.isBlank()) && note.getContent() != null && !note.getContent().isBlank()) {
            html = NoteHtml.plainTextToHtml(note.getContent());
        }
        if (html != null && html.isBlank()) html = null;
        note.setContentHtml(html);
        note.setContent(NoteHtml.toPlainText(html));
        note.setAttachments(cleanAttachments(note.getAttachments()));
    }

    private static String cleanAttachments(String value) {
        List<String> list = splitObjectNames(value);
        return list.isEmpty() ? null : String.join(",", list);
    }

    private static List<String> splitObjectNames(String value) {
        Set<String> seen = new LinkedHashSet<>();
        if (value != null) {
            for (String part : value.split(",")) {
                String name = part.trim();
                if (!name.isEmpty() && !name.contains("..")) seen.add(name);
            }
        }
        return new ArrayList<>(seen);
    }

    private static String fileNameOf(String objectName) {
        int slash = objectName.lastIndexOf('/');
        return slash < 0 ? objectName : objectName.substring(slash + 1);
    }

    private static String blankToNull(String value) {
        return value == null || value.isBlank() ? null : value.trim();
    }
}
