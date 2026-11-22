package com.jt.workbench.modules.reminder.service;

import com.jt.workbench.modules.reminder.entity.Reminder;
import com.jt.workbench.modules.reminder.repo.ReminderRepository;
import io.github.jiangood.openadmin.modules.mail.MailMessage;
import io.github.jiangood.openadmin.modules.mail.MailSendResult;
import io.github.jiangood.openadmin.modules.mail.service.MailService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;

/**
 * 到期提醒扫描。
 *
 * <p>扫描 enabled=1 的提醒：对每个提前天数计算“今天是否需要发送”，
 * 命中且已过提醒时刻则通过框架 MailService 发送，同一天只发一次。</p>
 *
 * <p>事件日期规则统一由 {@link ReminderOccurrenceCalculator} 提供，与列表倒计时保持一致。</p>
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class ReminderScanService {

    private static final DateTimeFormatter DATE = DateTimeFormatter.ofPattern("yyyy-MM-dd");
    private static final LocalTime DEFAULT_TIME = LocalTime.of(9, 0);

    private final ReminderRepository repository;
    private final MailService mailService;

    private final AtomicBoolean running = new AtomicBoolean(false);

    public boolean isMailConfigured() {
        return mailService.isConfigured();
    }

    /** 发送一封测试邮件，验证 SMTP 与收件人配置。 */
    public MailTestResult sendTestMail() {
        if (!mailService.isConfigured()) {
            return new MailTestResult(false, "邮件通道未配置");
        }
        try {
            MailSendResult result = mailService.trySend(MailMessage.builder()
                    .subject("【提醒】邮件通道测试")
                    .html("<p>这是一封来自个人工作台的测试邮件。</p>"
                            + "<p style='color:#999;font-size:12px'>收到这封邮件说明提醒通道可用。</p>")
                    .build());
            if (!result.success()) {
                return new MailTestResult(false, "发送失败：" + result.error());
            }
            return new MailTestResult(true, "测试邮件已发送");
        } catch (Exception e) {
            return new MailTestResult(false, "发送异常：" + e.getMessage());
        }
    }

    public record MailTestResult(boolean success, String message) {
    }

    /** 供定时作业 / 手动按钮调用；返回可直接展示的统计文案。 */
    public String scan() {
        return scan(log, ignored -> {
        });
    }

    public String scan(Logger logger, Consumer<String> progress) {
        if (!running.compareAndSet(false, true)) {
            return "扫描正在进行，请稍后";
        }
        try {
            List<Reminder> reminders = repository.findByEnabledTrue();
            if (reminders.isEmpty()) return "没有启用的提醒";

            LocalDate today = LocalDate.now();
            LocalTime now = LocalTime.now();
            int sent = 0, failed = 0, skipped = 0;

            for (int i = 0; i < reminders.size(); i++) {
                Reminder reminder = reminders.get(i);
                progress.accept("扫描 " + (i + 1) + "/" + reminders.size());

                Delivery delivery = deliver(reminder, today, now, logger);
                switch (delivery.outcome()) {
                    case SENT -> sent++;
                    case FAILED -> failed++;
                    case SKIPPED -> skipped++;
                }
            }

            return "扫描 " + reminders.size() + " 条，发送 " + sent + " 封，失败 " + failed
                    + " 封，跳过 " + skipped + " 条";
        } finally {
            running.set(false);
        }
    }

    /** 立即检查单条提醒。 */
    public String scanOne(String id) {
        if (!running.compareAndSet(false, true)) {
            return "扫描正在进行，请稍后";
        }
        try {
            Reminder reminder = repository.findById(id).orElse(null);
            if (reminder == null) return "提醒不存在";
            if (!Boolean.TRUE.equals(reminder.getEnabled())) return "提醒已停用";

            Delivery delivery = deliver(reminder, LocalDate.now(), LocalTime.now(), log);
            return delivery.message();
        } finally {
            running.set(false);
        }
    }

    private Delivery deliver(Reminder reminder, LocalDate today, LocalTime now, Logger logger) {
        List<Integer> offsets = ReminderOccurrenceCalculator.offsetsOf(reminder);
        LocalDate occurrence = ReminderOccurrenceCalculator.dueOccurrence(reminder, today, offsets);
        if (occurrence == null) {
            return new Delivery(Outcome.SKIPPED, "今天不在提醒范围内（事件日期与提前天数未命中）");
        }

        LocalTime remindTime = parseTime(reminder.getRemindAt());
        if (now.isBefore(remindTime)) {
            return new Delivery(Outcome.SKIPPED, "未到提醒时刻 " + remindTime);
        }
        if (sentToday(reminder, today)) {
            return new Delivery(Outcome.SKIPPED, "今天已经发送过");
        }

        try {
            MailSendResult result = mailService.trySend(MailMessage.builder()
                    .subject("【提醒】" + reminder.getTitle())
                    .html(buildHtml(reminder, occurrence, today, offsets))
                    .build());
            if (!result.success()) {
                reminder.setLastError(String.valueOf(result.error()));
                repository.save(reminder);
                logger.warn("提醒发送失败 id={} title={} error={}", reminder.getId(), reminder.getTitle(), result.error());
                return new Delivery(Outcome.FAILED, "发送失败：" + result.error());
            }
            reminder.setLastSentAt(System.currentTimeMillis());
            reminder.setLastError(null);
            // 单次提醒发送后自动停用
            if (ReminderOccurrenceCalculator.normalizeType(reminder.getType()).isEmpty()) {
                reminder.setEnabled(false);
            }
            repository.save(reminder);
            return new Delivery(Outcome.SENT, "发送成功");
        } catch (Exception e) {
            reminder.setLastError(e.getMessage());
            repository.save(reminder);
            logger.warn("提醒发送异常 id={} title={} error={}", reminder.getId(), reminder.getTitle(), e.getMessage());
            return new Delivery(Outcome.FAILED, "发送异常：" + e.getMessage());
        }
    }

    private enum Outcome {SENT, FAILED, SKIPPED}

    private record Delivery(Outcome outcome, String message) {
    }

    private static LocalTime parseTime(String value) {
        if (value == null || value.isBlank()) return DEFAULT_TIME;
        try {
            return LocalTime.parse(value.trim());
        } catch (Exception ignored) {
            return DEFAULT_TIME;
        }
    }

    private static boolean sentToday(Reminder reminder, LocalDate today) {
        if (reminder.getLastSentAt() == null) return false;
        LocalDate sent = Instant.ofEpochMilli(reminder.getLastSentAt())
                .atZone(ZoneId.systemDefault()).toLocalDate();
        return !sent.isBefore(today);
    }

    private static String buildHtml(Reminder reminder, LocalDate occurrence, LocalDate today, List<Integer> offsets) {
        StringBuilder sb = new StringBuilder();
        sb.append("<p><strong>").append(escape(reminder.getTitle())).append("</strong></p>");
        if (reminder.getDescription() != null && !reminder.getDescription().isBlank()) {
            sb.append("<p>").append(escape(reminder.getDescription())).append("</p>");
        }
        long days = ChronoUnit.DAYS.between(today, occurrence);
        String when = days > 0 ? "还有 " + days + " 天" : days == 0 ? "就是今天" : "已过 " + (-days) + " 天";
        sb.append("<p>事件日期：").append(occurrence.format(DATE)).append("（").append(when).append("）</p>");
        sb.append("<p style='color:#666'>").append(repeatLabel(reminder.getType())).append(" · ")
                .append(offsetLabel(offsets)).append("</p>");
        sb.append("<p style='color:#999;font-size:12px'>— 个人工作台</p>");
        return sb.toString();
    }

    private static String repeatLabel(String type) {
        if (type == null || type.isBlank()) return "单次";
        return switch (type.toLowerCase()) {
            case "daily" -> "每天";
            case "weekly" -> "每周";
            case "monthly" -> "每月";
            case "yearly" -> "每年";
            default -> type;
        };
    }

    private static String offsetLabel(List<Integer> offsets) {
        List<Integer> leads = offsets.stream().filter(o -> o > 0)
                .sorted(java.util.Comparator.reverseOrder()).toList();
        if (leads.isEmpty()) return "当天提醒";
        return "提前 " + String.join("/", leads.stream().map(String::valueOf).toList())
                + (offsets.contains(0) ? " 天 + 当天" : " 天");
    }

    private static String escape(String value) {
        if (value == null) return "";
        return value.replace("&", "&amp;").replace("<", "&lt;")
                .replace(">", "&gt;").replace("\"", "&quot;");
    }
}
