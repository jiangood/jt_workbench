package com.jt.workbench.modules.zsxq.client;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.PropertyNamingStrategies;
import tools.jackson.databind.json.JsonMapper;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.io.IOException;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.HexFormat;
import java.util.Map;
import java.util.StringJoiner;
import java.util.UUID;

/**
 * 知识星球只读接口的最小 HTTP 客户端（项目内源码，不再依赖 zsxq-sdk）。
 *
 * <p>保留官方/社区 SDK 的请求协议：{@code authorization} token、{@code x-timestamp} +
 * {@code x-signature}（HMAC-SHA1）、{@code x-version}、{@code x-aduid}、{@code x-request-id}。
 * 与 SDK 的关键区别是响应直接解析成强类型模型，ID 全部按字符串处理，不经过 Map/Double 中转。</p>
 *
 * <p>设备号、App 版本、User-Agent、Cookie 都可以从系统参数传入，便于按浏览器实际情况调整。</p>
 */
public class ZsxqApiClient {

    private static final String BASE_URL = "https://api.zsxq.com";
    private static final String DEFAULT_SIGNATURE_KEY = "zsxq-sdk-secret";
    private static final String DEFAULT_APP_VERSION = "2.100.0";
    private static final int DEFAULT_TIMEOUT_SECONDS = 20;
    private static final int DEFAULT_RETRY_COUNT = 3;

    private final String token;
    private final String deviceId;
    private final String appVersion;
    private final String userAgent;
    private final String cookie;
    private final String signatureKey;
    private final int retryCount;
    private final Duration timeout;
    private final HttpClient http;
    private final ObjectMapper mapper;

    public ZsxqApiClient(String token, String deviceId, String appVersion, String userAgent, String cookie) {
        this.token = token;
        this.deviceId = deviceId == null ? "" : deviceId.trim();
        this.appVersion = blankToDefault(appVersion, DEFAULT_APP_VERSION);
        this.userAgent = blankToDefault(userAgent, "xiaomiquan/" + this.appVersion + " SDK/1.0.0");
        this.cookie = cookie == null ? "" : cookie.trim();
        this.signatureKey = DEFAULT_SIGNATURE_KEY;
        this.retryCount = DEFAULT_RETRY_COUNT;
        this.timeout = Duration.ofSeconds(DEFAULT_TIMEOUT_SECONDS);
        this.http = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(10))
                .build();
        this.mapper = JsonMapper.builder()
                .propertyNamingStrategy(PropertyNamingStrategies.SNAKE_CASE)
                .build();
    }

    /** 无 query 的 GET。 */
    public <T> T get(String path, Class<T> respType) {
        return get(path, null, respType);
    }

    /** GET 请求；{@code query} 可为 null。响应体解析为 {@code resp_data} 对应的类型。 */
    public <T> T get(String path, Map<String, Object> query, Class<T> respType) {
        String requestPath = path + queryString(query);
        String timestamp = String.valueOf(System.currentTimeMillis() / 1000);
        String signature = signature(timestamp, "GET", path, "");

        HttpRequest.Builder builder = HttpRequest.newBuilder(URI.create(BASE_URL + requestPath))
                .timeout(timeout)
                .header("authorization", token)
                .header("User-Agent", userAgent)
                .header("Accept", "application/json")
                .header("x-request-id", UUID.randomUUID().toString())
                .header("x-version", appVersion)
                .header("x-aduid", deviceId)
                .header("x-timestamp", timestamp)
                .header("x-signature", signature);
        if (!cookie.isEmpty()) builder.header("Cookie", cookie);
        return execute(builder.GET().build(), respType);
    }

    private <T> T execute(HttpRequest request, Class<T> respType) {
        for (int attempt = 0; ; attempt++) {
            try {
                HttpResponse<String> response = http.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
                if (response.statusCode() >= 500 && attempt < retryCount) {
                    sleepBeforeRetry(attempt);
                    continue;
                }
                return parse(response, respType);
            } catch (IOException e) {
                if (attempt < retryCount) {
                    sleepBeforeRetry(attempt);
                    continue;
                }
                throw new ZsxqApiException(0, "知识星球网络请求失败：" + e.getMessage());
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new ZsxqApiException(0, "知识星球请求被中断");
            }
        }
    }

    private <T> T parse(HttpResponse<String> response, Class<T> respType) {
        String body = response.body() == null ? "" : response.body();
        JsonNode root;
        try {
            root = mapper.readTree(body);
        } catch (Exception e) {
            throw new ZsxqApiException(response.statusCode(),
                    "知识星球响应解析失败（HTTP " + response.statusCode() + "）：" + brief(body));
        }

        if (!root.path("succeeded").asBoolean(false)) {
            int code = root.path("code").asInt(response.statusCode());
            String message = firstNonBlank(
                    root.path("error").asText(""),
                    root.path("info").asText(""),
                    "知识星球接口错误（code=" + code + "）");
            throw new ZsxqApiException(code, message);
        }

        JsonNode respData = root.get("resp_data");
        if (respData == null || respData.isNull()) return null;
        try {
            return mapper.treeToValue(respData, respType);
        } catch (Exception e) {
            throw new ZsxqApiException(0, "知识星球响应解析失败：" + e.getMessage());
        }
    }

    private String queryString(Map<String, Object> query) {
        if (query == null || query.isEmpty()) return "";
        StringJoiner joiner = new StringJoiner("&");
        query.forEach((key, value) -> {
            if (value == null) return;
            joiner.add(encode(key) + "=" + encode(String.valueOf(value)));
        });
        String s = joiner.toString();
        return s.isEmpty() ? "" : "?" + s;
    }

    private String signature(String timestamp, String method, String path, String body) {
        String payload = timestamp + "\n" + method.toUpperCase() + "\n" + path;
        if (body != null && !body.isEmpty()) payload += "\n" + body;
        try {
            Mac mac = Mac.getInstance("HmacSHA1");
            mac.init(new SecretKeySpec(signatureKey.getBytes(StandardCharsets.UTF_8), "HmacSHA1"));
            return HexFormat.of().formatHex(mac.doFinal(payload.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception e) {
            throw new IllegalStateException("生成知识星球请求签名失败", e);
        }
    }

    private void sleepBeforeRetry(int attempt) {
        try {
            Thread.sleep(1000L << attempt);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    private static String encode(String value) {
        return URLEncoder.encode(value, StandardCharsets.UTF_8);
    }

    private static String firstNonBlank(String... values) {
        for (String value : values) {
            if (value != null && !value.isBlank()) return value;
        }
        return "";
    }

    private static String blankToDefault(String value, String def) {
        return value == null || value.isBlank() ? def : value.trim();
    }

    private static String brief(String body) {
        if (body == null) return "";
        return body.length() <= 300 ? body : body.substring(0, 300) + "…";
    }
}
