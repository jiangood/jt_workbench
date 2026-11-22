package com.jt.workbench.modules.reminder.service;

import com.jt.workbench.modules.reminder.entity.Reminder;
import com.nlf.calendar.Lunar;
import com.nlf.calendar.Solar;

import java.time.LocalDate;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * 提醒发生日期计算（唯一实现）。
 *
 * <p>列表倒计时与定时扫描必须共用这里的规则，避免“页面显示 3 天后、实际不发”的不一致：
 * 每月/每年按锚点日期的“当月最后一天收敛”规则计算（如 1 月 31 日的每月提醒，2 月落在 28/29 日），
 * 农历每年提醒按农历月/日（含闰月）匹配。</p>
 */
public final class ReminderOccurrenceCalculator {

    /** 常规公历提醒向前推算的最大天数（覆盖“提前 30 天”等场景）。 */
    public static final int DEFAULT_LOOKAHEAD_DAYS = 400;

    private ReminderOccurrenceCalculator() {
    }

    /** 指定日期是否是提醒的一次发生（当天）。 */
    public static boolean matches(Reminder reminder, LocalDate date) {
        if (reminder == null || date == null) return false;
        if (Boolean.TRUE.equals(reminder.getLunar())) {
            return matchesLunar(reminder, date);
        }
        LocalDate anchor = reminder.getEventDate();
        if (anchor == null || date.isBefore(anchor)) return false;
        return switch (normalizeType(reminder.getType())) {
            case "" -> date.equals(anchor);
            case "daily" -> true;
            case "weekly" -> ChronoUnit.DAYS.between(anchor, date) % 7 == 0;
            case "monthly" -> date.getDayOfMonth() == clampDayOfMonth(anchor, date);
            case "yearly" -> date.getMonthValue() == anchor.getMonthValue()
                    && date.getDayOfMonth() == clampDayOfMonth(anchor, date);
            default -> false;
        };
    }

    /** 从 from（含）开始的下一次发生日期；推算不到返回 null。 */
    public static LocalDate nextOccurrence(Reminder reminder, LocalDate from) {
        return nextOccurrence(reminder, from, DEFAULT_LOOKAHEAD_DAYS);
    }

    public static LocalDate nextOccurrence(Reminder reminder, LocalDate from, int lookaheadDays) {
        if (reminder == null || from == null) return null;

        LocalDate anchor = reminder.getEventDate();
        if (anchor != null && anchor.isAfter(from.plusDays(lookaheadDays))) {
            // 首次发生还在很远的未来（如提前两年建好的纪念日），直接返回锚点。
            return anchor;
        }

        LocalDate limit = from.plusDays(Math.max(0, lookaheadDays));
        for (LocalDate date = from; !date.isAfter(limit); date = date.plusDays(1)) {
            if (matches(reminder, date)) return date;
        }
        return null;
    }

    /**
     * 按提前提醒天数，判断今天是否需要发送；需要发送时返回“那一次事件”的日期。
     * 例如事件在 30 天后、配置提前 30 天，则今天命中并返回 30 天后的日期。
     */
    public static LocalDate dueOccurrence(Reminder reminder, LocalDate today, List<Integer> offsets) {
        if (reminder == null || today == null || offsets == null) return null;
        for (int offset : offsets) {
            LocalDate candidate = today.plusDays(Math.max(0, offset));
            if (matches(reminder, candidate)) return candidate;
        }
        return null;
    }

    /** 读取提醒的提前天数列表；兼容旧的单值字段与逗号分隔字段。 */
    public static List<Integer> offsetsOf(Reminder reminder) {
        Set<Integer> offsets = new LinkedHashSet<>();
        String raw = reminder == null ? null : reminder.getRemindOffsetsJson();
        if (raw != null && !raw.isBlank()) {
            for (String part : raw.split(",")) {
                try {
                    int value = Integer.parseInt(part.trim());
                    if (value >= 0) offsets.add(value);
                } catch (NumberFormatException ignored) {
                }
            }
        }
        if (offsets.isEmpty() && reminder != null && reminder.getRemindOffsets() != null) {
            offsets.add(Math.max(0, reminder.getRemindOffsets()));
        }
        if (offsets.isEmpty()) offsets.add(0);
        return new ArrayList<>(offsets);
    }

    public static String normalizeType(String type) {
        return type == null ? "" : type.trim().toLowerCase();
    }

    private static int clampDayOfMonth(LocalDate anchor, LocalDate date) {
        return Math.min(anchor.getDayOfMonth(), date.lengthOfMonth());
    }

    private static boolean matchesLunar(Reminder reminder, LocalDate date) {
        if (!"yearly".equals(normalizeType(reminder.getType()))) return false;
        Integer month = reminder.getLunarMonth();
        Integer day = reminder.getLunarDay();
        if (month == null || day == null) return false;
        boolean wantLeap = Boolean.TRUE.equals(reminder.getLunarLeap());
        int wantMonth = wantLeap ? -month : month;
        try {
            Lunar lunar = Solar.fromYmd(date.getYear(), date.getMonthValue(), date.getDayOfMonth()).getLunar();
            return lunar.getMonth() == wantMonth && lunar.getDay() == day;
        } catch (Exception ignored) {
            return false;
        }
    }
}
