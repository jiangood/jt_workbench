package com.jt.workbench.modules.zsxq.controller;

import com.jt.workbench.modules.note.entity.Note;
import com.jt.workbench.modules.zsxq.entity.ZsxqColumn;
import com.jt.workbench.modules.zsxq.entity.ZsxqFile;
import com.jt.workbench.modules.zsxq.entity.ZsxqGroup;
import com.jt.workbench.modules.zsxq.entity.ZsxqTopic;
import com.jt.workbench.modules.zsxq.repo.ZsxqColumnRepository;
import com.jt.workbench.modules.zsxq.repo.ZsxqGroupRepository;
import com.jt.workbench.modules.zsxq.repo.ZsxqTopicRepository;
import com.jt.workbench.modules.zsxq.service.ZsxqFileService;
import com.jt.workbench.modules.zsxq.service.ZsxqImageService;
import com.jt.workbench.modules.zsxq.service.ZsxqNoteService;
import com.jt.workbench.modules.job.service.ZsxqSyncService;
import io.github.jiangood.openadmin.framework.perm.HasPermission;
import io.github.jiangood.openadmin.util.dto.AjaxResult;
import io.github.jiangood.openadmin.util.dto.IdReq;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.core.io.InputStreamResource;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Pageable;
import org.springframework.data.domain.Sort;
import org.springframework.data.web.PageableDefault;
import org.springframework.http.CacheControl;
import org.springframework.http.ContentDisposition;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.*;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.TimeUnit;

/**
 * 知识星球：只读查询（数据由定时任务同步）+ 管理功能（删除/启用星球）。
 */
@RestController
@RequestMapping("admin/zsxq")
@Slf4j
public class ZsxqController {

    @Autowired
    private ZsxqTopicRepository topicRepository;

    @Autowired
    private ZsxqGroupRepository groupRepository;

    @Autowired
    private ZsxqColumnRepository columnRepository;

    @Autowired
    private ZsxqImageService imageService;

    @Autowired
    private ZsxqFileService fileService;

    @Autowired
    private ZsxqNoteService noteService;

    @Autowired
    private ZsxqSyncService syncService;

    @Autowired
    private JdbcTemplate jdbc;

    /** 可排序话题字段（限定取值，防止请求传入非法属性） */
    private static final Set<String> SORT_PROPERTIES = Set.of("sourceCreateTime", "lastCommentTime");

    private static final Set<String> QUALITY_MARKS = Set.of("DRY", "WATER");

    @HasPermission("zsxq:read")
    @PostMapping("page")
    public AjaxResult page(@PageableDefault(sort = "sourceCreateTime", direction = Sort.Direction.DESC, size = 20) Pageable pageable,
                           @RequestParam(required = false) String keyword,
                           @RequestParam(required = false) String columnId,
                           @RequestParam(required = false) Boolean ownerOnly,
                           @RequestParam(required = false) String quality,
                           @RequestParam(required = false) String sort,
                           @RequestParam(required = false) String direction) {
        Page<ZsxqTopic> page = topicRepository.search(blankToNull(keyword), blankToNull(columnId),
                Boolean.TRUE.equals(ownerOnly), normalizeQuality(quality), effectivePageable(pageable, sort, direction));
        return new AjaxResult().ok().data(page);
    }

    /** 质量标识：只接受 DRY/WATER，其他值视为不过滤/清除。 */
    private static String normalizeQuality(String quality) {
        String v = blankToNull(quality);
        if (v == null) return null;
        String upper = v.toUpperCase(Locale.ROOT);
        return QUALITY_MARKS.contains(upper) ? upper : null;
    }

    /** 取最终分页参数：请求显式指定 sort/direction 时优先；未指定时沿用默认（发布时间倒序） */
    private static Pageable effectivePageable(Pageable pageable, String sort, String direction) {
        Sort sortBy = sortSpec(sort, direction, pageable.getSort());
        if (!pageable.isPaged()) return pageable;
        return PageRequest.of(pageable.getPageNumber(), pageable.getPageSize(), sortBy);
    }

    private static Sort sortSpec(String sort, String direction, Sort fallback) {
        String property = blankToNull(sort);
        if (property == null || !SORT_PROPERTIES.contains(property)) return fallback;
        Sort.Direction order = Sort.Direction.ASC.name().equalsIgnoreCase(blankToNull(direction))
                ? Sort.Direction.ASC : Sort.Direction.DESC;
        return Sort.by(order, property);
    }

    @HasPermission("zsxq:read")
    @GetMapping("column/{columnId}")
    public AjaxResult column(@PathVariable String columnId) {
        ZsxqColumn item = columnRepository.findByColumnId(columnId).orElse(null);
        if (item == null) return new AjaxResult();
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("id", item.getId());
        data.put("columnId", item.getColumnId());
        data.put("groupId", item.getGroupId());
        data.put("name", item.getName());
        data.put("description", item.getDescription());
        data.put("coverUrl", item.getCoverUrl());
        data.put("topicsCount", item.getTopicsCount());
        data.put("visible", item.getVisible());
        groupRepository.findById(item.getGroupId() == null ? "" : item.getGroupId()).ifPresent(g -> {
            data.put("groupName", g.getName());
            data.put("groupOwner", g.getOwner());
        });
        return new AjaxResult().ok().data(data);
    }

    @HasPermission("zsxq:read")
    @GetMapping("info/{id}")
    public AjaxResult info(@PathVariable String id) {
        ZsxqTopic item = topicRepository.findById(id).orElse(null);
        return item != null ? new AjaxResult().ok().data(item) : new AjaxResult();
    }

    /** 话题质量标识：DRY=干货，WATER=水帖，空值=清除标识 */
    public record QualityReq(String id, String quality) {
    }

    @HasPermission("zsxq:manage")
    @PostMapping("quality")
    public AjaxResult quality(@RequestBody QualityReq req) {
        String id = req == null ? null : blankToNull(req.id());
        if (id == null) return AjaxResult.err("参数错误");
        ZsxqTopic topic = topicRepository.findById(id).orElse(null);
        if (topic == null) return AjaxResult.err("帖子不存在");
        String quality = normalizeQuality(req.quality());
        topic.setQuality(quality);
        topicRepository.save(topic);
        return new AjaxResult().ok().data(Map.of("id", topic.getId(), "quality", quality == null ? "" : quality));
    }

    /** 话题转笔记请求：id 为本地话题主键，title/folderId/sourceUrl 可在转换弹窗里调整 */
    public record ConvertNoteReq(String id, String title, String folderId, String sourceUrl) {
    }

    /**
     * 把一个知识星球话题转成个人笔记。
     *
     * <p>正文与图片、附件会复制到笔记的文件库；同一话题重复转换时返回已有笔记。
     * 写笔记属于笔记编辑权限，因此这里校验 {@code note:edit}。</p>
     */
    @HasPermission("note:edit")
    @PostMapping("note")
    public AjaxResult convertNote(@RequestBody ConvertNoteReq req) {
        String id = req == null ? null : blankToNull(req.id());
        if (id == null) return AjaxResult.err("参数错误");
        ZsxqTopic topic = topicRepository.findById(id).orElse(null);
        if (topic == null) return AjaxResult.err("帖子不存在");
        try {
            Note note = noteService.convert(topic, req.title(), req.folderId(), req.sourceUrl());
            return new AjaxResult().ok().data(note);
        } catch (Exception e) {
            log.error("知识星球转笔记失败 topicId={} error={}", topic.getTopicId(), e.getMessage(), e);
            return AjaxResult.err("转为笔记失败：" + e.getMessage());
        }
    }

    /**
     * 话题评论：阅读页用于展示话题下的评论，按 topicIds 批量查询。
     *
     * <p>返回 {@code Map<topicId, List<{author, text, time}>>}；每个话题最多返回 30 条，
     * 按发布时间正序；查询异常（如评论表尚未同步）时静默返回空列表。</p>
     */
    @HasPermission("zsxq:read")
    @GetMapping("comments")
    public AjaxResult comments(@RequestParam(required = false) List<String> topicIds) {
        Map<String, List<Map<String, Object>>> result = new LinkedHashMap<>();
        if (topicIds != null) {
            for (String raw : topicIds) {
                String topicId = raw == null ? "" : raw.trim();
                if (topicId.isEmpty() || result.containsKey(topicId)) continue;
                result.put(topicId, commentRows(topicId));
            }
        }
        return new AjaxResult().ok().data(result);
    }

    /** 查询一个话题的评论（发布时间正序，最多 30 条），标记是否为星主发言。 */
    private List<Map<String, Object>> commentRows(String topicId) {
        try {
            List<Map<String, Object>> rows = jdbc.queryForList(
                    "SELECT c.author, c.text, c.source_create_time, c.create_time, "
                            + "CASE WHEN g.owner IS NOT NULL AND g.owner <> '' AND c.author = g.owner "
                            + "THEN TRUE ELSE FALSE END AS owner_post "
                            + "FROM zsxq_comment c LEFT JOIN zsxq_group g ON g.id = c.group_id "
                            + "WHERE c.topic_id = ? ORDER BY c.create_time ASC, c.id ASC LIMIT 30",
                    topicId);
            List<Map<String, Object>> out = new ArrayList<>(rows.size());
            for (Map<String, Object> row : rows) {
                String sourceTime = cell(row, "source_create_time");
                Map<String, Object> item = new LinkedHashMap<>();
                item.put("author", cell(row, "author"));
                item.put("text", cell(row, "text"));
                item.put("time", sourceTime.isEmpty() ? cell(row, "create_time") : sourceTime);
                item.put("owner", truthy(row.containsKey("owner_post") ? row.get("owner_post") : row.get("OWNER_POST")));
                out.add(item);
            }
            return out;
        } catch (Exception e) {
            return new ArrayList<>();
        }
    }

    /** 布尔列兼容 H2（Boolean）/ MySQL（0/1）两种返回类型。 */
    private static boolean truthy(Object value) {
        if (value instanceof Boolean b) return b;
        if (value instanceof Number n) return n.intValue() != 0;
        return value != null && "true".equalsIgnoreCase(String.valueOf(value));
    }

    /** 从查询行取字符串值；兼容 H2 等驱动返回的大写列名。 */
    private static String cell(Map<String, Object> row, String name) {
        Object value = row.get(name);
        if (value == null) value = row.get(name.toUpperCase(Locale.ROOT));
        if (value == null) value = row.get(name.toLowerCase(Locale.ROOT));
        return value == null ? "" : String.valueOf(value).trim();
    }

    /**
     * 话题附件列表：按 topicIds 批量查询，返回 {@code Map<topicId, List<附件>>}。
     *
     * <p>只返回元数据，文件内容在用户点击下载时再按需落到对象存储；
     * {@code stored=true} 表示已经进入对象存储。</p>
     */
    @HasPermission("zsxq:read")
    @GetMapping("files")
    public AjaxResult files(@RequestParam(required = false) List<String> topicIds) {
        Map<String, List<Map<String, Object>>> result = new LinkedHashMap<>();
        Map<String, List<ZsxqFile>> grouped = fileService.byTopicIds(topicIds);
        for (Map.Entry<String, List<ZsxqFile>> entry : grouped.entrySet()) {
            List<Map<String, Object>> list = new ArrayList<>();
            for (ZsxqFile file : entry.getValue()) {
                Map<String, Object> item = new LinkedHashMap<>();
                item.put("fileId", file.getFileId());
                item.put("name", file.getName());
                item.put("size", file.getFileSize());
                item.put("contentType", file.getContentType());
                item.put("stored", file.getS3Key() != null && !file.getS3Key().isBlank());
                list.add(item);
            }
            result.put(entry.getKey(), list);
        }
        return new AjaxResult().ok().data(result);
    }

    /**
     * 附件下载：首次访问时用 file_id 换取星球下载地址、写入对象存储，然后把 S3 流式返回。
     * 同一附件后续直接读对象存储，不再请求星球。
     */
    @HasPermission("zsxq:read")
    @GetMapping("file")
    public ResponseEntity<InputStreamResource> file(@RequestParam String topicId,
                                                    @RequestParam String fileId) {
        ZsxqFile file = fileService.find(topicId, fileId);
        if (file == null) return ResponseEntity.notFound().build();
        try {
            ZsxqFile stored = fileService.ensureStored(file);
            InputStream in = fileService.open(stored);
            ContentDisposition disposition = ContentDisposition.attachment()
                    .filename(fileService.fileName(stored), StandardCharsets.UTF_8)
                    .build();
            ResponseEntity.BodyBuilder builder = ResponseEntity.ok()
                    .header(HttpHeaders.CONTENT_DISPOSITION, disposition.toString())
                    .contentType(MediaType.parseMediaType(fileService.contentType(stored)))
                    .cacheControl(CacheControl.maxAge(365, TimeUnit.DAYS).cachePrivate().immutable());
            if (stored.getFileSize() != null && stored.getFileSize() > 0) {
                builder.contentLength(stored.getFileSize());
            }
            return builder.body(new InputStreamResource(in));
        } catch (Exception e) {
            log.warn("知识星球附件下载失败 topicId={} fileId={} error={}", topicId, fileId, e.getMessage());
            return ResponseEntity.<InputStreamResource>status(HttpStatus.BAD_GATEWAY).build();
        }
    }

    /** 统计：帖子总数（不含专栏文章）/ 星球数 / 专栏数 */
    @HasPermission("zsxq:read")
    @GetMapping("stats")
    public AjaxResult stats() {
        Map<String, Object> map = new LinkedHashMap<>();
        map.put("topics", topicRepository.countMainTopics());
        map.put("groups", groupRepository.count());
        map.put("columns", columnRepository.countByVisibleTrue());
        return new AjaxResult().ok().data(map);
    }

    // ---------- 管理：删除 / 启用星球 ----------

    /**
     * 管理：删除星球——级联删除其话题、评论、专栏与正文图片对象；星球不存在时返回成功。
     */
    @HasPermission("zsxq:manage")
    @PostMapping("group/delete")
    public AjaxResult groupDelete(@RequestBody IdReq req) {
        String id = req == null ? null : req.getId();
        if (id == null || id.isBlank() || !groupRepository.existsById(id)) return new AjaxResult();

        List<Map<String, Object>> topicRows = jdbc.queryForList(
                "SELECT id, topic_id, images, cover FROM zsxq_topic WHERE group_id = ?", id);
        List<String> topicIds = new ArrayList<>(topicRows.size());
        List<String> imageKeys = new ArrayList<>();
        for (Map<String, Object> row : topicRows) {
            String tid = cell(row, "topic_id");
            if (!tid.isEmpty()) topicIds.add(tid);
            imageKeys.addAll(imageService.parseKeys(cell(row, "images")));
            String cover = blankToNull(cell(row, "cover"));
            if (cover != null) imageKeys.add(cover);
        }
        // 评论（先删：与话题同一组）
        StringBuilder sql = new StringBuilder("DELETE FROM zsxq_comment WHERE group_id = ?");
        List<Object> args = new ArrayList<>();
        args.add(id);
        if (!topicIds.isEmpty()) {
            sql.append(" OR topic_id IN ").append(inList(topicIds.size()));
            args.addAll(topicIds);
        }
        jdbc.update(sql.toString(), args.toArray());
        jdbc.update("DELETE FROM zsxq_column WHERE group_id = ?", id);
        jdbc.update("DELETE FROM zsxq_topic WHERE group_id = ?", id);
        groupRepository.deleteById(id);
        // 正文图片/附件对象与话题一起失效；删除失败只记日志，不阻塞
        imageService.deleteKeys(imageKeys);
        fileService.deleteKeys(fileService.deleteByGroup(id));
        return new AjaxResult().ok();
    }

    /** 管理：启用/禁用星球（只改设置；星球不存在时返回成功）。 */
    @HasPermission("zsxq:manage")
    @PostMapping("group/update")
    public AjaxResult groupUpdate(@RequestBody ZsxqGroup input) {
        if (input == null || input.getId() == null || input.getEnabled() == null) return new AjaxResult();
        ZsxqGroup group = groupRepository.findById(input.getId()).orElse(null);
        if (group == null) return new AjaxResult();
        group.setEnabled(input.getEnabled());
        groupRepository.save(group);
        return new AjaxResult().ok();
    }

    /**
     * 管理：清空抓取数据（不传 id 时清空全部星球）。
     *
     * <p>删除话题、评论、专栏、正文图片并重置同步游标，保留星球列表与启用设置，
     * 下一轮同步会重新抓取。星球不存在时返回成功。</p>
     */
    @HasPermission("zsxq:manage")
    @PostMapping("clear")
    public AjaxResult clear(@RequestBody(required = false) IdReq req) {
        String id = req == null ? null : blankToNull(req.getId());
        if (id != null && !groupRepository.existsById(id)) return new AjaxResult();
        return new AjaxResult().ok().data(syncService.clearScrapedData(id));
    }

    /** IN 占位符串：(?,?,...) */
    private static String inList(int n) {
        return "(?" + ",?".repeat(n - 1) + ")";
    }

    /**
     * 正文图片读取。
     *
     * <p>{@code key} 直接读对象存储；{@code u} 为尚未回填的旧源图地址（仅允许星球官方图床），
     * 首次访问会顺手写入对象存储，作为回填作业未覆盖前的兜底。</p>
     */
    @HasPermission("zsxq:read")
    @GetMapping("image")
    public ResponseEntity<byte[]> image(@RequestParam(required = false) String key,
                                        @RequestParam(required = false) String u) {
        String objectKey = blankToNull(key);
        String sourceUrl = blankToNull(u);
        if (objectKey == null && sourceUrl != null) {
            if (!sourceUrl.startsWith("https://images.zsxq.com/")) {
                return ResponseEntity.badRequest().build();
            }
            objectKey = imageService.storeUrl(sourceUrl);
        }
        if (objectKey == null || !objectKey.startsWith(ZsxqImageService.KEY_PREFIX) || objectKey.contains("..")) {
            return ResponseEntity.notFound().build();
        }
        try {
            byte[] bytes = imageService.read(objectKey);
            return ResponseEntity.ok()
                    .contentType(MediaType.parseMediaType(imageService.contentType(bytes, objectKey)))
                    .cacheControl(CacheControl.maxAge(365, TimeUnit.DAYS).cachePrivate().immutable())
                    .body(bytes);
        } catch (Exception e) {
            return ResponseEntity.notFound().build();
        }
    }

    @HasPermission("zsxq:read")
    @GetMapping("groups")
    public AjaxResult groups() {
        return new AjaxResult().ok().data(groupRepository.findAll(Sort.by("name")));
    }

    @HasPermission("zsxq:read")
    @GetMapping("columns")
    public AjaxResult columns(@RequestParam(required = false) String groupId) {
        List<ZsxqColumn> list = blankToNull(groupId) == null
                ? columnRepository.findByVisibleTrueOrderByGroupIdAscNameAsc()
                : columnRepository.findByGroupIdOrderByName(groupId.trim());
        return new AjaxResult().ok().data(list);
    }

    private static String blankToNull(String v) {
        return v == null || v.isBlank() ? null : v.trim();
    }
}
