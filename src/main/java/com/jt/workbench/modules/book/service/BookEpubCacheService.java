package com.jt.workbench.modules.book.service;

import com.jt.workbench.modules.book.entity.Book;
import io.github.jiangood.openadmin.framework.spi.FileOperator;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.NodeList;

import javax.xml.parsers.DocumentBuilderFactory;
import java.io.BufferedInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.*;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.Comparator;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.locks.ReentrantLock;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;
import java.util.zip.ZipInputStream;

/**
 * EPUB 解包缓存：按 书籍ID+文件版本 在本地磁盘缓存展开后的 EPUB 内容，供阅读器按需拉取资源，
 * 避免每次打开都从对象存储下载整本并在浏览器整包解析。
 * <p>
 * 缓存目录：${DATA_DIR}/book_cache/{bookId}/{version}/
 * version 与前端 fileVersion/book.readCfiVersion 保持一致（优先取 r2Key 中的 uuid）。
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class BookEpubCacheService {

    private static final Pattern VERSION_UUID = Pattern.compile(
            "book/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/");

    private static final String READY_MARKER = ".ready";

    private final FileOperator fileOperator;

    private final ConcurrentHashMap<String, ReentrantLock> locks = new ConcurrentHashMap<>();

    /** 计算文件版本号（与前端 fileVersion 保持一致） */
    public String versionOf(Book book) {
        if (book == null) return "unknown";
        String key = book.getR2Key() == null ? "" : book.getR2Key();
        Matcher m = VERSION_UUID.matcher(key);
        if (m.find()) return m.group(1);
        if (!key.isBlank()) return key;
        return "book-" + (book.getId() == null ? "" : book.getId()) + "-" + (book.getSize() == null ? 0 : book.getSize());
    }

    public Path cacheRoot() {
        String raw = System.getenv("DATA_DIR");
        String base = (raw == null || raw.isBlank()) ? "data" : raw.trim();
        return Path.of(base, "book_cache");
    }

    public Path versionDir(String bookId, String version) {
        return cacheRoot().resolve(safeSegment(bookId)).resolve(safeSegment(version));
    }

    /**
     * 确保指定版本的 EPUB 已解包到本地缓存，返回缓存目录。
     * 首次会从对象存储下载并解压；同版本并发请求只解包一次。
     */
    public Path ensureExtracted(Book book) {
        String bookId = book.getId();
        String version = versionOf(book);
        if (book.getR2Key() == null || book.getR2Key().isBlank()) {
            throw new IllegalArgumentException("这本书还没有 EPUB 文件");
        }

        Path dir = versionDir(bookId, version);
        if (isReady(dir)) {
            return dir;
        }

        String lockKey = bookId + "\n" + version;
        ReentrantLock lock = locks.computeIfAbsent(lockKey, k -> new ReentrantLock());
        lock.lock();
        try {
            if (isReady(dir)) {
                return dir;
            }
            extract(book, dir);
            return dir;
        } finally {
            lock.unlock();
            // 完成后可移除锁对象，避免无限增长；极端并发下重复创建也无害
            locks.remove(lockKey, lock);
        }
    }

    /** 解析 container.xml，返回 OPF 在解包目录内的相对路径 */
    public String resolveOpfPath(Path extractedDir) {
        Path container = extractedDir.resolve("META-INF").resolve("container.xml");
        if (!Files.isRegularFile(container)) {
            throw new IllegalStateException("EPUB 缺少 META-INF/container.xml");
        }
        try (InputStream in = Files.newInputStream(container)) {
            DocumentBuilderFactory f = DocumentBuilderFactory.newInstance();
            // 禁用外部实体，避免 XXE
            f.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
            f.setFeature("http://xml.org/sax/features/external-general-entities", false);
            f.setFeature("http://xml.org/sax/features/external-parameter-entities", false);
            f.setExpandEntityReferences(false);
            Document doc = f.newDocumentBuilder().parse(in);
            NodeList roots = doc.getElementsByTagName("rootfile");
            if (roots.getLength() == 0) {
                roots = doc.getElementsByTagNameNS("*", "rootfile");
            }
            for (int i = 0; i < roots.getLength(); i++) {
                Element el = (Element) roots.item(i);
                String fullPath = el.getAttribute("full-path");
                if (fullPath != null && !fullPath.isBlank()) {
                    String normalized = normalizeRelative(fullPath);
                    if (normalized != null && Files.isRegularFile(extractedDir.resolve(normalized))) {
                        return normalized;
                    }
                }
            }
        } catch (Exception e) {
            throw new IllegalStateException("解析 container.xml 失败：" + rootMessage(e), e);
        }
        throw new IllegalStateException("EPUB 未声明有效的 OPF 路径");
    }

    /** 在缓存目录内安全解析资源路径，防止路径穿越 */
    public Path resolveResource(Path extractedDir, String relativePath) {
        if (relativePath == null || relativePath.isBlank()) {
            throw new IllegalArgumentException("资源路径为空");
        }
        // 统一分隔符并去掉前导斜杠
        String cleaned = relativePath.replace('\\', '/');
        while (cleaned.startsWith("/")) cleaned = cleaned.substring(1);
        Path target = extractedDir.resolve(cleaned).normalize();
        if (!target.startsWith(extractedDir)) {
            throw new IllegalArgumentException("非法资源路径");
        }
        if (!Files.isRegularFile(target)) {
            throw new NoSuchFileExceptionSafe(cleaned);
        }
        return target;
    }

    /** 删除某本书的全部解包缓存（所有版本） */
    public void purgeBook(String bookId) {
        if (bookId == null || bookId.isBlank()) return;
        deleteRecursively(cacheRoot().resolve(safeSegment(bookId)));
    }

    /** 删除某本书指定版本的解包缓存 */
    public void purgeVersion(String bookId, String version) {
        if (bookId == null || version == null) return;
        deleteRecursively(versionDir(bookId, version));
    }

    private void extract(Book book, Path dir) {
        String r2Key = book.getR2Key();
        log.info("解包 EPUB 缓存 bookId={} version={} key={}", book.getId(), versionOf(book), r2Key);
        try {
            Files.createDirectories(dir.getParent());
            Path tmpDir = dir.getParent().resolve(dir.getFileName().toString() + ".tmp-" + System.nanoTime());
            Files.createDirectories(tmpDir);
            Path tmpZip = tmpDir.resolve("source.epub");
            try {
                try (InputStream in = fileOperator.getFileStream(r2Key)) {
                    Files.copy(in, tmpZip, StandardCopyOption.REPLACE_EXISTING);
                }
                unzip(tmpZip, tmpDir);
                Files.deleteIfExists(tmpZip);
                Files.writeString(tmpDir.resolve(READY_MARKER), "1", StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING);

                // 清理可能的残留半成品目录，再原子就位
                if (Files.exists(dir)) {
                    deleteRecursively(dir);
                }
                try {
                    Files.move(tmpDir, dir, StandardCopyOption.ATOMIC_MOVE);
                } catch (AtomicMoveNotSupportedException e) {
                    Files.move(tmpDir, dir);
                }
            } catch (Exception e) {
                deleteRecursively(tmpDir);
                throw e;
            }
            log.info("EPUB 缓存就绪 bookId={} version={} dir={}", book.getId(), versionOf(book), dir);
        } catch (IllegalArgumentException | IllegalStateException e) {
            throw e;
        } catch (Exception e) {
            throw new IllegalStateException("准备 EPUB 阅读缓存失败：" + rootMessage(e), e);
        }
    }

    private void unzip(Path zipFile, Path destDir) throws IOException {
        Path root = destDir.toAbsolutePath().normalize();
        try (InputStream fin = Files.newInputStream(zipFile);
             ZipInputStream zis = new ZipInputStream(new BufferedInputStream(fin))) {
            java.util.zip.ZipEntry entry;
            byte[] buffer = new byte[8192];
            while ((entry = zis.getNextEntry()) != null) {
                String name = entry.getName();
                if (name == null || name.isBlank()) {
                    zis.closeEntry();
                    continue;
                }
                // 拒绝绝对路径与反斜杠异常
                if (name.startsWith("/") || name.startsWith("\\")) {
                    throw new IOException("非法 zip 条目: " + name);
                }
                Path target = root.resolve(name).normalize();
                if (!target.startsWith(root)) {
                    throw new IOException("非法 zip 条目路径: " + name);
                }
                if (entry.isDirectory() || name.endsWith("/")) {
                    Files.createDirectories(target);
                } else {
                    Path parent = target.getParent();
                    if (parent != null) Files.createDirectories(parent);
                    try (var out = Files.newOutputStream(target, StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING)) {
                        int n;
                        while ((n = zis.read(buffer)) > 0) {
                            out.write(buffer, 0, n);
                        }
                    }
                }
                zis.closeEntry();
            }
        }
    }

    private static boolean isReady(Path dir) {
        return dir != null && Files.isRegularFile(dir.resolve(READY_MARKER));
    }

    private static String normalizeRelative(String path) {
        if (path == null) return null;
        String p = path.replace('\\', '/').trim();
        while (p.startsWith("/")) p = p.substring(1);
        if (p.isEmpty()) return null;
        // 简单归一化 ..（container 声明通常很干净）
        Path n = Path.of(p).normalize();
        String s = n.toString().replace('\\', '/');
        if (s.startsWith("..") || s.isBlank()) return null;
        return s;
    }

    private static String safeSegment(String s) {
        if (s == null || s.isBlank()) return "_";
        // 版本/bookId 只应包含安全字符；做一次防御性过滤避免路径穿越
        if (s.contains("..") || s.contains("/") || s.contains("\\")) {
            return Integer.toHexString(s.hashCode());
        }
        return s;
    }

    private static String rootMessage(Throwable e) {
        Throwable t = e;
        while (t.getCause() != null && t.getCause() != t) t = t.getCause();
        String msg = t.getMessage();
        return (msg == null || msg.isBlank()) ? e.getClass().getSimpleName() : msg;
    }

    private static void deleteRecursively(Path path) {
        if (path == null || !Files.exists(path)) return;
        try (Stream<Path> walk = Files.walk(path)) {
            walk.sorted(Comparator.reverseOrder()).forEach(p -> {
                try {
                    Files.deleteIfExists(p);
                } catch (Exception ignored) {
                }
            });
        } catch (Exception ignored) {
        }
    }

    /** 资源不存在时抛出，便于 controller 映射 404 */
    public static class NoSuchFileExceptionSafe extends RuntimeException {
        public NoSuchFileExceptionSafe(String path) {
            super(path);
        }
    }
}
