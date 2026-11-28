package com.jt.workbench.modules.zsxq.service;

import com.jt.workbench.modules.zsxq.client.ZsxqApiClient;
import com.jt.workbench.modules.zsxq.client.ZsxqApiException;
import com.jt.workbench.modules.zsxq.client.ZsxqModels.TalkContent;
import com.jt.workbench.modules.zsxq.client.ZsxqModels.TopicFile;
import com.jt.workbench.modules.zsxq.entity.ZsxqFile;
import com.jt.workbench.modules.zsxq.repo.ZsxqFileRepository;
import io.github.jiangood.openadmin.framework.spi.FileOperator;
import io.github.jiangood.openadmin.modules.config.service.SysConfigService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 知识星球话题附件：元数据入库、按需下载到对象存储、站内读取。
 *
 * <p>附件下载地址需要用 {@code file_id} 调星球接口换取，且该接口有下载量/频率监控，
 * 因此这里不并发批量拉取：同步时只保存元数据，文件内容由每轮回填批次或用户点击下载时
 * 再落到对象存储（同一文件只下载一次）。</p>
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class ZsxqFileService {

    /** 对象存储 key 前缀 */
    public static final String KEY_PREFIX = "zsxq-file/";

    /** 单个话题最多保存的附件数，防止异常数据把库写爆 */
    private static final int MAX_FILES_PER_TOPIC = 100;

    /** 单个附件大小上限（星球里通常是研报/压缩包，留足空间） */
    private static final long MAX_FILE_BYTES = 500L * 1024 * 1024;

    /** S3 key 中文件名的最大长度，避免 key 过长 */
    private static final int MAX_KEY_NAME_LENGTH = 100;

    private static final HttpClient HTTP = HttpClient.newBuilder()
            .followRedirects(HttpClient.Redirect.NORMAL)
            .connectTimeout(Duration.ofSeconds(15))
            .build();

    private final FileOperator fileOperator;
    private final ZsxqFileRepository fileRepository;
    private final SysConfigService configService;

    /** 同一附件被同步作业和页面下载同时触发时只下载一次 */
    private final Map<String, Object> downloadLocks = new ConcurrentHashMap<>();

    /**
     * 保存话题里的附件元数据（不下载内容）。
     *
     * @return 本话题识别到的附件数
     */
    public int syncFromTalk(String groupId, String topicId, TalkContent talk) {
        if (talk == null || talk.getFiles() == null || talk.getFiles().isEmpty()) return 0;
        int saved = 0;
        Set<String> seen = new LinkedHashSet<>();
        for (TopicFile remote : talk.getFiles()) {
            if (remote == null) continue;
            String fileId = trim(remote.getFileId());
            if (fileId.isEmpty() || !seen.add(fileId)) continue;
            if (seen.size() > MAX_FILES_PER_TOPIC) break;
            try {
                ZsxqFile file = fileRepository.findByFileId(fileId).orElseGet(ZsxqFile::new);
                boolean created = file.getId() == null;
                file.setFileId(fileId);
                if (created) {
                    file.setTopicId(topicId);
                    file.setGroupId(groupId);
                    file.setFailCount(0);
                }
                file.setName(trim(remote.getName()));
                if (remote.getSize() != null) file.setFileSize(remote.getSize());
                file.setSourceCreateTime(trim(remote.getCreateTime()));
                if (file.getContentType() == null || file.getContentType().isBlank()) {
                    file.setContentType(guessContentType(file.getName()));
                }
                fileRepository.save(file);
                saved++;
            } catch (Exception e) {
                log.warn("知识星球附件元数据保存失败 topicId={} fileId={} error={}", topicId, fileId, e.getMessage());
            }
        }
        return saved;
    }

    /** 批量查询话题附件，按话题分组；坏数据不影响其他话题。 */
    public Map<String, List<ZsxqFile>> byTopicIds(List<String> topicIds) {
        Map<String, List<ZsxqFile>> result = new LinkedHashMap<>();
        if (topicIds == null || topicIds.isEmpty()) return result;
        List<String> ids = new ArrayList<>();
        for (String id : topicIds) {
            String v = trim(id);
            if (!v.isEmpty() && !ids.contains(v)) ids.add(v);
        }
        if (ids.isEmpty()) return result;
        for (ZsxqFile file : fileRepository.findByTopicIdIn(ids)) {
            result.computeIfAbsent(file.getTopicId(), k -> new ArrayList<>()).add(file);
        }
        return result;
    }

    /** 按话题 + 文件 ID 精确查找，避免用别的帖子的 fileId 越权下载。 */
    public ZsxqFile find(String topicId, String fileId) {
        if (trim(topicId).isEmpty() || trim(fileId).isEmpty()) return null;
        return fileRepository.findByFileId(trim(fileId))
                .filter(f -> trim(topicId).equals(f.getTopicId()))
                .orElse(null);
    }

    public List<ZsxqFile> pending(int maxFails, int limit) {
        if (limit <= 0) return List.of();
        return fileRepository.findPending(maxFails, org.springframework.data.domain.PageRequest.of(0, limit));
    }

    /** 删除某个星球/全部附件的数据库记录，返回待清理的对象 key。 */
    public List<String> deleteByGroup(String groupId) {
        List<ZsxqFile> files = trim(groupId).isEmpty()
                ? fileRepository.findAll()
                : fileRepository.findByGroupId(groupId);
        List<String> keys = new ArrayList<>();
        for (ZsxqFile file : files) {
            if (file.getS3Key() != null && !file.getS3Key().isBlank()) keys.add(file.getS3Key());
        }
        if (!files.isEmpty()) fileRepository.deleteAll(files);
        return keys;
    }

    /**
     * 确保附件已落到对象存储，并返回最新的实体。
     *
     * <p>已入库且对象存在时直接返回；对象被删除/从未下载时重新换取下载地址并上传。</p>
     */
    public ZsxqFile ensureStored(ZsxqFile file) throws Exception {
        if (file == null) throw new IllegalArgumentException("附件不存在");
        String existing = trim(file.getS3Key());
        if (!existing.isEmpty() && objectExists(existing)) return file;

        String fileId = trim(file.getFileId());
        Object lock = downloadLocks.computeIfAbsent(fileId, k -> new Object());
        synchronized (lock) {
            try {
                // 等锁期间可能已被另一个请求下载完成
                ZsxqFile latest = fileRepository.findByFileId(fileId).orElse(file);
                String key = trim(latest.getS3Key());
                if (!key.isEmpty() && objectExists(key)) return latest;

                String cookie = trim(configService.getString("zsxq.cookie"));
                if (cookie.isEmpty()) throw new IllegalStateException("未配置知识星球 Cookie，无法下载附件");

                ZsxqApiClient client = new ZsxqApiClient(cookie);
                String downloadUrl = client.fileDownloadUrl(fileId);
                Path temp = null;
                try {
                    temp = download(downloadUrl);
                    String objectKey = objectKey(latest);
                    fileOperator.saveFile(objectKey, temp.toFile());
                    latest.setS3Key(objectKey);
                    latest.setContentType(guessContentType(latest.getName()));
                    latest.setFileSize(Files.size(temp));
                    latest.setFailCount(0);
                    fileRepository.save(latest);
                    log.info("[知识星球] 附件入库 fileId={} name={} key={}", fileId, latest.getName(), objectKey);
                    return latest;
                } finally {
                    if (temp != null) {
                        try {
                            Files.deleteIfExists(temp);
                        } catch (Exception ignored) {
                        }
                    }
                }
            } catch (Exception e) {
                markFailed(fileId, e);
                throw e;
            } finally {
                downloadLocks.remove(fileId, lock);
            }
        }
    }

    /** 读取对象存储中的附件字节流（由调用方关闭）。 */
    public InputStream open(ZsxqFile file) throws Exception {
        return fileOperator.getFileStream(file.getS3Key());
    }

    /** 删除附件对象；单个失败只记日志。 */
    public void deleteKeys(List<String> keys) {
        if (keys == null) return;
        for (String key : keys) {
            if (key == null || key.isBlank()) continue;
            try {
                fileOperator.delete(key);
            } catch (Exception e) {
                log.warn("知识星球附件删除失败 key={} error={}", key, e.getMessage());
            }
        }
    }

    /** 下载时使用的文件名（浏览器保存名）；空文件名回退 fileId。 */
    public String fileName(ZsxqFile file) {
        String name = trim(file == null ? null : file.getName());
        if (name.isEmpty()) name = trim(file == null ? null : file.getFileId());
        return safeName(name, "attachment");
    }

    public String contentType(ZsxqFile file) {
        String type = trim(file == null ? null : file.getContentType());
        return type.isEmpty() ? guessContentType(fileName(file)) : type;
    }

    /** 对象存储 key：前缀 + fileId + 原始文件名，方便在 S3 控制台直接辨认。 */
    static String objectKey(ZsxqFile file) {
        String fileId = trim(file.getFileId());
        String name = toTruncatedName(safeName(file.getName(), fileId));
        return KEY_PREFIX + fileId + "_" + name;
    }

    /** S3 key 使用安全字符：去掉路径分隔符与控制字符，保留中文和扩展名。 */
    static String safeName(String name, String fallback) {
        String value = trim(name).replace('\\', '_').replace('/', '_');
        value = value.replaceAll("[\\p{Cntrl}\"<>|:*?]", "_").trim();
        if (value.isEmpty()) value = trim(fallback);
        return value.isEmpty() ? "attachment" : value;
    }

    /** 超长文件名按扩展名截断，避免把 key 拉得过长。 */
    private static String toTruncatedName(String name) {
        if (name.length() <= MAX_KEY_NAME_LENGTH) return name;
        int dot = name.lastIndexOf('.');
        String ext = dot > 0 && name.length() - dot <= 12 ? name.substring(dot) : "";
        int keep = Math.max(1, MAX_KEY_NAME_LENGTH - ext.length());
        return name.substring(0, keep) + ext;
    }

    private void markFailed(String fileId, Exception cause) {
        try {
            fileRepository.findByFileId(fileId).ifPresent(file -> {
                int fails = file.getFailCount() == null ? 0 : file.getFailCount();
                file.setFailCount(fails + 1);
                fileRepository.save(file);
            });
        } catch (Exception e) {
            log.debug("记录知识星球附件失败次数出错 fileId={} error={}", fileId, e.getMessage());
        }
        log.warn("知识星球附件下载失败 fileId={} error={}", fileId, cause.getMessage());
    }

    private boolean objectExists(String key) {
        try {
            return fileOperator.exist(key);
        } catch (Exception e) {
            log.debug("检查附件对象失败 key={} error={}", key, e.getMessage());
            return false;
        }
    }

    /** 下载到临时文件；校验域名/大小，避免 SSRF 与大文件拖垮磁盘。 */
    private static Path download(String url) throws Exception {
        URI uri = URI.create(url);
        String host = uri.getHost() == null ? "" : uri.getHost().toLowerCase(Locale.ROOT);
        if (!"https".equalsIgnoreCase(uri.getScheme())
                || !(host.equals("zsxq.com") || host.endsWith(".zsxq.com"))) {
            throw new ZsxqApiException(0, "知识星球附件地址不在受信域名内：" + host);
        }

        HttpRequest request = HttpRequest.newBuilder(uri)
                .GET()
                .timeout(Duration.ofSeconds(60))
                .header("Referer", "https://wx.zsxq.com/")
                .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                        + "(KHTML, like Gecko) Chrome/152.0.7977.167 Safari/537.36")
                .build();
        HttpResponse<InputStream> response = HTTP.send(request, HttpResponse.BodyHandlers.ofInputStream());
        if (response.statusCode() < 200 || response.statusCode() >= 300) {
            try (var ignored = response.body()) {
                throw new ZsxqApiException(response.statusCode(),
                        "知识星球附件下载失败（HTTP " + response.statusCode() + "）");
            }
        }
        long declared = response.headers().firstValueAsLong("Content-Length").orElse(-1L);
        if (declared > MAX_FILE_BYTES) {
            try (var ignored = response.body()) {
                throw new ZsxqApiException(0, "知识星球附件超过大小上限（" + MAX_FILE_BYTES + " bytes）");
            }
        }

        Path temp = Files.createTempFile("zsxq-file-", ".tmp");
        long total = 0;
        try (InputStream in = response.body(); OutputStream out = Files.newOutputStream(temp)) {
            byte[] buffer = new byte[64 * 1024];
            int n;
            while ((n = in.read(buffer)) != -1) {
                total += n;
                if (total > MAX_FILE_BYTES) {
                    throw new ZsxqApiException(0, "知识星球附件超过大小上限（" + MAX_FILE_BYTES + " bytes）");
                }
                out.write(buffer, 0, n);
            }
        } catch (Exception e) {
            Files.deleteIfExists(temp);
            throw e;
        }
        if (total == 0) {
            Files.deleteIfExists(temp);
            throw new ZsxqApiException(0, "知识星球附件内容为空");
        }
        return temp;
    }

    static String guessContentType(String name) {
        String lower = trim(name).toLowerCase(Locale.ROOT);
        int dot = lower.lastIndexOf('.');
        String ext = dot < 0 ? "" : lower.substring(dot + 1);
        return switch (ext) {
            case "pdf" -> "application/pdf";
            case "zip" -> "application/zip";
            case "rar" -> "application/vnd.rar";
            case "7z" -> "application/x-7z-compressed";
            case "doc" -> "application/msword";
            case "docx" -> "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
            case "xls" -> "application/vnd.ms-excel";
            case "xlsx" -> "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
            case "ppt" -> "application/vnd.ms-powerpoint";
            case "pptx" -> "application/vnd.openxmlformats-officedocument.presentationml.presentation";
            case "txt", "log" -> "text/plain;charset=UTF-8";
            case "md" -> "text/markdown;charset=UTF-8";
            case "csv" -> "text/csv;charset=UTF-8";
            case "json" -> "application/json";
            case "epub" -> "application/epub+zip";
            case "mp3" -> "audio/mpeg";
            case "m4a" -> "audio/mp4";
            case "mp4" -> "video/mp4";
            case "jpg", "jpeg" -> "image/jpeg";
            case "png" -> "image/png";
            case "gif" -> "image/gif";
            case "webp" -> "image/webp";
            default -> "application/octet-stream";
        };
    }

    private static String trim(String value) {
        return value == null ? "" : value.trim();
    }
}
