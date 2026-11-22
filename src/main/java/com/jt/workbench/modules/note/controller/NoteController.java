package com.jt.workbench.modules.note.controller;

import com.jt.workbench.modules.note.entity.Note;
import com.jt.workbench.modules.note.entity.NoteFolder;
import com.jt.workbench.modules.note.repo.NoteRepository;
import com.jt.workbench.modules.note.repo.NoteFolderRepository;
import io.github.jiangood.openadmin.util.dto.AjaxResult;
import io.github.jiangood.openadmin.framework.perm.HasPermission;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.domain.Sort;
import org.springframework.data.web.PageableDefault;
import org.springframework.web.bind.annotation.*;

/**
 * 笔记：列表（目录 / 未分类 / 关键字搜索）、增删改、目录树维护。
 */
@RestController
@RequestMapping("admin/note")
public class NoteController {

    @org.springframework.beans.factory.annotation.Autowired
    private NoteRepository noteRepository;

    @org.springframework.beans.factory.annotation.Autowired
    private NoteFolderRepository noteFolderRepository;

    /** 分页查询：folderId=none 为未分类，keyword 为标题/正文模糊搜索，都为空为全部 */
    @HasPermission("note:read")
    @PostMapping("page")
    public AjaxResult page(@PageableDefault(sort = "updateTime", direction = Sort.Direction.DESC, size = 20) Pageable pageable,
                           @RequestParam(required = false) String folderId,
                           @RequestParam(required = false) String keyword) {
        Page<Note> page;
        if (keyword != null && !keyword.isBlank()) {
            page = noteRepository.pageByKeyword(keyword.trim(), pageable);
        } else if ("none".equals(folderId)) {
            page = noteRepository.pageUnfiled(pageable);
        } else if (folderId != null && !folderId.isBlank()) {
            page = noteRepository.pageByFolder(folderId, pageable);
        } else {
            page = noteRepository.findAll(pageable);
        }
        return new AjaxResult().ok().data(page);
    }

    /** 详情 */
    @HasPermission("note:read")
    @GetMapping("info/{id}")
    public AjaxResult info(@PathVariable String id) {
        Note item = noteRepository.findById(id).orElse(null);
        return item != null ? new AjaxResult().ok().data(item) : new AjaxResult();
    }

    /** 创建 */
    @HasPermission("note:edit")
    @PostMapping("create")
    public AjaxResult create(@RequestBody Note input) {
        Note saved = noteRepository.save(input);
        return new AjaxResult().ok().data(saved);
    }

    /** 更新 */
    @HasPermission("note:edit")
    @PostMapping("update")
    public AjaxResult update(@RequestBody Note input) {
        if (noteRepository.existsById(input.getId())) {
            noteRepository.save(input);
        }
        return new AjaxResult();
    }

    /** 删除 */
    @HasPermission("note:edit")
    @PostMapping("delete")
    public AjaxResult delete(@RequestBody io.github.jiangood.openadmin.util.dto.IdReq req) {
        noteRepository.deleteById(req.getId());
        return new AjaxResult();
    }

    /** 文件夹 - 列表（前端自行组树） */
    @HasPermission("note:read")
    @GetMapping("folders")
    public AjaxResult folders() {
        return new AjaxResult().ok().data(noteFolderRepository.findAll(Sort.by("seq", "name")));
    }

    /** 文件夹 - 创建 */
    @HasPermission("note:edit")
    @PostMapping("folders")
    public AjaxResult createFolder(@RequestBody NoteFolder input) {
        NoteFolder saved = noteFolderRepository.save(input);
        return new AjaxResult().ok().data(saved);
    }

    /** 文件夹 - 重命名 */
    @HasPermission("note:edit")
    @PostMapping("folders/update")
    public AjaxResult updateFolder(@RequestBody NoteFolder input) {
        if (input.getId() != null && noteFolderRepository.existsById(input.getId())) {
            NoteFolder old = noteFolderRepository.findById(input.getId()).orElse(null);
            if (old != null) {
                old.setName(input.getName());
                old.setParentId(input.getParentId());
                noteFolderRepository.save(old);
            }
        }
        return new AjaxResult();
    }

    /** 文件夹 - 删除 */
    @HasPermission("note:edit")
    @DeleteMapping("folders/{id}")
    public AjaxResult deleteFolder(@PathVariable String id) {
        noteFolderRepository.deleteById(id);
        return new AjaxResult();
    }
}
