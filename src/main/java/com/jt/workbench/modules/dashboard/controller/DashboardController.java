package com.jt.workbench.modules.dashboard.controller;

import com.jt.workbench.modules.news.entity.NewsItem;
import com.jt.workbench.modules.news.entity.NewsSource;
import com.jt.workbench.modules.news.repo.NewsItemRepository;
import com.jt.workbench.modules.news.repo.NewsSourceRepository;
import com.jt.workbench.modules.note.entity.Note;
import com.jt.workbench.modules.note.repo.NoteRepository;
import com.jt.workbench.modules.reminder.entity.Reminder;
import com.jt.workbench.modules.reminder.repo.ReminderRepository;
import com.jt.workbench.modules.stock.entity.StockWatch;
import com.jt.workbench.modules.stock.repo.StockWatchRepository;
import com.jt.workbench.modules.zsxq.entity.ZsxqTopic;
import com.jt.workbench.modules.zsxq.repo.ZsxqTopicRepository;
import com.nlf.calendar.Lunar;
import com.nlf.calendar.Solar;
import io.github.jiangood.openadmin.util.dto.AjaxResult;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Sort;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.time.*;
import java.time.format.DateTimeFormatter;
import java.time.temporal.ChronoUnit;
import java.util.*;
import java.util.stream.Collectors;

/**
 * 首页 Dashboard 汇总：资讯 / 提醒 / 自选股 / 笔记 / 知识星球。
 * 服务端仅做简单聚合与展示计算（如提醒下一次事件日期估算）。
 */
@RestController
@RequestMapping("admin/dashboard")
public class DashboardController {

    private static final ZoneId ZONE = ZoneId.systemDefault();
    private static final DateTimeFormatter DATE_FMT = DateTimeFormatter.ofPattern("yyyy-MM-dd");

    @Autowired
    private NewsItemRepository newsItemRepository;
    @Autowired
    private NewsSourceRepository newsSourceRepository;
    @Autowired
    private ReminderRepository reminderRepository;
    @Autowired
    private StockWatchRepository stockWatchRepository;
    @Autowired
    private NoteRepository noteRepository;
    @Autowired
    private ZsxqTopicRepository zsxqTopicRepository;

    @GetMapping("summary")
    public AjaxResult summary() {
        Map<String, Object> data = new LinkedHashMap<>();

        data.put("news", buildNews());
        data.put("reminders", buildReminders());
        data.put("stocks", buildStocks());
        data.put("notes", buildNotes());
        data.put("zsxq", buildZsxq());

        return new AjaxResult().ok().data(data);
    }

    private Map<String, Object> buildNews() {
        Map<String, String> sourceNames = newsSourceRepository.findAll().stream()
                .collect(Collectors.toMap(NewsSource::getId, s -> s.getName() == null ? "" : s.getName(), (a, b) -> a));

        List<NewsItem> latest = newsItemRepository.search(null, null, "unread",
                PageRequest.of(0, 8, Sort.by(Sort.Direction.DESC, "pubTime"))).getContent();

        List<Map<String, Object>> items = new ArrayList<>();
        for (NewsItem n : latest) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("id", n.getId());
            m.put("title", n.getTitle());
            m.put("sourceName", sourceNames.getOrDefault(n.getSourceId(), ""));
            m.put("author", n.getAuthor());
            m.put("pubTime", n.getPubTime() == null ? null : n.getPubTime().toString());
            m.put("status", n.getStatus());
            items.add(m);
        }

        Map<String, Object> news = new LinkedHashMap<>();
        news.put("latest", items);
        news.put("unread", newsItemRepository.countByStatus("unread"));
        return news;
    }

    private Map<String, Object> buildReminders() {
        List<Reminder> enabled = reminderRepository.findByEnabledTrue();
        LocalDate today = LocalDate.now();
        LocalDate horizon = today.plusDays(30);

        List<Map<String, Object>> upcoming = new ArrayList<>();
        for (Reminder r : enabled) {
            LocalDate next = nextEventDate(r, today, horizon);
            if (next == null) continue;
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("id", r.getId());
            m.put("title", r.getTitle());
            m.put("type", r.getType());
            m.put("lunar", Boolean.TRUE.equals(r.getLunar()));
            m.put("lunarMonth", r.getLunarMonth());
            m.put("lunarDay", r.getLunarDay());
            m.put("lunarLeap", Boolean.TRUE.equals(r.getLunarLeap()));
            m.put("eventDate", next.format(DATE_FMT));
            m.put("remindAt", r.getRemindAt());
            m.put("offsets", offsetsOf(r));
            m.put("daysLeft", ChronoUnit.DAYS.between(today, next));
            upcoming.add(m);
        }

        upcoming.sort(Comparator
                .comparingLong((Map<String, Object> m) -> ((Number) m.get("daysLeft")).longValue())
                .thenComparing(m -> String.valueOf(m.getOrDefault("remindAt", "09:00")))
                .thenComparing(m -> String.valueOf(m.getOrDefault("title", ""))));

        if (upcoming.size() > 4) {
            upcoming = new ArrayList<>(upcoming.subList(0, 4));
        }

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("upcoming", upcoming);
        out.put("enabled", enabled.size());
        return out;
    }

    /** 计算 [today, horizon] 内下一次事件发生日期（用于首页展示）；无法推算时返回 null。 */
    private static LocalDate nextEventDate(Reminder r, LocalDate today, LocalDate horizon) {
        if (Boolean.TRUE.equals(r.getLunar())) {
            return nextLunarYearly(r, today, horizon);
        }
        LocalDate anchor = r.getEventDate();
        if (anchor == null) return null;
        String type = r.getType() == null ? "" : r.getType().trim().toLowerCase();

        if ("".equals(type)) {
            // 单次：未来（含今天）才算 upcoming
            if (!anchor.isBefore(today) && !anchor.isAfter(horizon)) return anchor;
            return null;
        }

        LocalDate start = anchor.isAfter(today) ? anchor : today;
        // 最多向前扫描 horizon 范围
        for (LocalDate d = start; !d.isAfter(horizon); d = d.plusDays(1)) {
            if (d.isBefore(anchor)) continue;
            switch (type) {
                case "daily":
                    return d;
                case "weekly":
                    if (ChronoUnit.DAYS.between(anchor, d) % 7 == 0) return d;
                    break;
                case "monthly":
                    if (isMonthlyHit(anchor, d)) return d;
                    break;
                case "yearly":
                    if (isYearlyHit(anchor, d)) return d;
                    break;
                default:
                    return null;
            }
        }
        return null;
    }

    private static boolean isMonthlyHit(LocalDate anchor, LocalDate d) {
        int dom = Math.min(anchor.getDayOfMonth(), d.lengthOfMonth());
        return d.getDayOfMonth() == dom;
    }

    private static boolean isYearlyHit(LocalDate anchor, LocalDate d) {
        if (anchor.getMonthValue() != d.getMonthValue()) return false;
        int dom = Math.min(anchor.getDayOfMonth(), d.lengthOfMonth());
        return d.getDayOfMonth() == dom;
    }

    private static LocalDate nextLunarYearly(Reminder r, LocalDate today, LocalDate horizon) {
        String type = r.getType() == null ? "" : r.getType().trim().toLowerCase();
        if (!"yearly".equals(type)) return null;
        Integer month = r.getLunarMonth();
        Integer day = r.getLunarDay();
        if (month == null || day == null) return null;
        boolean wantLeap = Boolean.TRUE.equals(r.getLunarLeap());
        int wantMonth = wantLeap ? -month : month;

        // 扫描区间内每天对应农历（最多 31 天循环，范围小，可接受）
        for (LocalDate d = today; !d.isAfter(horizon); d = d.plusDays(1)) {
            try {
                Lunar lunar = Solar.fromYmd(d.getYear(), d.getMonthValue(), d.getDayOfMonth()).getLunar();
                if (lunar.getMonth() == wantMonth && lunar.getDay() == day) {
                    return d;
                }
            } catch (Exception ignored) {
            }
        }
        return null;
    }

    private static List<Integer> offsetsOf(Reminder r) {
        Set<Integer> offsets = new LinkedHashSet<>();
        String json = r.getRemindOffsetsJson();
        if (json != null && !json.isBlank()) {
            for (String part : json.split(",")) {
                try {
                    int n = Integer.parseInt(part.trim());
                    if (n >= 0) offsets.add(n);
                } catch (NumberFormatException ignored) {
                }
            }
        }
        if (offsets.isEmpty() && r.getRemindOffsets() != null) offsets.add(Math.max(0, r.getRemindOffsets()));
        if (offsets.isEmpty()) offsets.add(0);
        List<Integer> list = new ArrayList<>(offsets);
        list.sort(Comparator.reverseOrder());
        return list;
    }

    private Map<String, Object> buildStocks() {
        List<StockWatch> list = stockWatchRepository.findAll(Sort.by("code"));
        List<Map<String, Object>> watch = new ArrayList<>();
        for (StockWatch s : list) {
            if (Boolean.FALSE.equals(s.getEnabled())) continue;
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("id", s.getId());
            m.put("code", s.getCode());
            m.put("name", s.getName());
            m.put("groupName", s.getGroupName());
            m.put("entryPrice", s.getEntryPrice());
            m.put("heavyPrice", s.getHeavyPrice());
            watch.add(m);
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("watch", watch);
        return out;
    }

    private Map<String, Object> buildNotes() {
        List<Note> list = noteRepository.findAll(
                PageRequest.of(0, 4, Sort.by(Sort.Direction.DESC, "updateTime"))).getContent();
        List<Map<String, Object>> latest = new ArrayList<>();
        for (Note n : list) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("id", n.getId());
            m.put("title", n.getTitle());
            m.put("preview", preview(n.getContent(), 90));
            m.put("updateTime", n.getUpdateTime() == null ? null : String.valueOf(n.getUpdateTime()));
            latest.add(m);
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("latest", latest);
        out.put("total", noteRepository.count());
        return out;
    }

    private Map<String, Object> buildZsxq() {
        // 只取星球话题：专栏文章只在专栏页展示，避免首页出现空壳条目
        List<ZsxqTopic> list = zsxqTopicRepository.findMainTopics(
                PageRequest.of(0, 3, Sort.by(Sort.Order.desc("lastCommentTime"),
                        Sort.Order.desc("sourceCreateTime")))).getContent();
        List<Map<String, Object>> latest = new ArrayList<>();
        for (ZsxqTopic t : list) {
            Map<String, Object> m = new LinkedHashMap<>();
            String digest = t.getDigest();
            m.put("id", t.getId());
            m.put("preview", preview(digest, 120));
            m.put("time", t.getLastCommentTime() != null ? t.getLastCommentTime()
                    : (t.getSourceCreateTime() != null ? t.getSourceCreateTime() : null));
            latest.add(m);
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("latest", latest);
        out.put("total", zsxqTopicRepository.countMainTopics());
        return out;
    }

    private static String preview(String text, int max) {
        if (text == null) return "";
        String s = text.replaceAll("\\s+", " ").trim();
        if (s.length() <= max) return s;
        return s.substring(0, max) + "…";
    }
}
