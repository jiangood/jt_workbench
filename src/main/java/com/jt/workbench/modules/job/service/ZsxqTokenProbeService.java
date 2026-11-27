package com.jt.workbench.modules.job.service;

import io.github.jiangood.openadmin.modules.config.service.SysConfigService;
import io.github.jiangood.openadmin.modules.job.JobResult;
import lombok.RequiredArgsConstructor;
import org.slf4j.Logger;
import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.UUID;

/**
 * 一次性探测任务：验证「仅用 App 端 token」能否换取知识星球附件下载地址。
 *
 * <p>只请求 {@code /v2/files/{fileId}/download_url} 并读取业务响应，不下载文件、不写对象存储；
 * token 与下载地址均不写入日志，避免泄漏。探测通过后应把此实现并入 {@code ZsxqFileService}，
 * 并删除本任务。</p>
 */
@Service
@RequiredArgsConstructor
public class ZsxqTokenProbeService {

    private static final String BASE_URL = "https://api.zsxq.com";
    /** 已知「仅 App 可见」的 PDF 附件；探测任务固定用该文件。 */
    private static final String FILE_ID = "214285122825221";
    private static final String ACCEPT = "application/json, text/plain, */*";
    private static final HttpClient HTTP = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(10))
            .followRedirects(HttpClient.Redirect.NEVER)
            .build();
    private static final JsonMapper MAPPER = JsonMapper.builder().build();

    private final SysConfigService configService;

    /** 用两种 App 版本号各探测一次，任一成功即视为 token 模式可行。 */
    public JobResult probe(Logger logger) {
        String cookie = configService.getString("zsxq.cookie");
        String token = tokenFromCookie(cookie);
        if (token.isEmpty()) {
            String msg = "zsxq.cookie 中未找到 zsxq_access_token，无法探测";
            logger.warn("[Token探测] {}", msg);
            return JobResult.fail(msg);
        }

        StringBuilder summary = new StringBuilder();
        boolean success = false;
        for (String version : new String[]{"2.100.0", "2.83.0"}) {
            String detail = probeOnce(token, version);
            logger.info("[Token探测] appVersion={} {}", version, detail);
            if (summary.length() > 0) summary.append("；");
            summary.append(version).append(": ").append(detail);
            if (detail.startsWith("成功")) {
                success = true;
                break;
            }
        }
        String result = summary.toString();
        return success ? JobResult.ok(result) : JobResult.fail(result);
    }

    /** 发送一次 App 端请求并记录业务响应；返回单一行摘要，不含 token / 下载地址。 */
    private String probeOnce(String token, String appVersion) {
        String path = "/v2/files/" + URLEncoder.encode(FILE_ID, StandardCharsets.UTF_8) + "/download_url";
        try {
            HttpRequest request = HttpRequest.newBuilder(URI.create(BASE_URL + path))
                    .timeout(Duration.ofSeconds(20))
                    .header("Accept", ACCEPT)
                    .header("Accept-Language", "zh-CN")
                    .header("User-Agent", "xiaomiquan/" + appVersion + " SDK/1.0.0")
                    .header("authorization", token)
                    .header("x-request-id", UUID.randomUUID().toString())
                    .header("x-version", appVersion)
                    .header("x-aduid", UUID.randomUUID().toString())
                    .GET()
                    .build();
            HttpResponse<String> response = HTTP.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            String body = response.body() == null ? "" : response.body();
            JsonNode root = MAPPER.readTree(body);
            boolean succeeded = root.path("succeeded").asBoolean(false);
            int code = root.path("code").asInt(response.statusCode());
            String error = brief(root.path("error").asText(""), 120);
            String info = brief(root.path("info").asText(""), 120);
            JsonNode data = root.get("resp_data");
            String url = data == null || data.isNull() ? "" : data.path("download_url").asText("");
            String detail = "http=" + response.statusCode() + " succeeded=" + succeeded
                    + " code=" + code + " error=" + error + " info=" + info
                    + " downloadUrl=" + (url.isBlank() ? "no" : "yes(host=" + host(url) + ")");
            return succeeded && !url.isBlank() ? "成功 " + detail : "失败 " + detail;
        } catch (Exception e) {
            return "失败 请求异常 " + brief(e.getClass().getSimpleName() + ": " + e.getMessage(), 200);
        }
    }

    /** 从完整 Cookie 中取出 zsxq_access_token；找不到时返回空串。 */
    static String tokenFromCookie(String cookie) {
        if (cookie == null || cookie.isBlank()) return "";
        for (String part : cookie.split(";")) {
            String item = part.trim();
            int eq = item.indexOf('=');
            if (eq > 0 && "zsxq_access_token".equals(item.substring(0, eq).trim())) {
                return item.substring(eq + 1).trim();
            }
        }
        return "";
    }

    private static String brief(String value, int max) {
        String text = value == null ? "" : value.trim();
        return text.length() <= max ? text : text.substring(0, max) + "…";
    }

    /** 只记录下载地址的主机名，避免把带签名的完整 URL 写进日志。 */
    private static String host(String url) {
        try {
            String value = URI.create(url).getHost();
            return value == null || value.isBlank() ? "unknown" : value;
        } catch (Exception e) {
            return "unknown";
        }
    }
}
