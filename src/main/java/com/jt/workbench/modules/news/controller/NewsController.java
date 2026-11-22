package com.jt.workbench.modules.news.controller;

import com.jt.workbench.modules.news.entity.NewsBlockWord;
import com.jt.workbench.modules.news.entity.NewsItem;
import com.jt.workbench.modules.news.entity.NewsSource;
import com.jt.workbench.modules.news.repo.NewsBlockWordRepository;
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
import java.util.Locale;
import java.util.Map;

/**
 * 资讯：列表 / 已读 / 收藏 / 订阅源 / 屏蔽词维护。
 * 正文在浏览器端消毒后展示（原文入库）。
 */
@RestController
@RequestMapping("admin/news")
public class NewsController {

    @Autowired
    private NewsItemRepository newsItemRepository;

    @Autowired
    private NewsSourceRepository newsSourceRepository;

    @Autowired
    private NewsBlockWordRepository newsBlockWordRepository;

    /** 分页查询：keyword 匹配标题/正文/作者，sourceId、status 可选 */
    @HasPermission("news:read")
    @PostMapping("page")
    public AjaxResult page(@PageableDefault(sort = "pubTime", direction = Sort.Direction.DESC, size = 20) Pageable pageable,
                           @RequestParam(required = false) String sourceId,
                           @RequestParam(required = false) String status,
                           @RequestParam(required = false) String keyword) {
        purgeBlockedItems();
        Page<NewsItem> page = newsItemRepository.search(blankToNull(keyword), blankToNull(sourceId),
                blankToNull(status), pageable);
        return new AjaxResult().ok().data(page);
    }

    /** 统计：未读 / 收藏 / 总数 / 近 24 小时新增 / 订阅源数 */
    @HasPermission("news:read")
    @GetMapping("stats")
    public AjaxResult stats() {
        purgeBlockedItems();
        Map<String, Object> map = new LinkedHashMap<>();
        map.put("unread", newsItemRepository.countByStatus("unread"));
        map.put("fav", newsItemRepository.countByStatus("fav"));
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
        if (item != null && isBlocked(item.getTitle(), item.getAuthor())) {
            newsItemRepository.deleteById(id);
            return new AjaxResult();
        }
        return item != null ? new AjaxResult().ok().data(item) : new AjaxResult();
    }

    /** 创建 */
    @HasPermission("news:create")
    @PostMapping("create")
    public AjaxResult create(@RequestBody NewsItem input) {
        if (isBlocked(input.getTitle(), input.getAuthor())) {
            return new AjaxResult();
        }
        NewsItem saved = newsItemRepository.save(input);
        return new AjaxResult().ok().data(saved);
    }

    /** 更新 */
    @HasPermission("news:update")
    @PostMapping("update")
    public AjaxResult update(@RequestBody NewsItem input) {
        if (newsItemRepository.existsById(input.getId())) {
            if (isBlocked(input.getTitle(), input.getAuthor())) {
                newsItemRepository.deleteById(input.getId());
            } else {
                newsItemRepository.save(input);
            }
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

    /** 收藏 / 取消收藏（在 fav 与 unread 之间切换） */
    @HasPermission("news:read")
    @PostMapping("{id}/fav")
    public AjaxResult markFav(@PathVariable String id) {
        NewsItem item = newsItemRepository.findById(id).orElse(null);
        if (item != null) {
            item.setStatus("fav".equals(item.getStatus()) ? "unread" : "fav");
            newsItemRepository.save(item);
        }
        return item != null ? new AjaxResult().ok().data(item) : new AjaxResult();
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

    // ---------------- 屏蔽词 ----------------

    @HasPermission("news:block")
    @GetMapping("blocks")
    public AjaxResult blocks() {
        return new AjaxResult().ok().data(newsBlockWordRepository.findAll(Sort.by("word")));
    }

    @HasPermission("news:block")
    @PostMapping("blocks")
    public AjaxResult createBlock(@RequestBody NewsBlockWord input) {
        NewsBlockWord saved = newsBlockWordRepository.save(input);
        if (saved.getWord() != null && !saved.getWord().isBlank()
                && (saved.getEnabled() == null || saved.getEnabled())) {
            newsItemRepository.deleteByBlockWord(saved.getWord().trim());
        }
        return new AjaxResult().ok().data(saved);
    }

    @HasPermission("news:block")
    @DeleteMapping("blocks/{id}")
    public AjaxResult deleteBlock(@PathVariable String id) {
        newsBlockWordRepository.deleteById(id);
        return new AjaxResult();
    }

    private void purgeBlockedItems() {
        for (NewsBlockWord b : newsBlockWordRepository.findByEnabledTrue()) {
            String word = b.getWord();
            if (word != null && !word.isBlank()) {
                newsItemRepository.deleteByBlockWord(word.trim());
            }
        }
    }

    private boolean isBlocked(String title, String author) {
        String t = title == null ? "" : title.toLowerCase(Locale.ROOT);
        String a = author == null ? "" : author.toLowerCase(Locale.ROOT);
        for (NewsBlockWord b : newsBlockWordRepository.findByEnabledTrue()) {
            String word = b.getWord();
            if (word == null || word.isBlank()) continue;
            String w = word.trim().toLowerCase(Locale.ROOT);
            if ((!t.isEmpty() && t.contains(w)) || (!a.isEmpty() && a.contains(w))) {
                return true;
            }
        }
        return false;
    }

    private static String blankToNull(String v) {
        return v == null || v.isBlank() ? null : v.trim();
    }
}
