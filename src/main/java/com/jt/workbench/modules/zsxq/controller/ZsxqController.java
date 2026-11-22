package com.jt.workbench.modules.zsxq.controller;

import com.jt.workbench.modules.zsxq.entity.ZsxqColumn;
import com.jt.workbench.modules.zsxq.entity.ZsxqTopic;
import com.jt.workbench.modules.zsxq.repo.ZsxqColumnRepository;
import com.jt.workbench.modules.zsxq.repo.ZsxqGroupRepository;
import com.jt.workbench.modules.zsxq.repo.ZsxqTopicRepository;
import com.jt.workbench.modules.zsxq.service.ZsxqImageService;
import io.github.jiangood.openadmin.framework.perm.HasPermission;
import io.github.jiangood.openadmin.util.dto.AjaxResult;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.domain.Sort;
import org.springframework.data.web.PageableDefault;
import org.springframework.http.CacheControl;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.*;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.TimeUnit;

/**
 * 知识星球：只读查询（数据由定时任务同步，无手工编辑）。
 */
@RestController
@RequestMapping("admin/zsxq")
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
    private JdbcTemplate jdbc;

    @HasPermission("zsxq:read")
    @PostMapping("page")
    public AjaxResult page(@PageableDefault(sort = "lastCommentTime", direction = Sort.Direction.DESC, size = 20) Pageable pageable,
                           @RequestParam(required = false) String keyword,
                           @RequestParam(required = false) String columnId,
                           @RequestParam(required = false) Boolean ownerOnly) {
        Page<ZsxqTopic> page = topicRepository.search(blankToNull(keyword), blankToNull(columnId),
                Boolean.TRUE.equals(ownerOnly), pageable);
        return new AjaxResult().ok().data(page);
    }

    @HasPermission("zsxq:read")
    @GetMapping("column/{columnId}")
    public AjaxResult column(@PathVariable String columnId) {
        ZsxqColumn item = columnRepository.findByColumnId(columnId).orElse(null);
        return item != null ? new AjaxResult().ok().data(item) : new AjaxResult();
    }

    @HasPermission("zsxq:read")
    @GetMapping("info/{id}")
    public AjaxResult info(@PathVariable String id) {
        ZsxqTopic item = topicRepository.findById(id).orElse(null);
        return item != null ? new AjaxResult().ok().data(item) : new AjaxResult();
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

    /** 统计：帖子总数 / 星球数 / 专栏数 */
    @HasPermission("zsxq:read")
    @GetMapping("stats")
    public AjaxResult stats() {
        Map<String, Object> map = new LinkedHashMap<>();
        map.put("topics", topicRepository.count());
        map.put("groups", groupRepository.count());
        map.put("columns", columnRepository.countByVisibleTrue());
        return new AjaxResult().ok().data(map);
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
