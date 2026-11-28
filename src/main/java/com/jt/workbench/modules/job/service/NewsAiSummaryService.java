package com.jt.workbench.modules.job.service;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import com.jt.workbench.modules.note.util.NoteHtml;
import io.github.jiangood.openadmin.modules.config.service.SysConfigService;
import io.github.jiangood.openadmin.modules.job.JobResult;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.slf4j.Logger;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.Map;

/**
 * 资讯 AI 摘要：为缺少摘要的资讯生成简短中文摘要，缓存到 news_item.ai_summary。
 *
 * <p>调用任意 OpenAI-compatible {@code /chat/completions} 接口（系统参数 {@code news.ai-summary.*}）；
 * 未启用、未配置或调用失败时不改动数据，前端自动回退显示原文。</p>
 *
 * <p>注意：生成摘要会把资讯标题与正文（截断后）发送到所配置的接口；
 * 内容敏感时请配置自建服务或关闭 {@code news.ai-summary.enabled}。</p>
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class NewsAiSummaryService {

    public static final String KEY_ENABLED = "news.ai-summary.enabled";
    public static final String KEY_BASE_URL = "news.ai-summary.base-url";
    public static final String KEY_API_KEY = "news.ai-summary.api-key";
    public static final String KEY_MODEL = "news.ai-summary.model";
    public static final String KEY_BATCH_SIZE = "news.ai-summary.batch-size";
    public static final String KEY_TIMEOUT_SECONDS = "news.ai-summary.timeout-seconds";
    public static final String KEY_PAUSE_SECONDS = "news.ai-summary.pause-seconds";

    public static final String DEFAULT_BASE_URL = "https://text.pollinations.ai/openai";
    public static final String DEFAULT_MODEL = "openai";

    /** 送入模型的正文（去标签纯文本）最大字符数 */
    private static final int MAX_INPUT_CHARS = 6000;
    /** 摘要最大字符数 */
    private static final int MAX_SUMMARY_CHARS = 300;

    private static final String SYSTEM_PROMPT = """
            你是一个中文新闻摘要助手。根据用户提供的标题和正文，用不超过100字的简体中文输出2到3句话的要点摘要。
            只输出摘要本身，不要输出"摘要："等前缀，不要使用 Markdown，不要添加原文没有的信息，不确定的内容不要编造。""";

    private final JdbcTemplate jdbc;
    private final SysConfigService configService;
    private final ObjectMapper objectMapper = new ObjectMapper();

    public JobResult run(Logger logger, java.util.function.Consumer<String> progress) {
        if (!configService.getBool(KEY_ENABLED)) {
            return JobResult.skip("资讯AI摘要未启用");
        }
        String baseUrl = trimTrailingSlash(defaultIfBlank(configService.getString(KEY_BASE_URL), DEFAULT_BASE_URL));
        String apiKey = safe(configService.getString(KEY_API_KEY)).trim();
        String model = defaultIfBlank(configService.getString(KEY_MODEL), DEFAULT_MODEL);
        int batchSize = clamp(configService.getInt(KEY_BATCH_SIZE), 1, 50);
        int timeoutSeconds = clamp(configService.getInt(KEY_TIMEOUT_SECONDS), 10, 300);
        long pauseMs = Math.max(0, configService.getInt(KEY_PAUSE_SECONDS)) * 1000L;

        // summary IS NULL = 未处理；'' = 已处理但无可摘要内容；非空 = 已生成
        List<Map<String, Object>> rows = jdbc.queryForList(
                "SELECT id AS ID, title AS TITLE, content AS CONTENT FROM news_item " +
                "WHERE ai_summary IS NULL AND content IS NOT NULL AND length(content) > 0 " +
                "ORDER BY create_time DESC LIMIT " + batchSize);
        if (rows.isEmpty()) return JobResult.ok("没有待生成摘要的资讯");

        HttpClient client = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(15))
                .followRedirects(HttpClient.Redirect.NORMAL)
                .build();

        int done = 0, failed = 0, skipped = 0;
        for (int i = 0; i < rows.size(); i++) {
            Map<String, Object> row = rows.get(i);
            String id = String.valueOf(row.get("ID"));
            String title = safe(row.get("TITLE") == null ? "" : String.valueOf(row.get("TITLE"))).trim();
            String text = NoteHtml.toPlainText(safe(row.get("CONTENT") == null ? "" : String.valueOf(row.get("CONTENT")))).trim();
            progress.accept("生成摘要 " + (i + 1) + "/" + rows.size());
            if (text.isBlank()) {
                // 无正文可摘要：标记已处理，避免反复重试；前端不显示摘要
                jdbc.update("UPDATE news_item SET ai_summary = '' WHERE id = ?", id);
                skipped++;
                continue;
            }
            try {
                String summary = summarize(client, baseUrl, apiKey, model, timeoutSeconds, title, truncate(text, MAX_INPUT_CHARS));
                if (!summary.isBlank()) {
                    jdbc.update("UPDATE news_item SET ai_summary = ? WHERE id = ?", summary, id);
                    done++;
                } else {
                    failed++;
                }
            } catch (Exception e) {
                failed++;
                logger.warn("资讯AI摘要失败 id={} error={}", id, e.getMessage());
            }
            if (pauseMs > 0 && i < rows.size() - 1) sleep(pauseMs);
        }

        String msg = "生成摘要 " + done + " 条"
                + (skipped > 0 ? "，无正文跳过 " + skipped + " 条" : "")
                + (failed > 0 ? "，失败 " + failed + " 条（保留原文，下轮重试）" : "");
        return failed == 0 ? JobResult.ok(msg) : JobResult.partial(msg);
    }

    // ---------- LLM ----------

    private String summarize(HttpClient client, String baseUrl, String apiKey, String model,
                             int timeoutSeconds, String title, String text) throws Exception {
        String user = "标题：" + title + "\n\n正文：\n" + text;
        String body = objectMapper.writeValueAsString(Map.of(
                "model", model,
                "temperature", 0.3,
                "max_tokens", 300,
                "messages", List.of(
                        Map.of("role", "system", "content", SYSTEM_PROMPT),
                        Map.of("role", "user", "content", user))));
        HttpRequest.Builder builder = HttpRequest.newBuilder(URI.create(baseUrl + "/chat/completions"))
                .timeout(Duration.ofSeconds(timeoutSeconds))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(body, StandardCharsets.UTF_8));
        if (!apiKey.isEmpty()) builder.header("Authorization", "Bearer " + apiKey);
        HttpResponse<String> response = client.send(builder.build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        if (response.statusCode() / 100 != 2) {
            throw new IllegalStateException("HTTP " + response.statusCode() + " " + truncate(safe(response.body()), 200));
        }
        JsonNode root = objectMapper.readTree(response.body());
        String content = root.path("choices").path(0).path("message").path("content").asText("");
        return sanitizeSummary(content);
    }

    /** 清洗模型输出：去前缀/包裹引号/Markdown 标记、压缩空白、限长 */
    private static String sanitizeSummary(String raw) {
        String s = safe(raw).trim();
        s = s.replaceAll("(?s)^```[a-zA-Z]*\\s*", "").replaceAll("(?s)\\s*```$", "").trim();
        s = s.replaceAll("^(摘要|总结|要点)\\s*[:：]\\s*", "").trim();
        s = s.replaceAll("\\*\\*|__", "").trim();
        if (s.length() >= 2 && s.startsWith("\"") && s.endsWith("\"")) s = s.substring(1, s.length() - 1).trim();
        if (s.length() >= 2 && s.startsWith("“") && s.endsWith("”")) s = s.substring(1, s.length() - 1).trim();
        s = s.replaceAll("\\s+", " ").trim();
        return truncate(s, MAX_SUMMARY_CHARS);
    }

    // ---------- utils ----------

    private static String safe(String s) { return s == null ? "" : s; }

    private static String truncate(String s, int max) {
        return s.length() <= max ? s : s.substring(0, max);
    }

    private static String defaultIfBlank(String v, String def) {
        return (v == null || v.isBlank()) ? def : v.trim();
    }

    private static String trimTrailingSlash(String s) {
        String r = s;
        while (r.endsWith("/")) r = r.substring(0, r.length() - 1);
        return r;
    }

    private static int clamp(int v, int min, int max) { return Math.max(min, Math.min(max, v)); }

    private static void sleep(long ms) {
        try { Thread.sleep(ms); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
    }
}
