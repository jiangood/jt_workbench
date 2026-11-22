package com.jt.workbench.modules.book.controller;

import com.jt.workbench.modules.book.entity.Book;
import com.jt.workbench.modules.book.repo.BookRepository;
import com.jt.workbench.modules.book.service.BookEpubCacheService;
import com.jt.workbench.modules.book.service.BookEpubService;
import com.jt.workbench.modules.book.service.DoubanBookService;
import io.github.jiangood.openadmin.framework.perm.HasPermission;
import io.github.jiangood.openadmin.framework.spi.FileOperator;
import io.github.jiangood.openadmin.util.dto.AjaxResult;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.core.io.FileSystemResource;
import org.springframework.http.ContentDisposition;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.domain.Sort;
import org.springframework.data.web.PageableDefault;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;
import org.springframework.web.servlet.HandlerMapping;
import org.springframework.web.servlet.mvc.method.annotation.StreamingResponseBody;
import org.springframework.web.util.UriUtils;

import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.Map;
import java.util.UUID;

/**
 * 书架：列表（阅读状态 / 分组 / 关键字过滤）、增删改、EPUB 文件上传与在线阅读。
 * 阅读器（epub.js）经 file/{id} 取整本文件，进度 / 阅读位置按需回写。
 */
@RestController
@RequestMapping("admin/book")
public class BookController {

    @Autowired
    private BookRepository bookRepository;

    @Autowired
    private BookEpubService bookEpubService;

    @Autowired
    private BookEpubCacheService bookEpubCacheService;

    @Autowired
    private FileOperator fileOperator;

    @Autowired
    private DoubanBookService doubanBookService;

    private static final HttpClient COVER_PROXY_CLIENT = HttpClient.newBuilder()
            .followRedirects(HttpClient.Redirect.NORMAL)
            .connectTimeout(Duration.ofSeconds(8))
            .build();

    @HasPermission("book:read")
    @PostMapping("page")
    public AjaxResult page(@PageableDefault(sort = "updateTime", direction = Sort.Direction.DESC, size = 24) Pageable pageable,
                           @RequestParam(required = false) String status,
                           @RequestParam(required = false) String category,
                           @RequestParam(required = false) String keyword,
                           @RequestParam(required = false) String order) {
        Sort sort = shelfSort(order);
        Pageable target = sort == null ? pageable
                : org.springframework.data.domain.PageRequest.of(
                        pageable.getPageNumber(), pageable.getPageSize(), sort);
        Page<Book> page = bookRepository.search(blankToNull(keyword), blankToNull(status),
                blankToNull(category), target);
        return new AjaxResult().ok().data(page);
    }

    /** 书架统计：总数与各阅读状态数量，供筛选栏角标展示 */
    @HasPermission("book:read")
    @GetMapping("stats")
    public AjaxResult stats() {
        Map<String, Object> data = new java.util.LinkedHashMap<>();
        data.put("total", bookRepository.count());
        data.put("unread", bookRepository.countByStatus("unread") + bookRepository.countByStatusIsNull());
        data.put("reading", bookRepository.countByStatus("reading"));
        data.put("read", bookRepository.countByStatus("read"));
        return new AjaxResult().ok().data(data);
    }

    @HasPermission("book:read")
    @GetMapping("info/{id}")
    public AjaxResult info(@PathVariable String id) {
        Book item = bookRepository.findById(id).orElse(null);
        return item != null ? new AjaxResult().ok().data(item) : new AjaxResult();
    }

    @HasPermission("book:edit")
    @PostMapping("create")
    public AjaxResult create(@RequestBody Book input) {
        return new AjaxResult().ok().data(bookRepository.save(input));
    }

    @HasPermission("book:edit")
    @PostMapping("update")
    public AjaxResult update(@RequestBody Book input) {
        Book old = bookRepository.findById(input.getId()).orElse(null);
        if (old != null) {
            if (input.getTitle() != null) old.setTitle(input.getTitle());
            if (input.getAuthor() != null) old.setAuthor(input.getAuthor());
            if (input.getIsbn() != null) old.setIsbn(input.getIsbn());
            if (input.getPublisher() != null) old.setPublisher(input.getPublisher());
            if (input.getPubYear() != null) old.setPubYear(input.getPubYear());
            if (input.getCoverUrl() != null) old.setCoverUrl(input.getCoverUrl());
            if (input.getSummary() != null) old.setSummary(input.getSummary());
            if (input.getDoubanId() != null) old.setDoubanId(input.getDoubanId());
            if (input.getDoubanUrl() != null) old.setDoubanUrl(input.getDoubanUrl());
            if (input.getFormat() != null) old.setFormat(input.getFormat());
            if (input.getCategory() != null) old.setCategory(input.getCategory());
            if (input.getRating() != null) old.setRating(input.getRating());
            if (input.getStatus() != null) old.setStatus(input.getStatus());
            if (input.getReadMinutes() != null) old.setReadMinutes(input.getReadMinutes());
            if (input.getProgress() != null) old.setProgress(input.getProgress());
            bookRepository.save(old);
        }
        return new AjaxResult();
    }

    @HasPermission("book:edit")
    @PostMapping("delete")
    public AjaxResult delete(@RequestBody io.github.jiangood.openadmin.util.dto.IdReq req) {
        Book book = bookRepository.findById(req.getId()).orElse(null);
        bookRepository.deleteById(req.getId());
        if (book != null) {
            try {
                bookEpubCacheService.purgeBook(book.getId());
            } catch (Exception ignored) {
            }
            if (book.getR2Key() != null && !book.getR2Key().isBlank()) {
                try {
                    fileOperator.delete(book.getR2Key());
                } catch (Exception ignored) {
                    // 对象删不掉不阻塞书目删除，后续可人工清理
                }
            }
        }
        return new AjaxResult();
    }

    /** 分组（分类）下拉候选 */
    @HasPermission("book:read")
    @GetMapping("categories")
    public AjaxResult categories() {
        return new AjaxResult().ok().data(bookRepository.findCategories());
    }

    /** 同步豆瓣信息（预览）：按书籍 ISBN / 书名从豆瓣检索元数据，返回待确认字段 */
    @HasPermission("book:edit")
    @GetMapping("douban/preview/{id}")
    public AjaxResult doubanPreview(@PathVariable String id) {
        Book book = bookRepository.findById(id).orElse(null);
        if (book == null) return AjaxResult.err("书籍不存在");
        try {
            Map<String, Object> data = doubanBookService.lookup(book);
            // 将豆瓣封面转为本服务代理地址，避免浏览器直连豆瓣图片的防盗链/跨域问题
            Object cover = data.get("coverUrl");
            if (cover instanceof String coverUrl && isAllowedDoubanCoverUrl(coverUrl)) {
                data.put("coverUrl", proxiedCoverUrl(coverUrl));
                data.put("originalCoverUrl", coverUrl);
            }
            return new AjaxResult().ok().data(data);
        } catch (IllegalArgumentException | IllegalStateException e) {
            return AjaxResult.err(e.getMessage());
        } catch (Exception e) {
            return AjaxResult.err("同步豆瓣信息失败：" + (e.getMessage() == null ? "请稍后重试" : e.getMessage()));
        }
    }

    /** 豆瓣封面代理（仅允许 douban 图片域名），用于书架封面展示 */
    @HasPermission("book:read")
    @GetMapping("cover/proxy")
    public ResponseEntity<byte[]> coverProxy(@RequestParam String url) {
        if (!isAllowedDoubanCoverUrl(url)) {
            return ResponseEntity.badRequest().build();
        }
        try {
            HttpRequest req = HttpRequest.newBuilder(URI.create(url))
                    .timeout(Duration.ofSeconds(12))
                    .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36")
                    .header("Referer", "https://book.douban.com/")
                    .GET()
                    .build();
            HttpResponse<byte[]> resp = COVER_PROXY_CLIENT.send(req, HttpResponse.BodyHandlers.ofByteArray());
            if (resp.statusCode() < 200 || resp.statusCode() >= 300 || resp.body() == null) {
                return ResponseEntity.status(resp.statusCode()).build();
            }
            String ct = resp.headers().firstValue("Content-Type").orElse("image/jpeg");
            return ResponseEntity.ok()
                    .contentType(MediaType.parseMediaType(ct.startsWith("image/") ? ct : "image/jpeg"))
                    .header(HttpHeaders.CACHE_CONTROL, "public, max-age=86400")
                    .body(resp.body());
        } catch (Exception e) {
            return ResponseEntity.status(502).build();
        }
    }

    // ---------- EPUB 文件：上传 / 在线阅读 ----------

    /** EPUB 上传 / 更换文件：直接写对象存储（不建 sys_file 行，避免临时文件清理误删），key 沿用旧约定 book/{uuid}/{filename} */
    @HasPermission("book:edit")
    @PostMapping("upload")
    public AjaxResult upload(@RequestParam(value = "file", required = false) MultipartFile file,
                             @RequestParam(required = false) String bookId) {
        if (file == null || file.isEmpty()) return AjaxResult.err("请选择 EPUB 文件");
        String filename = file.getOriginalFilename() == null ? "book.epub" : file.getOriginalFilename().trim();
        if (!filename.toLowerCase().endsWith(".epub")) return AjaxResult.err("仅支持 EPUB 文件");

        Book book = null;
        if (bookId != null && !bookId.isBlank()) {
            book = bookRepository.findById(bookId).orElse(null);
            if (book == null) return AjaxResult.err("书籍不存在");
        }

        String key = "book/" + UUID.randomUUID() + "/" + URLEncoder.encode(filename, StandardCharsets.UTF_8);
        try (InputStream in = file.getInputStream()) {
            fileOperator.save(key, in);
        } catch (IOException e) {
            return AjaxResult.err("上传失败：" + e.getMessage());
        }

        String oldKey = book == null ? null : book.getR2Key();
        if (book == null) {
            book = new Book();
            book.setTitle(titleFromFilename(filename));
            book.setStatus("unread");
            book.setProgress(0);
        }
        // 换文件后旧阅读位置失效（版本号取自 r2Key，前端据此忽略旧 CFI）
        book.setR2Key(key);
        book.setFilename(filename);
        book.setFmt("epub");
        book.setFormat("epub");
        book.setSize(file.getSize());
        book.setReadCfi(null);
        book.setReadCfiVersion(null);
        Book saved = bookRepository.save(book);

        // 文件版本已变更，旧解包缓存失效
        try {
            bookEpubCacheService.purgeBook(saved.getId());
        } catch (Exception ignored) {
        }
        if (oldKey != null && !oldKey.isBlank() && !oldKey.equals(key)) {
            try {
                fileOperator.delete(oldKey);
            } catch (Exception ignored) {
                // 旧对象删不掉不影响新文件阅读
            }
        }
        return new AjaxResult().ok("已上传").data(saved);
    }

    /** 阅读器取整本 EPUB（流式，按 size 下发 Content-Length 供前端显示下载进度） */
    @HasPermission("book:read")
    @GetMapping("file/{id}")
    public ResponseEntity<StreamingResponseBody> file(@PathVariable String id) {
        Book book = bookRepository.findById(id).orElse(null);
        if (book == null || book.getR2Key() == null || book.getR2Key().isBlank()) {
            return ResponseEntity.notFound().build();
        }
        String key = book.getR2Key();
        String filename = book.getFilename() == null || book.getFilename().isBlank()
                ? id + ".epub" : book.getFilename();
        MediaType type = filename.toLowerCase().endsWith(".epub")
                ? MediaType.parseMediaType("application/epub+zip")
                : MediaType.APPLICATION_OCTET_STREAM;

        ResponseEntity.BodyBuilder builder = ResponseEntity.ok()
                .contentType(type)
                .header(HttpHeaders.CONTENT_DISPOSITION,
                        ContentDisposition.inline().filename(filename, StandardCharsets.UTF_8).build().toString())
                .header(HttpHeaders.CACHE_CONTROL, "private, max-age=86400");
        if (book.getSize() != null && book.getSize() > 0) {
            builder.contentLength(book.getSize());
        }
        return builder.body(out -> {
            try (InputStream in = fileOperator.getFileStream(key)) {
                in.transferTo(out);
            }
        });
    }

    // ---------- 在线阅读：解包缓存 + 按需取资源 ----------

    /**
     * 准备阅读：确保 EPUB 已解包到本地缓存，返回 OPF 相对路径与版本号。
     * 前端据此以 unpacked 方式按需加载章节/资源，避免整本下载。
     */
    @HasPermission("book:read")
    @GetMapping("open/{id}")
    public AjaxResult open(@PathVariable String id) {
        Book book = bookRepository.findById(id).orElse(null);
        if (book == null) return AjaxResult.err("书籍不存在");
        if (book.getR2Key() == null || book.getR2Key().isBlank()) {
            return AjaxResult.err("这本书还没有上传 EPUB 文件，回书架点「上传」后即可阅读。");
        }
        try {
            Path dir = bookEpubCacheService.ensureExtracted(book);
            String opfPath = bookEpubCacheService.resolveOpfPath(dir);
            String version = bookEpubCacheService.versionOf(book);
            return new AjaxResult().ok().data(Map.of("version", version, "opfPath", opfPath));
        } catch (IllegalArgumentException e) {
            return AjaxResult.err(e.getMessage());
        } catch (Exception e) {
            return AjaxResult.err("打开失败：" + (e.getMessage() == null ? "未知错误" : e.getMessage()));
        }
    }

    /** 读取解包缓存中的单个资源（章节/图片/CSS/字体等），按需下发 */
    @HasPermission("book:read")
    @GetMapping("resource/{id}/{version}/**")
    public ResponseEntity<?> resource(@PathVariable String id,
                                      @PathVariable String version,
                                      HttpServletRequest request) {
        String attr = (String) request.getAttribute(HandlerMapping.PATH_WITHIN_HANDLER_MAPPING_ATTRIBUTE);
        String marker = "/resource/" + id + "/" + version + "/";
        String rel = null;
        if (attr != null) {
            int idx = attr.indexOf(marker);
            if (idx >= 0) rel = attr.substring(idx + marker.length());
        }
        if (rel == null || rel.isBlank()) {
            return ResponseEntity.badRequest().build();
        }
        rel = UriUtils.decode(rel, StandardCharsets.UTF_8);

        Path dir = bookEpubCacheService.versionDir(id, version);
        if (!Files.isDirectory(dir)) {
            return ResponseEntity.notFound().build();
        }
        try {
            Path file = bookEpubCacheService.resolveResource(dir, rel);
            FileSystemResource body = new FileSystemResource(file);
            MediaType mediaType = detectMediaType(file);
            return ResponseEntity.ok()
                    .contentType(mediaType)
                    .contentLength(Files.size(file))
                    .header(HttpHeaders.CACHE_CONTROL, "private, max-age=31536000, immutable")
                    .body(body);
        } catch (BookEpubCacheService.NoSuchFileExceptionSafe e) {
            return ResponseEntity.notFound().build();
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().build();
        } catch (Exception e) {
            return ResponseEntity.status(500).build();
        }
    }

    // ---------- 阅读状态回写（不打乱书架 updateTime 排序） ----------

    /** 打开阅读器：刷新最近阅读时间，待读 → 阅读中 */
    @HasPermission("book:read")
    @PostMapping("reading/{id}")
    public AjaxResult reading(@PathVariable String id) {
        bookRepository.markReading(id, System.currentTimeMillis());
        return new AjaxResult();
    }

    /** 阅读进度 0–100（翻页 / 滚动时前端节流上报） */
    @HasPermission("book:read")
    @PostMapping("progress/{id}")
    public AjaxResult progress(@PathVariable String id, @RequestBody Map<String, Object> body) {
        Integer pct = normalizeProgress(body == null ? null : body.get("progress"));
        if (pct == null) return AjaxResult.err("进度无效");
        bookRepository.updateProgress(id, pct, System.currentTimeMillis());
        return new AjaxResult();
    }

    /** EPUB 精确阅读位置（CFI）云端保存：跨设备续读，version = 当前文件的版本号 */
    @HasPermission("book:read")
    @PostMapping("position/{id}")
    public AjaxResult position(@PathVariable String id, @RequestBody Map<String, Object> body) {
        String cfi = body == null || body.get("cfi") == null ? null : String.valueOf(body.get("cfi")).trim();
        if (cfi == null || cfi.isBlank()) return AjaxResult.err("阅读位置无效");
        if (cfi.length() > 4000) cfi = cfi.substring(0, 4000);
        String version = body.get("version") == null ? null : String.valueOf(body.get("version")).trim();
        bookRepository.updatePosition(id, cfi, version, System.currentTimeMillis());
        return new AjaxResult();
    }

    /** 删除当前内容页（spine 文档），用于移除广告页；会修改 EPUB 并清空阅读位置/进度 */
    @HasPermission("book:edit")
    @PostMapping("removeSection/{id}")
    public AjaxResult removeSection(@PathVariable String id, @RequestBody(required = false) Map<String, Object> body) {
        String href = body == null || body.get("href") == null ? null : String.valueOf(body.get("href")).trim();
        Integer index = parseInteger(body == null ? null : body.get("index"));
        try {
            Book saved = bookEpubService.removeSection(id, href, index);
            return new AjaxResult().ok("已删除当前页").data(saved);
        } catch (IllegalArgumentException e) {
            return AjaxResult.err(e.getMessage());
        } catch (Exception e) {
            return AjaxResult.err("删除失败：" + (e.getMessage() == null ? "未知错误" : e.getMessage()));
        }
    }

    private static String blankToNull(String v) {
        return v == null || v.isBlank() ? null : v.trim();
    }

    /** 书架排序白名单：recent 最近更新 / lastRead 最近阅读 / title 书名 / rating 评分 */
    private static Sort shelfSort(String order) {
        if (order == null || order.isBlank()) return null;
        return switch (order.trim()) {
            case "recent" -> Sort.by(Sort.Direction.DESC, "updateTime");
            case "lastRead" -> Sort.by(Sort.Direction.DESC, "lastReadAt");
            case "title" -> Sort.by(Sort.Direction.ASC, "title");
            case "rating" -> Sort.by(Sort.Direction.DESC, "rating");
            default -> null;
        };
    }

    /** 进度：0–100 的整数，非法值返回 null */
    private static Integer normalizeProgress(Object value) {
        if (value == null) return null;
        try {
            double n = Double.parseDouble(String.valueOf(value));
            if (Double.isNaN(n) || Double.isInfinite(n)) return null;
            return (int) Math.max(0, Math.min(100, Math.round(n)));
        } catch (NumberFormatException e) {
            return null;
        }
    }

    private static Integer parseInteger(Object value) {
        if (value == null) return null;
        try {
            return Integer.parseInt(String.valueOf(value));
        } catch (NumberFormatException e) {
            return null;
        }
    }

    /** 书名：文件名里的《书名》优先（下载来的文件常带站点前缀），否则去掉扩展名 */
    private static String titleFromFilename(String filename) {
        java.util.regex.Matcher inner = java.util.regex.Pattern.compile("《([^》]+)》").matcher(filename);
        if (inner.find() && !inner.group(1).isBlank()) return inner.group(1).trim();
        String base = filename.replaceFirst("\\.[^.]+$", "").trim();
        return base.isBlank() ? filename : base;
    }

    private static boolean isAllowedDoubanCoverUrl(String url) {
        if (url == null || url.isBlank()) return false;
        String u = url.trim().toLowerCase(java.util.Locale.ROOT);
        if (!(u.startsWith("http://") || u.startsWith("https://"))) return false;
        try {
            String host = URI.create(url).getHost();
            if (host == null) return false;
            String h = host.toLowerCase(java.util.Locale.ROOT);
            return h.equals("douban.com") || h.endsWith(".douban.com")
                    || h.equals("doubanio.com") || h.endsWith(".doubanio.com");
        } catch (Exception e) {
            return false;
        }
    }

    private static String proxiedCoverUrl(String coverUrl) {
        return "/admin/book/cover/proxy?url=" + URLEncoder.encode(coverUrl, StandardCharsets.UTF_8);
    }

    private static MediaType detectMediaType(Path file) {
        String name = file.getFileName() == null ? "" : file.getFileName().toString().toLowerCase(java.util.Locale.ROOT);
        String type = null;
        if (name.endsWith(".xhtml") || name.endsWith(".xht") || name.endsWith(".html") || name.endsWith(".htm")) {
            type = "application/xhtml+xml";
        } else if (name.endsWith(".opf")) {
            type = "application/oebps-package+xml";
        } else if (name.endsWith(".ncx")) {
            type = "application/x-dtbncx+xml";
        } else if (name.endsWith(".xml")) {
            type = "application/xml";
        } else if (name.endsWith(".css")) {
            type = "text/css";
        } else if (name.endsWith(".js")) {
            type = "application/javascript";
        } else if (name.endsWith(".svg")) {
            type = "image/svg+xml";
        } else if (name.endsWith(".jpg") || name.endsWith(".jpeg")) {
            type = "image/jpeg";
        } else if (name.endsWith(".png")) {
            type = "image/png";
        } else if (name.endsWith(".gif")) {
            type = "image/gif";
        } else if (name.endsWith(".webp")) {
            type = "image/webp";
        } else if (name.endsWith(".avif")) {
            type = "image/avif";
        } else if (name.endsWith(".bmp")) {
            type = "image/bmp";
        } else if (name.endsWith(".ttf")) {
            type = "font/ttf";
        } else if (name.endsWith(".otf")) {
            type = "font/otf";
        } else if (name.endsWith(".woff")) {
            type = "font/woff";
        } else if (name.endsWith(".woff2")) {
            type = "font/woff2";
        } else if (name.endsWith(".mp3")) {
            type = "audio/mpeg";
        } else if (name.endsWith(".mp4")) {
            type = "video/mp4";
        } else if (name.endsWith(".smil")) {
            type = "application/smil+xml";
        } else if (name.endsWith(".pls")) {
            type = "application/pls+xml";
        } else {
            try {
                type = Files.probeContentType(file);
            } catch (Exception ignored) {
            }
        }
        if (type == null || type.isBlank()) type = "application/octet-stream";
        try {
            return MediaType.parseMediaType(type);
        } catch (Exception e) {
            return MediaType.APPLICATION_OCTET_STREAM;
        }
    }
}
