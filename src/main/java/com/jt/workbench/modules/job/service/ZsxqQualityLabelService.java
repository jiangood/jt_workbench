package com.jt.workbench.modules.job.service;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
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
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;

/**
 * 用 AI 批量标注知识星球话题质量（DRY/WATER/SKIP）。
 *
 * <p>默认对接免 key 的 Pollinations OpenAI-compatible 接口，也可配置为任意兼容接口。
 * 只标记高置信 DRY/WATER；SKIP、解析失败、接口异常不写库。</p>
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class ZsxqQualityLabelService {

    private static final String CFG_ENABLED = "zsxq.ai-label.enabled";
    private static final String CFG_BASE_URL = "zsxq.ai-label.base-url";
    private static final String CFG_API_KEY = "zsxq.ai-label.api-key";
    private static final String CFG_MODEL = "zsxq.ai-label.model";
    private static final String CFG_BATCH = "zsxq.ai-label.batch-size";
    private static final String CFG_TIMEOUT = "zsxq.ai-label.timeout-seconds";
    private static final String CFG_PAUSE = "zsxq.ai-label.pause-seconds";

    private static final String DEFAULT_BASE_URL = "https://text.pollinations.ai/openai";
    private static final String DEFAULT_MODEL = "openai";
    private static final int DEFAULT_BATCH = 10;
    private static final int DEFAULT_TIMEOUT = 60;
    private static final int DEFAULT_PAUSE = 45;
    private static final int MAX_DIGEST = 500;

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private final JdbcTemplate jdbc;
    private final SysConfigService configService;

    private final HttpClient httpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(20))
            .followRedirects(HttpClient.Redirect.NORMAL)
            .build();

    public JobResult run(Logger logger, Consumer<String> progress) {
        if (!configService.getBool(CFG_ENABLED)) {
            return JobResult.skip("AI 标注未启用（zsxq.ai-label.enabled=false）");
        }
        String baseUrl = trimToNull(configService.getString(CFG_BASE_URL));
        if (baseUrl == null) baseUrl = DEFAULT_BASE_URL;
        String model = trimToNull(configService.getString(CFG_MODEL));
        if (model == null) model = DEFAULT_MODEL;
        String apiKey = trimToNull(configService.getString(CFG_API_KEY));
        int batchSize = intConfig(CFG_BATCH, DEFAULT_BATCH, 1, 30);
        int timeoutSeconds = intConfig(CFG_TIMEOUT, DEFAULT_TIMEOUT, 10, 180);
        int pauseSeconds = intConfig(CFG_PAUSE, DEFAULT_PAUSE, 0, 120);

        List<Map<String, Object>> pending = fetchPending(batchSize);
        if (pending.isEmpty()) {
            return JobResult.skip("没有待标注的话题");
        }

        logInfo(logger, "AI标注开始：待处理 {} 条，model={}，baseUrl={}", pending.size(), model, safeUrl(baseUrl));
        progress.accept("待处理 " + pending.size() + " 条");

        String prompt = buildPrompt(pending);
        String content;
        try {
            content = callChat(baseUrl, apiKey, model, prompt, timeoutSeconds);
        } catch (Exception e) {
            logWarn(logger, "AI 调用失败：{}", e.getMessage());
            return JobResult.fail("AI 调用失败：" + abbreviate(e.getMessage(), 180));
        }

        List<Label> labels = parseLabels(content);
        if (labels.isEmpty()) {
            logWarn(logger, "AI 返回无法解析，原始内容前200字：{}", abbreviate(content, 200));
            return JobResult.fail("AI 返回无法解析");
        }

        int dry = 0, water = 0, skip = 0, missing = 0;
        for (Label label : labels) {
            if (label.id == null) continue;
            if (!"DRY".equals(label.quality) && !"WATER".equals(label.quality)) {
                skip++;
                continue;
            }
            int updated = jdbc.update(
                    "UPDATE zsxq_topic SET quality = ? WHERE id = ? AND (quality IS NULL OR quality = '')",
                    label.quality, label.id);
            if (updated > 0) {
                if ("DRY".equals(label.quality)) dry++; else water++;
                logInfo(logger, "标记 {} id={} reason={}", label.quality, label.id, abbreviate(label.reason, 80));
            } else {
                missing++;
            }
        }

        if (pauseSeconds > 0) {
            try { Thread.sleep(pauseSeconds * 1000L); } catch (InterruptedException ie) { Thread.currentThread().interrupt(); }
        }

        String msg = String.format("AI标注完成：干货%d 水帖%d 跳过%d 未命中%d（共返回%d）", dry, water, skip, missing, labels.size());
        logInfo(logger, msg);
        progress.accept(msg);
        if (dry + water == 0 && skip == 0) return JobResult.fail(msg);
        return JobResult.ok(msg);
    }

    private List<Map<String, Object>> fetchPending(int limit) {
        return jdbc.queryForList(
                "SELECT id, topic_id, author, source_create_time, digest, article_title " +
                        "FROM zsxq_topic " +
                        "WHERE (quality IS NULL OR quality = '') " +
                        "AND (column_id IS NULL OR column_id = '') " +
                        "ORDER BY source_create_time DESC " +
                        "LIMIT ?",
                limit);
    }

    private String buildPrompt(List<Map<String, Object>> items) {
        StringBuilder sb = new StringBuilder();
        sb.append("你是投资内容分类助手。请判断每条知识星球帖子是“干货(DRY)”还是“水帖(WATER)”。\n");
        sb.append("标准：对投资有益（分析、数据、逻辑、经验教训、策略、行业/公司信息）=DRY；没啥含金量（告别、情绪吐槽、闲聊、无信息量短句）=WATER；拿不准=SKIP。\n");
        sb.append("只输出JSON数组，不要Markdown，不要解释。格式：[{\"id\":\"...\",\"quality\":\"DRY|WATER|SKIP\",\"reason\":\"简短理由\"}]\n\n");
        sb.append("待分类帖子：\n");
        for (int i = 0; i < items.size(); i++) {
            Map<String, Object> it = items.get(i);
            String id = str(it.get("id"));
            String author = str(it.get("author"));
            String title = str(it.get("article_title"));
            String digest = abbreviate(str(it.get("digest")), MAX_DIGEST);
            sb.append(i + 1).append(". id=").append(id)
                    .append(" | author=").append(author)
                    .append(" | title=").append(title)
                    .append("\ncontent: ").append(digest).append("\n\n");
        }
        return sb.toString();
    }

    private String callChat(String baseUrl, String apiKey, String model, String prompt, int timeoutSeconds) throws Exception {
        String endpoint = normalizeEndpoint(baseUrl);
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("model", model);
        body.put("messages", List.of(
                Map.of("role", "system", "content", "你只输出JSON数组。"),
                Map.of("role", "user", "content", prompt)
        ));
        body.put("temperature", 0.1);

        HttpRequest.Builder b = HttpRequest.newBuilder()
                .uri(URI.create(endpoint))
                .timeout(Duration.ofSeconds(timeoutSeconds))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(MAPPER.writeValueAsString(body)));
        if (apiKey != null && !apiKey.isBlank()) {
            b.header("Authorization", "Bearer " + apiKey);
        }
        HttpResponse<String> resp = httpClient.send(b.build(), HttpResponse.BodyHandlers.ofString());
        if (resp.statusCode() / 100 != 2) {
            throw new IllegalStateException("HTTP " + resp.statusCode() + ": " + abbreviate(resp.body(), 200));
        }
        JsonNode root = MAPPER.readTree(resp.body());
        JsonNode content = root.path("choices").path(0).path("message").path("content");
        if (content.isMissingNode() || content.isNull()) {
            throw new IllegalStateException("响应缺少 choices[0].message.content");
        }
        return content.asText();
    }

    private String normalizeEndpoint(String baseUrl) {
        String u = baseUrl.trim();
        while (u.endsWith("/")) u = u.substring(0, u.length() - 1);
        if (u.endsWith("/chat/completions")) return u;
        if (u.endsWith("/v1")) return u + "/chat/completions";
        // Pollinations uses /openai as OpenAI-compatible base
        return u + "/chat/completions";
    }

    private List<Label> parseLabels(String content) {
        String json = extractJsonArray(content);
        if (json == null) return List.of();
        try {
            JsonNode arr = MAPPER.readTree(json);
            if (!arr.isArray()) return List.of();
            List<Label> out = new ArrayList<>();
            for (JsonNode n : arr) {
                Label l = new Label();
                l.id = textOrNull(n, "id");
                l.quality = normalizeQuality(textOrNull(n, "quality"));
                l.reason = textOrNull(n, "reason");
                if (l.id != null) out.add(l);
            }
            return out;
        } catch (Exception e) {
            log.warn("解析 AI 标注结果失败: {}", e.getMessage());
            return List.of();
        }
    }

    private String extractJsonArray(String content) {
        if (content == null) return null;
        String s = content.trim();
        // strip markdown fences
        if (s.startsWith("```")) {
            int nl = s.indexOf('\n');
            if (nl > 0) s = s.substring(nl + 1);
            int end = s.lastIndexOf("```");
            if (end >= 0) s = s.substring(0, end).trim();
        }
        int a = s.indexOf('[');
        int b = s.lastIndexOf(']');
        if (a >= 0 && b > a) return s.substring(a, b + 1);
        return null;
    }

    private static String normalizeQuality(String q) {
        if (q == null) return "SKIP";
        String u = q.trim().toUpperCase();
        if ("DRY".equals(u) || "WATER".equals(u) || "SKIP".equals(u)) return u;
        return "SKIP";
    }

    private static String textOrNull(JsonNode n, String field) {
        JsonNode v = n.get(field);
        if (v == null || v.isNull()) return null;
        String s = v.asText();
        return (s == null || s.isBlank()) ? null : s.trim();
    }

    private static String str(Object o) {
        return o == null ? "" : String.valueOf(o).trim();
    }

    private static String trimToNull(String s) {
        if (s == null) return null;
        String t = s.trim();
        return t.isEmpty() ? null : t;
    }

    private int intConfig(String key, int def, int min, int max) {
        int value = configService.getInt(key);
        return value < min || value > max ? def : value;
    }

    private static int clamp(int v, int min, int max) {
        return Math.max(min, Math.min(max, v));
    }

    private static String abbreviate(String s, int max) {
        if (s == null) return "";
        if (s.length() <= max) return s;
        return s.substring(0, max) + "...";
    }

    private static String safeUrl(String url) {
        try { URI u = URI.create(url); return u.getScheme() + "://" + u.getHost(); } catch (Exception e) { return "<invalid>"; }
    }

    private static void logInfo(Logger logger, String fmt, Object... args) {
        logger.info(fmt, args);
        log.info(fmt, args);
    }

    private static void logWarn(Logger logger, String fmt, Object... args) {
        logger.warn(fmt, args);
        log.warn(fmt, args);
    }

    private static class Label {
        String id;
        String quality;
        String reason;
    }
}
