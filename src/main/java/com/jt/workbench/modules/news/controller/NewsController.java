package com.jt.workbench.modules.news.controller;

import com.jt.workbench.modules.news.entity.NewsItem;
import com.jt.workbench.modules.news.entity.NewsSource;
import com.jt.workbench.modules.news.repo.NewsItemRepository;
import com.jt.workbench.modules.news.repo.NewsSourceRepository;
import io.github.jiangood.openadmin.framework.perm.HasPermission;
import io.github.jiangood.openadmin.util.dto.AjaxResult;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.domain.Sort;
import org.springframework.data.web.PageableDefault;
import org.springframework.web.bind.annotation.*;

import java.time.LocalDateTime;
import java.time.temporal.ChronoUnit;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 资讯：列表 / 已读 / 订阅源维护。
 * 正文在浏览器端消毒后展示（原文入库）。
 */
@RestController
@RequestMapping("admin/news")
public class NewsController {

    @Autowired
    private NewsItemRepository newsItemRepository;

    @Autowired
    private NewsSourceRepository newsSourceRepository;

    /** 分页查询：keyword 匹配标题/正文/作者，sourceId、status 可选 */
    @HasPermission("news:read")
    @PostMapping("page")
    public AjaxResult page(@PageableDefault(sort = "pubTime", direction = Sort.Direction.DESC, size = 20) Pageable pageable,
                           @RequestParam(required = false) String sourceId,
                           @RequestParam(required = false) String status,
                           @RequestParam(required = false) String keyword) {
        Page<NewsItem> page = newsItemRepository.search(blankToNull(keyword), blankToNull(sourceId),
                blankToNull(status), pageable);
        return new AjaxResult().ok().data(page);
    }

    /** 统计：未读 / 总数 / 近 24 小时新增 / 订阅源数 */
    @HasPermission("news:read")
    @GetMapping("stats")
    public AjaxResult stats() {
        Map<String, Object> map = new LinkedHashMap<>();
        map.put("unread", newsItemRepository.countByStatus("unread"));
        map.put("total", newsItemRepository.count());
        map.put("recent24h", newsItemRepository.countSince(LocalDateTime.now().minus(24, ChronoUnit.HOURS)));
        map.put("sources", newsSourceRepository.count());
        return new AjaxResult().ok().data(map);
    }

    /** 详情 */
    @HasPermission("news:read")
    @GetMapping("info/{id}")
    public AjaxResult info(@PathVariable String id) {
        NewsItem item = newsItemRepository.findById(id).orElse(null);
        return item != null ? new AjaxResult().ok().data(item) : new AjaxResult();
    }

    /** 创建 */
    @HasPermission("news:create")
    @PostMapping("create")
    public AjaxResult create(@RequestBody NewsItem input) {
        NewsItem saved = newsItemRepository.save(input);
        return new AjaxResult().ok().data(saved);
    }

    /** 更新 */
    @HasPermission("news:update")
    @PostMapping("update")
    public AjaxResult update(@RequestBody NewsItem input) {
        if (newsItemRepository.existsById(input.getId())) {
            newsItemRepository.save(input);
        }
        return new AjaxResult();
    }

    /** 全部未读 → 已读 */
    @HasPermission("news:read")
    @PostMapping("read-all")
    public AjaxResult markAllRead() {
        int updated = newsItemRepository.markAllRead();
        return new AjaxResult().ok().data(Map.of("updated", updated));
    }

    /** 单条标记已读 */
    @HasPermission("news:read")
    @PostMapping("{id}/read")
    public AjaxResult markRead(@PathVariable String id) {
        NewsItem item = newsItemRepository.findById(id).orElse(null);
        if (item != null) {
            item.setStatus("read");
            newsItemRepository.save(item);
        }
        return new AjaxResult();
    }

    /** 批量标记已读 */
    @HasPermission("news:read")
    @PostMapping("read-batch")
    public AjaxResult markReadBatch(@RequestBody java.util.List<String> ids) {
        if (ids == null || ids.isEmpty()) {
            return new AjaxResult().ok().data(Map.of("updated", 0));
        }
        int updated = newsItemRepository.markReadByIds(ids);
        return new AjaxResult().ok().data(Map.of("updated", updated));
    }

    // ---------------- 订阅源 ----------------

    @HasPermission("news:source")
    @GetMapping("sources")
    public AjaxResult sources() {
        return new AjaxResult().ok().data(newsSourceRepository.findAll(Sort.by("name")));
    }

    @HasPermission("news:source")
    @PostMapping("sources")
    public AjaxResult createSource(@RequestBody NewsSource input) {
        return new AjaxResult().ok().data(newsSourceRepository.save(input));
    }

    /** 更新（主要用 enabled 开关） */
    @HasPermission("news:source")
    @PostMapping("sources/update")
    public AjaxResult updateSource(@RequestBody NewsSource input) {
        NewsSource old = newsSourceRepository.findById(input.getId()).orElse(null);
        if (old != null) {
            if (input.getName() != null) old.setName(input.getName());
            if (input.getUrl() != null) old.setUrl(input.getUrl());
            if (input.getType() != null) old.setType(input.getType());
            if (input.getRemark() != null) old.setRemark(input.getRemark());
            if (input.getEnabled() != null) old.setEnabled(input.getEnabled());
            newsSourceRepository.save(old);
        }
        return new AjaxResult();
    }

    @HasPermission("news:source")
    @DeleteMapping("sources/{id}")
    public AjaxResult deleteSource(@PathVariable String id) {
        newsSourceRepository.deleteById(id);
        return new AjaxResult();
    }

    private static String blankToNull(String v) {
        return v == null || v.isBlank() ? null : v.trim();
    }
}
