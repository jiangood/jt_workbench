package com.jt.workbench.modules.reminder.controller;

import com.jt.workbench.modules.reminder.entity.Reminder;
import com.jt.workbench.modules.reminder.repo.ReminderRepository;
import com.jt.workbench.modules.reminder.service.ReminderOccurrenceCalculator;
import com.jt.workbench.modules.reminder.service.ReminderScanService;
import com.nlf.calendar.Lunar;
import com.nlf.calendar.Solar;
import io.github.jiangood.openadmin.framework.data.PageExt;
import io.github.jiangood.openadmin.framework.perm.HasPermission;
import io.github.jiangood.openadmin.util.dto.AjaxResult;
import io.github.jiangood.openadmin.util.dto.IdReq;
import org.springframework.beans.BeanUtils;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.domain.PageImpl;
import org.springframework.data.domain.Pageable;
import org.springframework.data.web.PageableDefault;
import org.springframework.web.bind.annotation.*;

import java.beans.PropertyDescriptor;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 提醒：列表 / 增删改 / 手动触发扫描。
 * 实际发送由进程内定时作业（reminder_scan）执行，这里也可以手动即时扫描。
 */
@RestController
@RequestMapping("admin/reminder")
public class ReminderController {

    /** 预览最多向前找 5 年，覆盖每年/农历提醒的接下来几次。 */
    private static final int PREVIEW_LOOKAHEAD_DAYS = 366 * 5;
    private static final String[] WEEKDAYS = {"周一", "周二", "周三", "周四", "周五", "周六", "周日"};

    @Autowired
    private ReminderRepository reminderRepository;

    @Autowired
    private ReminderScanService reminderScanService;

    @HasPermission("reminder:read")
    @PostMapping("page")
    public AjaxResult page(@PageableDefault(size = 20) Pageable pageable,
                           @RequestParam(required = false) String type,
                           @RequestParam(required = false) String keyword,
                           @RequestParam(required = false) Boolean enabled,
                           @RequestParam(required = false) String scope) {
        LocalDate today = LocalDate.now();
        List<Row> allRows = reminderRepository
                .searchAll(blankToNull(keyword), blankToNull(type), enabled)
                .stream()
                .map(reminder -> buildRow(reminder, today))
                .toList();
        long todayCount = allRows.stream().filter(row -> row.days() != null && row.days() == 0).count();
        long weekCount = allRows.stream()
                .filter(row -> row.days() != null && row.days() >= 0 && row.days() <= 7)
                .count();

        List<Row> rows = new ArrayList<>(allRows.stream().filter(row -> inScope(row, scope)).toList());
        rows.sort(Comparator
                .comparing((Row row) -> !Boolean.TRUE.equals(row.reminder().getEnabled()))
                .thenComparing(Row::next, Comparator.nullsLast(Comparator.naturalOrder()))
                .thenComparing(row -> row.reminder().getUpdateTime(),
                        Comparator.nullsLast(Comparator.reverseOrder())));

        int size = pageable.isPaged() ? pageable.getPageSize() : rows.size();
        int from = pageable.isPaged() ? Math.min(pageable.getPageNumber() * size, rows.size()) : 0;
        int to = size <= 0 ? from : Math.min(from + size, rows.size());
        List<Map<String, Object>> content = rows.subList(from, to).stream()
                .map(Row::view)
                .toList();

        PageExt<Map<String, Object>> result = PageExt.of(new PageImpl<>(content, pageable, rows.size()));
        result.putExtData("summary", "共 " + allRows.size() + " 条 · 今天 " + todayCount
                + " 条 · 7 天内 " + weekCount + " 条");
        return new AjaxResult().ok().data(result);
    }

    private static Row buildRow(Reminder reminder, LocalDate today) {
        Map<String, Object> view = toMap(reminder);
        LocalDate next = ReminderOccurrenceCalculator.nextOccurrence(reminder, today);
        Integer days = next == null ? null : (int) ChronoUnit.DAYS.between(today, next);
        boolean expired = next == null && isSingleExpired(reminder, today);
        boolean sentToday = sentToday(reminder, today);

        view.put("countdownDays", days);
        view.put("nextOccurrenceDate", next == null ? null : next.toString());
        view.put("expired", expired);
        view.put("sentToday", sentToday);
        view.put("status", statusOf(reminder, sentToday, expired));
        return new Row(reminder, view, next, days, expired);
    }

    private static boolean inScope(Row row, String scope) {
        if (scope == null || scope.isBlank()) return true;
        return switch (scope.trim().toLowerCase()) {
            case "today" -> row.days() != null && row.days() == 0;
            case "week" -> row.days() != null && row.days() >= 0 && row.days() <= 7;
            case "overdue" -> row.expired();
            default -> true;
        };
    }

    private static String statusOf(Reminder reminder, boolean sentToday, boolean expired) {
        if (reminder.getLastError() != null && !reminder.getLastError().isBlank()) return "error";
        boolean single = ReminderOccurrenceCalculator.normalizeType(reminder.getType()).isEmpty();
        if (!Boolean.TRUE.equals(reminder.getEnabled())) {
            return single && reminder.getLastSentAt() != null ? "done" : "disabled";
        }
        if (sentToday) return "sent";
        if (expired) return "expired";
        return "pending";
    }

    private static boolean isSingleExpired(Reminder reminder, LocalDate today) {
        return !Boolean.TRUE.equals(reminder.getLunar())
                && ReminderOccurrenceCalculator.normalizeType(reminder.getType()).isEmpty()
                && reminder.getEventDate() != null
                && reminder.getEventDate().isBefore(today);
    }

    private static boolean sentToday(Reminder reminder, LocalDate today) {
        if (reminder.getLastSentAt() == null) return false;
        LocalDate sent = Instant.ofEpochMilli(reminder.getLastSentAt())
                .atZone(ZoneId.systemDefault()).toLocalDate();
        return !sent.isBefore(today);
    }

    private static Map<String, Object> toMap(Reminder reminder) {
        Map<String, Object> map = new LinkedHashMap<>();
        for (PropertyDescriptor pd : BeanUtils.getPropertyDescriptors(Reminder.class)) {
            String name = pd.getName();
            if ("class".equals(name) || pd.getReadMethod() == null) continue;
            try {
                map.put(name, pd.getReadMethod().invoke(reminder));
            } catch (Exception ignored) {
            }
        }
        return map;
    }

    @HasPermission("reminder:read")
    @GetMapping("info/{id}")
    public AjaxResult info(@PathVariable String id) {
        Reminder item = reminderRepository.findById(id).orElse(null);
        return item != null ? new AjaxResult().ok().data(item) : new AjaxResult();
    }

    /** 表单预览：根据尚未保存的日期/重复方式/农历，返回接下来最多 3 次发生日期。 */
    @HasPermission("reminder:read")
    @PostMapping("preview")
    public AjaxResult preview(@RequestBody Reminder input) {
        Reminder preview = new Reminder();
        boolean lunar = Boolean.TRUE.equals(input.getLunar());
        preview.setLunar(lunar);
        preview.setType(lunar ? "yearly" : blankToNull(input.getType()));
        preview.setEventDate(lunar ? null : input.getEventDate());
        preview.setLunarMonth(lunar ? input.getLunarMonth() : null);
        preview.setLunarDay(lunar ? input.getLunarDay() : null);
        preview.setLunarLeap(lunar && Boolean.TRUE.equals(input.getLunarLeap()));

        if (lunar && (preview.getLunarMonth() == null || preview.getLunarDay() == null)) {
            return new AjaxResult().ok().data(List.of());
        }
        if (!lunar && preview.getEventDate() == null) {
            return new AjaxResult().ok().data(List.of());
        }

        LocalDate today = LocalDate.now();
        LocalDate cursor = today;
        List<Map<String, Object>> occurrences = new ArrayList<>();
        for (int i = 0; i < 3; i++) {
            LocalDate next = ReminderOccurrenceCalculator.nextOccurrence(preview, cursor, PREVIEW_LOOKAHEAD_DAYS);
            if (next == null) break;

            Map<String, Object> item = new LinkedHashMap<>();
            item.put("date", next.toString());
            item.put("weekday", WEEKDAYS[next.getDayOfWeek().getValue() - 1]);
            item.put("days", (int) ChronoUnit.DAYS.between(today, next));
            if (lunar) item.put("lunar", lunarText(next));
            occurrences.add(item);
            cursor = next.plusDays(1);
        }
        return new AjaxResult().ok().data(occurrences);
    }

    private static String lunarText(LocalDate date) {
        try {
            Lunar lunar = Solar.fromYmd(date.getYear(), date.getMonthValue(), date.getDayOfMonth()).getLunar();
            return lunar.getMonthInChinese() + "月" + lunar.getDayInChinese();
        } catch (Exception ignored) {
            return null;
        }
    }

    /** 表单保存（新建/编辑）：全量写入，允许把重复方式清空为单次、清空备注等。 */
    @HasPermission("reminder:edit")
    @PostMapping("save")
    public AjaxResult save(@RequestBody Reminder input) {
        String title = trimToNull(input.getTitle());
        if (title == null) return AjaxResult.err("请填写标题");

        boolean lunar = Boolean.TRUE.equals(input.getLunar());
        String type = lunar ? "yearly" : blankToNull(input.getType());
        if (lunar && (input.getLunarMonth() == null || input.getLunarDay() == null)) {
            return AjaxResult.err("请填写农历月日");
        }
        if (!lunar && input.getEventDate() == null) {
            return AjaxResult.err("请选择事件日期");
        }
        String remindAt = normalizeTime(input.getRemindAt());
        if (remindAt == null) return AjaxResult.err("提醒时刻格式应为 HH:mm，如 09:00");

        List<Integer> offsets = ReminderOccurrenceCalculator.offsetsOf(input);
        offsets = offsets.stream().map(offset -> Math.min(3650, Math.max(0, offset)))
                .distinct().sorted(Comparator.reverseOrder()).toList();

        Reminder target;
        String id = trimToNull(input.getId());
        if (id == null) {
            target = new Reminder();
        } else {
            target = reminderRepository.findById(id).orElse(null);
            if (target == null) return AjaxResult.err("提醒不存在");
        }

        target.setTitle(title);
        target.setDescription(trimToNull(input.getDescription()));
        target.setType(type);
        target.setLunar(lunar);
        if (lunar) {
            target.setLunarMonth(input.getLunarMonth());
            target.setLunarDay(input.getLunarDay());
            target.setLunarLeap(Boolean.TRUE.equals(input.getLunarLeap()));
        } else {
            target.setLunarMonth(null);
            target.setLunarDay(null);
            target.setLunarLeap(null);
        }
        target.setRemindOffsets(offsets.stream().mapToInt(Integer::intValue).max().orElse(0));
        target.setRemindOffsetsJson(offsets.stream().map(String::valueOf)
                .collect(java.util.stream.Collectors.joining(",")));
        target.setRemindAt(remindAt);
        target.setEventDate(lunar ? null : input.getEventDate());
        target.setEnabled(input.getEnabled() == null || input.getEnabled());

        return new AjaxResult().ok().data(reminderRepository.save(target));
    }

    @HasPermission("reminder:edit")
    @PostMapping("create")
    public AjaxResult create(@RequestBody Reminder input) {
        return new AjaxResult().ok().data(reminderRepository.save(input));
    }

    /** 局部更新（启停等）；表单编辑请使用 save，避免 null 无法清空旧值。 */
    @HasPermission("reminder:edit")
    @PostMapping("update")
    public AjaxResult update(@RequestBody Reminder input) {
        Reminder old = reminderRepository.findById(input.getId()).orElse(null);
        if (old != null) {
            if (input.getTitle() != null) old.setTitle(input.getTitle());
            if (input.getDescription() != null) old.setDescription(input.getDescription());
            if (input.getType() != null) old.setType(input.getType());
            if (input.getLunar() != null) old.setLunar(input.getLunar());
            old.setLunarMonth(input.getLunarMonth());
            old.setLunarDay(input.getLunarDay());
            old.setLunarLeap(input.getLunarLeap());
            if (input.getRemindOffsets() != null) old.setRemindOffsets(input.getRemindOffsets());
            if (input.getRemindOffsetsJson() != null) old.setRemindOffsetsJson(input.getRemindOffsetsJson());
            if (input.getRemindAt() != null) old.setRemindAt(input.getRemindAt());
            if (input.getEventDate() != null) old.setEventDate(input.getEventDate());
            if (input.getEnabled() != null) old.setEnabled(input.getEnabled());
            reminderRepository.save(old);
        }
        return new AjaxResult();
    }

    @HasPermission("reminder:edit")
    @PostMapping("toggle")
    public AjaxResult toggle(@RequestBody Reminder input) {
        Reminder old = reminderRepository.findById(input.getId()).orElse(null);
        if (old == null) return AjaxResult.err("提醒不存在");
        old.setEnabled(input.getEnabled() == null ? !Boolean.TRUE.equals(old.getEnabled()) : input.getEnabled());
        reminderRepository.save(old);
        return new AjaxResult();
    }

    @HasPermission("reminder:edit")
    @PostMapping("delete")
    public AjaxResult delete(@RequestBody IdReq req) {
        reminderRepository.deleteById(req.getId());
        return new AjaxResult();
    }

    /** 邮件通道是否已配置（页面用于提示用户“现在发不出去”）。 */
    @HasPermission("reminder:read")
    @GetMapping("meta")
    public AjaxResult meta() {
        return new AjaxResult().ok().data(Map.of(
                "mailConfigured", reminderScanService.isMailConfigured(),
                "today", LocalDate.now().toString()
        ));
    }

    /** 发送测试邮件，验证 SMTP / 收件人配置。 */
    @HasPermission("reminder:edit")
    @PostMapping("test-mail")
    public AjaxResult testMail() {
        ReminderScanService.MailTestResult result = reminderScanService.sendTestMail();
        return result.success()
                ? new AjaxResult().ok().data(result.message())
                : AjaxResult.err(result.message());
    }

    /** 立即扫描全部启用提醒（真实发送，返回发送统计）。 */
    @HasPermission("reminder:edit")
    @PostMapping("scan")
    public AjaxResult scanAll() {
        return new AjaxResult().ok().data(reminderScanService.scan());
    }

    /** 立即检查单条提醒。 */
    @HasPermission("reminder:edit")
    @PostMapping("{id}/scan")
    public AjaxResult scan(@PathVariable String id) {
        return new AjaxResult().ok().data(reminderScanService.scanOne(id));
    }

    private static String normalizeTime(String value) {
        String time = trimToNull(value);
        if (time == null) return "09:00";
        return time.matches("^([01]\\d|2[0-3]):[0-5]\\d$") ? time : null;
    }

    private static String blankToNull(String value) {
        return value == null || value.isBlank() ? null : value.trim();
    }

    private static String trimToNull(String value) {
        return value == null || value.isBlank() ? null : value.trim();
    }

    private record Row(Reminder reminder, Map<String, Object> view, LocalDate next,
                       Integer days, boolean expired) {
    }
}
