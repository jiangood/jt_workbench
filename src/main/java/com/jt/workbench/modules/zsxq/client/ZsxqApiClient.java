package com.jt.workbench.modules.zsxq.client;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.PropertyNamingStrategies;
import tools.jackson.databind.json.JsonMapper;

import java.io.IOException;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.util.HexFormat;
import java.util.Map;
import java.util.StringJoiner;
import java.util.UUID;
import java.util.concurrent.ThreadLocalRandom;
import java.util.function.Consumer;
import java.util.regex.Pattern;

/**
 * 知识星球只读接口的最小 HTTP 客户端（项目内源码，不再依赖 zsxq-sdk）。
 *
 * <p>按网页端（https://wx.zsxq.com）的真实请求方式构造：</p>
 * <ul>
 *     <li>认证只走浏览器 Cookie（{@code zsxq_access_token} 等），不发 SDK 的 {@code authorization} 头；</li>
 *     <li>签名与浏览器一致：{@code SHA1(完整 URL + " " + 秒级时间戳 + " " + x-request-id)}；</li>
 *     <li>请求头带 {@code x-request-id / x-version / x-timestamp / x-signature / x-aduid}，
 *         并补上浏览器的 {@code Origin / Referer / Accept-Language / sec-ch-ua / sec-fetch-*}；
 *         {@code x-aduid} 与 {@code x-request-id} 使用星球自定义的 9-4-4-4-11 位格式。</li>
 * </ul>
 *
 * <p>知识星球对非官方通道的拦截（业务码 {@code 1059}）是**按账号风险分/时间窗口**出现的：
 * 短时间密集请求会把风险分推高，之后一段时间内请求会被随机拦截；停一会儿或换新会话就恢复。
 * 因此客户端对 1059/40001 做原地重试（默认 3 次，3/6/12 秒退避 + 抖动，成功后额外静默 2~3 秒，
 * 单轮累计重试上限 20 次），仍失败才把异常抛给调用方进冷却。</p>
 */
public class ZsxqApiClient {

    private static final String BASE_URL = "https://api.zsxq.com";
    private static final String WEB_ORIGIN = "https://wx.zsxq.com";
    private static final String DEFAULT_APP_VERSION = "2.100.0";
    private static final String DEFAULT_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            + "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.7977.167 Safari/537.36";
    private static final String ACCEPT = "application/json, text/plain, */*";
    private static final String ACCEPT_LANGUAGE = "zh-CN";
    private static final String ACCEPT_ENCODING = "gzip, deflate";
    private static final Pattern CHROME_VERSION = Pattern.compile("Chrome/(\\d+)");
    private static final int DEFAULT_TIMEOUT_SECONDS = 20;
    private static final int DEFAULT_TRANSPORT_RETRY = 3;
    private static final int DEFAULT_RISK_RETRY = 3;
    private static final long DEFAULT_RISK_RETRY_PAUSE_MS = 3000L;
    private static final long MAX_RISK_RETRY_PAUSE_MS = 30_000L;
    /** 单轮（一个客户端实例）累计 1059 重试上限，防止风控窗口内靠重试放大请求量。 */
    private static final int MAX_TOTAL_RISK_RETRIES = 20;
    /** 重试成功后额外静默一会儿，让风险分回落，避免紧接着的下一个请求再次命中。 */
    private static final long RECOVERY_PAUSE_MS = 2000L;
    /** 浏览器端可见的 A/B 标记 Cookie（网页端所有请求都会带）。 */
    private static final String ABTEST_COOKIE = "abtest_env=product";
    private static final int CODE_RISK_CONTROL = 1059;
    private static final int CODE_RATE_LIMIT = 40001;
    /**
     * 星球网页端的 ID 是自定义格式「9-4-4-4-11」位十六进制（不是标准 UUID），
     * 标准 UUID（8-4-4-4-12）也兼容。
     */
    private final String cookie;
    private final String deviceId;
    private final String appVersion;
    private final String userAgent;
    private final int riskRetryCount;
    private final long riskRetryPauseMs;
    private final int transportRetryCount;
    private final Duration timeout;
    private final HttpClient http;
    private final ObjectMapper mapper;
    private Consumer<String> retryListener = message -> { };
    private int totalRiskRetries;

    public ZsxqApiClient(String cookie) {
        this(cookie, DEFAULT_RISK_RETRY, DEFAULT_RISK_RETRY_PAUSE_MS);
    }

    /**
     * @param riskRetryCount   1059/40001 的原地重试次数（0 表示不重试）
     * @param riskRetryPauseMs 首次退避毫秒数，之后按 2 倍递增并叠加 0~1 秒抖动
     */
    public ZsxqApiClient(String cookie, int riskRetryCount, long riskRetryPauseMs) {
        this.cookie = cookie == null ? "" : cookie.trim();
        this.deviceId = normalizeDeviceId(this.cookie);
        this.appVersion = DEFAULT_APP_VERSION;
        this.userAgent = DEFAULT_USER_AGENT;
        this.riskRetryCount = Math.max(0, riskRetryCount);
        this.riskRetryPauseMs = riskRetryPauseMs <= 0 ? DEFAULT_RISK_RETRY_PAUSE_MS : riskRetryPauseMs;
        this.transportRetryCount = DEFAULT_TRANSPORT_RETRY;
        this.timeout = Duration.ofSeconds(DEFAULT_TIMEOUT_SECONDS);
        this.http = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(10))
                .followRedirects(HttpClient.Redirect.NEVER)
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
        return execute(path + queryString(query), respType);
    }

    /**
     * 获取专栏文章完整正文 HTML。正文页与 API 域名不同，只带 Cookie、不签名；
     * 仅允许 HTTPS 的 articles.zsxq.com，且禁止重定向，避免把 Cookie 带到其它域名。
     */
    public String getArticleContent(String articleUrl) {
        if (!isAllowedArticleUrl(articleUrl)) {
            throw new ZsxqApiException(0, "专栏文章地址不受支持，仅允许 https://articles.zsxq.com/");
        }
        if (cookie.isBlank()) throw new ZsxqApiException(401, "知识星球 Cookie 为空，无法读取专栏正文");

        String url = articleUrl.trim();
        HttpRequest request = HttpRequest.newBuilder(URI.create(url))
                .timeout(timeout)
                .header("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
                .header("Accept-Language", ACCEPT_LANGUAGE)
                .header("User-Agent", userAgent)
                .header("Referer", WEB_ORIGIN + "/")
                .header("sec-fetch-dest", "document")
                .header("sec-fetch-mode", "navigate")
                .header("sec-fetch-site", "same-site")
                .header("Cookie", cookieHeader())
                .GET()
                .build();
        try {
            HttpResponse<byte[]> response = http.send(request, HttpResponse.BodyHandlers.ofByteArray());
            if (response.statusCode() >= 300 && response.statusCode() < 400) {
                throw new ZsxqApiException(401, "专栏文章页面发生跳转，可能需重新登录知识星球");
            }
            if (response.statusCode() < 200 || response.statusCode() >= 300) {
                throw new ZsxqApiException(response.statusCode(),
                        "专栏文章页面请求失败（HTTP " + response.statusCode() + "）");
            }
            String html = bodyText(response);
            if (html.contains("<app-root") || html.contains("<app-root>")) {
                throw new ZsxqApiException(401, "专栏文章页面要求重新登录知识星球");
            }
            String content = extractArticleHtml(html);
            if (content.isBlank()) {
                throw new ZsxqApiException(0, "专栏文章页面未找到正文内容");
            }
            return content;
        } catch (ZsxqApiException e) {
            throw e;
        } catch (IOException e) {
            throw new ZsxqApiException(0, "专栏文章页面网络请求失败：" + e.getMessage());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new ZsxqApiException(0, "专栏文章请求被中断");
        }
    }

    /** 正文页地址白名单：精确域名 + HTTPS，拒绝 userinfo/非标准端口。 */
    static boolean isAllowedArticleUrl(String articleUrl) {
        if (articleUrl == null || articleUrl.isBlank()) return false;
        try {
            URI uri = URI.create(articleUrl.trim());
            return "https".equalsIgnoreCase(uri.getScheme())
                    && "articles.zsxq.com".equalsIgnoreCase(uri.getHost())
                    && (uri.getPort() == -1 || uri.getPort() == 443)
                    && uri.getUserInfo() == null;
        } catch (IllegalArgumentException e) {
            return false;
        }
    }

    /** 从星球文章页提取正文容器；按 div 配对截取，避免正则在内层 div 处提前结束。 */
    static String extractArticleHtml(String pageHtml) {
        if (pageHtml == null || pageHtml.isBlank()) return "";
        String html = pageHtml.replaceAll("(?s)<!--.*?-->", "");
        java.util.regex.Matcher container = ARTICLE_CONTAINER.matcher(html);
        if (!container.find()) return "";
        int start = container.end();
        int depth = 1;
        java.util.regex.Matcher tags = ARTICLE_DIV_TAG.matcher(html);
        tags.region(start, html.length());
        while (tags.find()) {
            if (tags.group(1) != null && tags.group(1).equalsIgnoreCase("/")) depth--;
            else depth++;
            if (depth == 0) return html.substring(start, tags.start()).trim();
        }
        return "";
    }

    private static final java.util.regex.Pattern ARTICLE_CONTAINER = java.util.regex.Pattern.compile(
            "(?is)<div\\b[^>]*\\bclass\\s*=\\s*[\"'][^\"']*\\b(?:ql-editor|tiptap-preview)\\b[^\"']*[\"'][^>]*>");
    private static final java.util.regex.Pattern ARTICLE_DIV_TAG = java.util.regex.Pattern.compile(
            "(?is)<(/?)\\s*div\\b[^>]*>");

    /** 注册 1059/40001 原地重试的回调（用于任务日志），返回自身便于链式调用。 */
    public ZsxqApiClient onRetry(Consumer<String> listener) {
        this.retryListener = listener == null ? message -> { } : listener;
        return this;
    }

    /**
     * 发送请求；1059（非官方工具随机拦截）与 40001（限流）在客户端原地重试，
     * 每次重试都会重新生成时间戳、request-id 与签名，避免复用被拦下的请求指纹。
     */
    private <T> T execute(String requestPath, Class<T> respType) {
        int transportAttempt = 0;
        int riskAttempt = 0;
        while (true) {
            try {
                HttpResponse<byte[]> response = http.send(buildGet(requestPath),
                        HttpResponse.BodyHandlers.ofByteArray());
                if (response.statusCode() >= 500 && transportAttempt < transportRetryCount) {
                    transportAttempt++;
                    sleepBeforeRetry(transportAttempt - 1);
                    continue;
                }
                if (response.statusCode() == 429 && canRetryRisk(riskAttempt)) {
                    riskAttempt++;
                    totalRiskRetries++;
                    notifyRetry(requestPath, 429, "HTTP 429 请求过于频繁", riskAttempt);
                    sleepBeforeRiskRetry(riskAttempt);
                    continue;
                }
                try {
                    T parsed = parse(response, respType);
                    if (riskAttempt > 0) sleep(RECOVERY_PAUSE_MS + ThreadLocalRandom.current().nextLong(1000));
                    return parsed;
                } catch (ZsxqApiException e) {
                    if (isTransientRisk(e.getCode()) && canRetryRisk(riskAttempt)) {
                        riskAttempt++;
                        totalRiskRetries++;
                        notifyRetry(requestPath, e.getCode(), e.getMessage(), riskAttempt);
                        sleepBeforeRiskRetry(riskAttempt);
                        continue;
                    }
                    throw e;
                }
            } catch (IOException e) {
                if (transportAttempt < transportRetryCount) {
                    transportAttempt++;
                    sleepBeforeRetry(transportAttempt - 1);
                    continue;
                }
                throw new ZsxqApiException(0, "知识星球网络请求失败：" + e.getMessage());
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new ZsxqApiException(0, "知识星球请求被中断");
            }
        }
    }

    /** 按浏览器的方式构造 GET：Cookie 认证 + SHA1 签名 + 网页端请求头。 */
    private HttpRequest buildGet(String requestPath) {
        String url = BASE_URL + requestPath;
        String timestamp = String.valueOf(System.currentTimeMillis() / 1000);
        String requestId = newZsxqId();
        String chromeMajor = chromeMajor(userAgent);

        HttpRequest.Builder builder = HttpRequest.newBuilder(URI.create(url))
                .timeout(timeout)
                .header("Accept", ACCEPT)
                .header("Accept-Language", ACCEPT_LANGUAGE)
                .header("Accept-Encoding", ACCEPT_ENCODING)
                .header("User-Agent", userAgent)
                .header("Origin", WEB_ORIGIN)
                .header("Referer", WEB_ORIGIN + "/")
                .header("sec-ch-ua", "\"Not?A_Brand\";v=\"24\", \"Chromium\";v=\"" + chromeMajor + "\"")
                .header("sec-ch-ua-mobile", "?0")
                .header("sec-ch-ua-platform", "\"Windows\"")
                .header("sec-fetch-dest", "empty")
                .header("sec-fetch-mode", "cors")
                .header("sec-fetch-site", "same-site")
                .header("priority", "u=1, i")
                .header("x-request-id", requestId)
                .header("x-version", appVersion)
                .header("x-aduid", deviceId)
                .header("x-timestamp", timestamp)
                .header("x-signature", signature(url, timestamp, requestId));
        String cookie = cookieHeader();
        if (!cookie.isEmpty()) builder.header("Cookie", cookie);
        return builder.GET().build();
    }

    /** 网页端认证 Cookie：使用配置的完整 Cookie，未带 A/B 标记时补上。 */
    String cookieHeader() {
        if (cookie.isEmpty() || cookie.contains("abtest_env=")) return cookie;
        return ABTEST_COOKIE + "; " + cookie;
    }

    private <T> T parse(HttpResponse<byte[]> response, Class<T> respType) {
        String body = bodyText(response);
        JsonNode root;
        try {
            root = mapper.readTree(body);
        } catch (Exception e) {
            throw new ZsxqApiException(response.statusCode(),
                    "知识星球响应解析失败（HTTP " + response.statusCode() + "）：" + brief(body));
        }

        if (!root.path("succeeded").asBoolean(false)) {
            int code = root.path("code").asInt(response.statusCode());
            throw new ZsxqApiException(code, errorMessage(root, code));
        }

        JsonNode respData = root.get("resp_data");
        if (respData == null || respData.isNull()) return null;
        try {
            return mapper.treeToValue(respData, respType);
        } catch (Exception e) {
            throw new ZsxqApiException(0, "知识星球响应解析失败：" + e.getMessage());
        }
    }

    /** 读取响应体并按 Content-Encoding 解压（浏览器同款 Accept-Encoding）。 */
    private static String bodyText(HttpResponse<byte[]> response) {
        byte[] bytes = response.body() == null ? new byte[0] : response.body();
        String encoding = response.headers().firstValue("content-encoding").orElse("").toLowerCase();
        try {
            if (encoding.contains("gzip")) {
                try (java.util.zip.GZIPInputStream in = new java.util.zip.GZIPInputStream(
                        new java.io.ByteArrayInputStream(bytes))) {
                    bytes = in.readAllBytes();
                }
            } else if (encoding.contains("deflate")) {
                try (java.util.zip.InflaterInputStream in = new java.util.zip.InflaterInputStream(
                        new java.io.ByteArrayInputStream(bytes))) {
                    bytes = in.readAllBytes();
                }
            }
        } catch (IOException e) {
            throw new ZsxqApiException(response.statusCode(), "知识星球响应解压失败：" + e.getMessage());
        }
        return new String(bytes, StandardCharsets.UTF_8);
    }

    /**
     * 平台错误文案：1059 的 {@code error} 是无信息量的「内部错误」，
     * 真正有用的说明在 {@code info}（例如「不支持非官方工具访问…」），优先取 info。
     */
    static String errorMessage(JsonNode root, int code) {
        String error = root.path("error").asText("").trim();
        String info = root.path("info").asText("").trim();
        if (isGenericError(error)) {
            if (!info.isEmpty()) return info;
            return "知识星球接口错误（code=" + code + "）";
        }
        if (!error.isEmpty()) {
            return info.isEmpty() || info.contains(error) ? error : error + "：" + info;
        }
        return info.isEmpty() ? "知识星球接口错误（code=" + code + "）" : info;
    }

    private static boolean isGenericError(String error) {
        if (error.isEmpty()) return true;
        String lower = error.toLowerCase();
        return "内部错误".equals(error) || "internal server error".equals(lower) || "error".equals(lower);
    }

    /** 与网页端一致：SHA1(完整 URL + " " + 秒级时间戳 + " " + x-request-id) 的小写十六进制。 */
    static String signature(String url, String timestamp, String requestId) {
        String payload = url + " " + timestamp + " " + requestId;
        try {
            MessageDigest sha1 = MessageDigest.getInstance("SHA-1");
            return HexFormat.of().formatHex(sha1.digest(payload.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("生成知识星球请求签名失败", e);
        }
    }

    private static boolean isTransientRisk(int code) {
        return code == CODE_RISK_CONTROL || code == CODE_RATE_LIMIT;
    }

    private boolean canRetryRisk(int riskAttempt) {
        return riskAttempt < riskRetryCount && totalRiskRetries < MAX_TOTAL_RISK_RETRIES;
    }

    private void notifyRetry(String requestPath, int code, String message, int attempt) {
        try {
            retryListener.accept("命中 code=" + code + "（" + brief(message)
                    + "），第 " + attempt + " 次原地重试：" + requestPath);
        } catch (RuntimeException ignored) {
            // 回调只用于日志，不能影响重试
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

    private void sleepBeforeRetry(int attempt) {
        sleep(1000L << Math.min(attempt, 4));
    }

    private void sleepBeforeRiskRetry(int attempt) {
        long base = Math.min(riskRetryPauseMs << Math.min(attempt - 1, 4), MAX_RISK_RETRY_PAUSE_MS);
        sleep(base + ThreadLocalRandom.current().nextLong(1000));
    }

    private static void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    private static String encode(String value) {
        return URLEncoder.encode(value, StandardCharsets.UTF_8);
    }

    /** 按 Cookie 派生固定的 {@code x-aduid}，保证多轮同步看到的是同一设备。 */
    private static String normalizeDeviceId(String credential) {
        try {
            MessageDigest md5 = MessageDigest.getInstance("MD5");
            byte[] digest = md5.digest(("jt-workbench-zsxq:" + credential).getBytes(StandardCharsets.UTF_8));
            return formatZsxqId(HexFormat.of().formatHex(digest));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("生成知识星球设备号失败", e);
        }
    }

    /** 随机生成网页端同款 9-4-4-4-11 位 ID（用于 x-request-id）。 */
    static String newZsxqId() {
        return formatZsxqId(UUID.randomUUID().toString().replace("-", ""));
    }

    private static String formatZsxqId(String hex32) {
        return hex32.substring(0, 9) + "-" + hex32.substring(9, 13) + "-"
                + hex32.substring(13, 17) + "-" + hex32.substring(17, 21) + "-" + hex32.substring(21);
    }

    private static String chromeMajor(String userAgent) {
        java.util.regex.Matcher m = CHROME_VERSION.matcher(userAgent);
        return m.find() ? m.group(1) : "152";
    }

    private static String brief(String body) {
        if (body == null) return "";
        return body.length() <= 300 ? body : body.substring(0, 300) + "…";
    }
}
