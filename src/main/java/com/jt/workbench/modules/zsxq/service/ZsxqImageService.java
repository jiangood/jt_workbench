package com.jt.workbench.modules.zsxq.service;

import com.zsxq.sdk.model.Image;
import com.zsxq.sdk.model.TalkContent;
import io.github.jiangood.openadmin.framework.spi.FileOperator;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import tools.jackson.databind.ObjectMapper;

import java.io.ByteArrayInputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * 知识星球正文图片：下载源图并写入对象存储。
 *
 * <p>沿用旧版 Node 实现的 key 约定 {@code zsxq-img/<sha1(源URL)>.<ext>}，
 * 这样历史浏览时懒缓存过的图片可直接复用，不会重复下载/存储。图片内容按 key 幂等，
 * 同一帖子重复同步不会产生新对象。</p>
 *
 * <p>仅代理官方图床 {@code https://images.zsxq.com/}，避免把任意 URL 带进下载逻辑（SSRF）。</p>
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class ZsxqImageService {

    /** 对象存储 key 前缀（与旧 Node 版本保持一致） */
    public static final String KEY_PREFIX = "zsxq-img/";

    /** 单帖最多处理的图片数，防止异常数据拖垮同步 */
    private static final int MAX_IMAGES_PER_TOPIC = 30;

    /** 单张图片最大字节数 */
    private static final int MAX_IMAGE_BYTES = 25 * 1024 * 1024;

    private static final String ZSXQ_IMAGE_PREFIX = "https://images.zsxq.com/";

    private static final HttpClient HTTP = HttpClient.newBuilder()
            .followRedirects(HttpClient.Redirect.NORMAL)
            .connectTimeout(Duration.ofSeconds(10))
            .build();

    private final FileOperator fileOperator;
    private final ObjectMapper objectMapper;

    /**
     * 把帖子里的全部图片写入对象存储，返回 key 列表（顺序与源图片一致）。
     * 下载失败的图片会跳过，不阻塞其他图片与帖子入库。
     */
    public List<String> storeAll(String topicId, TalkContent talk) {
        List<String> urls = imageUrls(talk);
        List<String> keys = new ArrayList<>(urls.size());
        for (String url : urls) {
            try {
                String key = storeUrl(url);
                if (key != null) keys.add(key);
            } catch (Exception e) {
                log.warn("知识星球图片存储失败 topicId={} url={} error={}", topicId, brief(url), e.getMessage());
            }
        }
        return keys;
    }

    /** 帖子源图片数量（用于判断是否全部入库成功） */
    public int sourceImageCount(TalkContent talk) {
        return imageUrls(talk).size();
    }

    /**
     * 下载并保存单张图片；已存在时直接复用，成功返回对象 key。
     * 非知识星球图床或下载失败返回 null。
     */
    public String storeUrl(String url) {
        if (url == null || !url.startsWith(ZSXQ_IMAGE_PREFIX)) return null;
        String hash = sha1(url);
        String existing = findExistingKey(hash);
        if (existing != null) return existing;

        byte[] bytes = download(url);
        if (bytes == null) return null;

        String key = KEY_PREFIX + hash + "." + extensionOf(bytes);
        try {
            fileOperator.save(key, new ByteArrayInputStream(bytes));
            return key;
        } catch (Exception e) {
            log.warn("知识星球图片写对象存储失败 key={} error={}", key, e.getMessage());
            return null;
        }
    }

    /** 读取对象存储中的图片字节 */
    public byte[] read(String key) throws Exception {
        try (var in = fileOperator.getFileStream(key)) {
            return in.readAllBytes();
        }
    }

    /** key 列表序列化为 JSON 数组，失败时返回空数组，避免影响帖子入库 */
    public String toJson(List<String> keys) {
        try {
            return objectMapper.writeValueAsString(keys == null ? List.of() : keys);
        } catch (Exception e) {
            return "[]";
        }
    }

    /** 根据图片字节判断 MIME，供响应头使用 */
    public String contentType(byte[] bytes, String key) {
        String byMagic = contentTypeByMagic(bytes);
        if (byMagic != null) return byMagic;
        String lower = key == null ? "" : key.toLowerCase();
        if (lower.endsWith(".png")) return "image/png";
        if (lower.endsWith(".webp")) return "image/webp";
        if (lower.endsWith(".gif")) return "image/gif";
        return "image/jpeg";
    }

    // ---------- 内部 ----------

    private static List<String> imageUrls(TalkContent talk) {
        Set<String> urls = new LinkedHashSet<>();
        if (talk != null && talk.getImages() != null) {
            for (Image image : talk.getImages()) {
                if (image == null) continue;
                String url = firstUrl(image);
                // 只处理官方图床，避免异常数据把任意 URL 带进下载逻辑
                if (!url.isEmpty() && url.startsWith(ZSXQ_IMAGE_PREFIX)) urls.add(url);
                if (urls.size() >= MAX_IMAGES_PER_TOPIC) break;
            }
        }
        return new ArrayList<>(urls);
    }

    private static String firstUrl(Image image) {
        if (image.getOriginal() != null && notBlank(image.getOriginal().getUrl())) {
            return image.getOriginal().getUrl().trim();
        }
        if (image.getLarge() != null && notBlank(image.getLarge().getUrl())) {
            return image.getLarge().getUrl().trim();
        }
        if (image.getThumbnail() != null && notBlank(image.getThumbnail().getUrl())) {
            return image.getThumbnail().getUrl().trim();
        }
        return "";
    }

    /** 旧实现只区分 png / jpg；这里连同 webp/gif 一起探测，命中即复用。 */
    private String findExistingKey(String hash) {
        for (String ext : List.of("jpg", "png", "webp", "gif")) {
            String key = KEY_PREFIX + hash + "." + ext;
            try {
                if (fileOperator.exist(key)) return key;
            } catch (Exception e) {
                log.debug("检查图片对象失败 key={} error={}", key, e.getMessage());
            }
        }
        return null;
    }

    private static byte[] download(String url) {
        try {
            HttpRequest request = HttpRequest.newBuilder(URI.create(url))
                    .GET()
                    .timeout(Duration.ofSeconds(30))
                    .header("Referer", "https://wx.zsxq.com/")
                    .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                            + "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
                    .build();
            HttpResponse<java.io.InputStream> response = HTTP.send(request, HttpResponse.BodyHandlers.ofInputStream());
            if (response.statusCode() < 200 || response.statusCode() >= 300) {
                log.warn("知识星球图片下载失败 status={} url={}", response.statusCode(), brief(url));
                return null;
            }
            byte[] body;
            try (var in = response.body()) {
                // 多读 1 字节判断是否超限，避免异常大图把内存打满
                body = in.readNBytes(MAX_IMAGE_BYTES + 1);
            }
            if (body.length == 0) return null;
            if (body.length > MAX_IMAGE_BYTES) {
                log.warn("知识星球图片超过大小上限（>{} bytes），跳过 url={}", MAX_IMAGE_BYTES, brief(url));
                return null;
            }
            if (contentTypeByMagic(body) == null) {
                log.warn("知识星球图片内容不是图片，跳过 url={}", brief(url));
                return null;
            }
            return body;
        } catch (Exception e) {
            log.warn("知识星球图片下载异常 url={} error={}", brief(url), e.getMessage());
            return null;
        }
    }

    private static String extensionOf(byte[] bytes) {
        String type = contentTypeByMagic(bytes);
        if ("image/png".equals(type)) return "png";
        if ("image/webp".equals(type)) return "webp";
        if ("image/gif".equals(type)) return "gif";
        return "jpg";
    }

    /** 通过文件头识别常见图片格式；非图片返回 null。 */
    private static String contentTypeByMagic(byte[] b) {
        if (b == null || b.length < 12) return null;
        if ((b[0] & 0xFF) == 0xFF && (b[1] & 0xFF) == 0xD8 && (b[2] & 0xFF) == 0xFF) return "image/jpeg";
        if ((b[0] & 0xFF) == 0x89 && b[1] == 'P' && b[2] == 'N' && b[3] == 'G') return "image/png";
        if (b[0] == 'G' && b[1] == 'I' && b[2] == 'F' && b[3] == '8') return "image/gif";
        if (b[0] == 'R' && b[1] == 'I' && b[2] == 'F' && b[3] == 'F'
                && b[8] == 'W' && b[9] == 'E' && b[10] == 'B' && b[11] == 'P') return "image/webp";
        return null;
    }

    private static String sha1(String value) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-1");
            byte[] hash = digest.digest(value.getBytes(java.nio.charset.StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder(hash.length * 2);
            for (byte b : hash) {
                String hex = Integer.toHexString(b & 0xFF);
                if (hex.length() == 1) sb.append('0');
                sb.append(hex);
            }
            return sb.toString();
        } catch (Exception e) {
            throw new IllegalStateException("SHA-1 不可用", e);
        }
    }

    private static boolean notBlank(String v) {
        return v != null && !v.isBlank();
    }

    private static String brief(String url) {
        if (url == null) return "";
        int q = url.indexOf('?');
        String path = q > 0 ? url.substring(0, q) : url;
        return path.length() > 120 ? path.substring(0, 120) + "…" : path;
    }
}
