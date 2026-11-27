package com.jt.workbench.modules.book.service;

import com.jt.workbench.modules.book.entity.Book;
import com.jt.workbench.modules.book.repo.BookRepository;
import io.documentnode.epub4j.domain.Metadata;
import io.documentnode.epub4j.domain.Resource;
import io.documentnode.epub4j.domain.Spine;
import io.documentnode.epub4j.domain.SpineReference;
import io.documentnode.epub4j.domain.TOCReference;
import io.documentnode.epub4j.epub.EpubReader;
import io.documentnode.epub4j.epub.EpubWriter;
import io.github.jiangood.openadmin.framework.spi.FileOperator;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

@Slf4j
@Service
@RequiredArgsConstructor
public class BookEpubService {

    private final BookRepository bookRepository;
    private final FileOperator fileOperator;
    private final BookEpubCacheService bookEpubCacheService;

    /**
     * 删除 EPUB 中的指定内容文档（spine 项），用于移除广告页等整节内容。
     * 成功后会替换原文件并清空阅读位置/进度。
     *
     * @param href       目标文档 href（可含 fragment），优先匹配
     * @param spineIndex epub.js 侧的 spine 序号，href 未命中时兜底
     */
    @Transactional
    public Book removeSection(String bookId, String href, Integer spineIndex) {
        Book book = bookRepository.findById(bookId).orElse(null);
        if (book == null) throw new IllegalArgumentException("书籍不存在");
        if (book.getR2Key() == null || book.getR2Key().isBlank()) {
            throw new IllegalArgumentException("这本书还没有 EPUB 文件");
        }

        byte[] original = download(book.getR2Key());
        byte[] modified;
        String removedLabel;
        try {
            io.documentnode.epub4j.domain.Book epub = new EpubReader().readEpub(new ByteArrayInputStream(original));
            Spine spine = epub.getSpine();
            if (spine == null || spine.getSpineReferences() == null || spine.getSpineReferences().size() <= 1) {
                throw new IllegalArgumentException("书籍内容过少，无法删除该页");
            }

            SpineReference target = findTarget(spine, href, spineIndex);
            if (target == null) throw new IllegalArgumentException("未找到要删除的内容页，请翻到广告页后重试");

            String targetHref = target.getResource() == null ? null : target.getResource().getHref();
            removedLabel = targetHref == null ? "当前页" : targetHref;

            // 从 spine 移除所有指向同一资源的引用
            List<SpineReference> toRemove = new ArrayList<>();
            for (SpineReference ref : spine.getSpineReferences()) {
                if (sameResource(ref, target)) toRemove.add(ref);
            }
            spine.getSpineReferences().removeAll(toRemove);
            if (spine.getSpineReferences().isEmpty()) {
                throw new IllegalArgumentException("不能删除最后一个内容页");
            }

            // 从目录中移除指向该资源的条目
            if (epub.getTableOfContents() != null) {
                removeTocRefs(epub.getTableOfContents().getTocReferences(), target.getResource());
            }

            // 资源若已不在 spine 中引用则移除（广告页通常是独立文档）
            Resource resource = target.getResource();
            if (resource != null && !isReferencedInSpine(spine, resource) && epub.getResources() != null) {
                try {
                    epub.getResources().remove(resource.getHref());
                } catch (Exception e) {
                    try {
                        epub.getResources().remove(resource.getId());
                    } catch (Exception ignored) {
                        // 尽力移除
                    }
                }
            }

            ByteArrayOutputStream out = new ByteArrayOutputStream(Math.max(1024, original.length));
            new EpubWriter().write(epub, out);
            modified = out.toByteArray();
        } catch (IllegalArgumentException e) {
            throw e;
        } catch (Exception e) {
            log.warn("EPUB 删除章节失败 bookId={}", bookId, e);
            throw new IllegalArgumentException("处理 EPUB 失败：" + rootMessage(e));
        }

        String oldKey = book.getR2Key();
        String filename = book.getFilename() == null || book.getFilename().isBlank() ? "book.epub" : book.getFilename();
        String newKey = "book/" + UUID.randomUUID() + "/" + java.net.URLEncoder.encode(filename, StandardCharsets.UTF_8);
        try (InputStream in = new ByteArrayInputStream(modified)) {
            fileOperator.save(newKey, in);
        } catch (Exception e) {
            throw new IllegalStateException("保存修改后的 EPUB 失败：" + rootMessage(e), e);
        }

        book.setR2Key(newKey);
        book.setSize((long) modified.length);
        book.setReadCfi(null);
        book.setReadCfiVersion(null);
        book.setProgress(0);
        Book saved = bookRepository.save(book);

        // 旧文件与阅读缓存失效，尽力清理
        try {
            bookEpubCacheService.purgeBook(bookId);
        } catch (Exception e) {
            log.warn("清理书籍阅读缓存失败 bookId={}", bookId, e);
        }
        try {
            if (oldKey != null && !oldKey.equals(newKey)) fileOperator.delete(oldKey);
        } catch (Exception ignored) {
        }

        log.info("已删除 EPUB 内容节 bookId={} target={} size {} -> {}", bookId, removedLabel, original.length, modified.length);
        return saved;
    }

    /**
     * 从 EPUB 元数据中补全书名 / 作者 / 出版社 / 简介 / ISBN / 出版时间。
     * 用于书架「直接上传」时自动建档；解析失败只记录日志，不影响文件上传。
     */
    public void fillMetadataFromEpub(Book book, InputStream input) {
        if (book == null || input == null) return;
        Path temp = null;
        try {
            temp = Files.createTempFile("book-meta-", ".epub");
            Files.copy(input, temp, StandardCopyOption.REPLACE_EXISTING);
            io.documentnode.epub4j.domain.Book epub;
            // 懒加载只解析 OPF 元数据，不把整本书的资源读进内存
            try (net.lingala.zip4j.ZipFile zip = new net.lingala.zip4j.ZipFile(temp.toFile())) {
                epub = new EpubReader().readEpubLazy(zip, "UTF-8");
            }
            Metadata metadata = epub == null ? null : epub.getMetadata();
            if (metadata == null) return;

            String title = firstText(metadata.getTitles());
            if (title != null) book.setTitle(title);

            if (metadata.getAuthors() != null) {
                String authors = metadata.getAuthors().stream()
                        .map(BookEpubService::authorName)
                        .filter(name -> name != null && !name.isEmpty())
                        .distinct()
                        .collect(Collectors.joining(" / "));
                if (!authors.isEmpty()) book.setAuthor(authors);
            }

            String publisher = firstText(metadata.getPublishers());
            if (publisher != null) book.setPublisher(publisher);

            String summary = htmlToText(firstText(metadata.getDescriptions()));
            if (summary != null) book.setSummary(summary);

            String isbn = findIsbn(metadata);
            if (isbn != null) book.setIsbn(isbn);

            String pubYear = findPubYear(metadata);
            if (pubYear != null) book.setPubYear(pubYear);
        } catch (Exception e) {
            log.warn("解析 EPUB 元数据失败，书名回退为文件名：{}", rootMessage(e));
        } finally {
            if (temp != null) {
                try {
                    Files.deleteIfExists(temp);
                } catch (Exception ignored) {
                    // 临时文件清理失败不影响上传结果
                }
            }
        }
    }

    private static String firstText(List<String> values) {
        if (values == null) return null;
        for (String value : values) {
            if (value != null && !value.isBlank()) return value.trim();
        }
        return null;
    }

    /** epub4j 的 Author.toString() 会拼出「姓, 名」并带多余逗号，这里只取有效姓名 */
    private static String authorName(io.documentnode.epub4j.domain.Author author) {
        if (author == null) return null;
        String first = blankToNull(author.getFirstname());
        String last = blankToNull(author.getLastname());
        if (first != null && last != null) return last + " " + first;
        return first != null ? first : last;
    }

    private static String blankToNull(String value) {
        return value == null || value.isBlank() ? null : value.trim();
    }

    /** 简介在 EPUB 里常带 HTML 标签，书架按纯文本展示，这里做一次轻量清洗 */
    private static String htmlToText(String html) {
        if (html == null) return null;
        String text = html.replaceAll("(?is)<(script|style)[^>]*>.*?</\\1>", " ")
                .replaceAll("<[^>]+>", " ")
                .replace("&nbsp;", " ")
                .replace("&amp;", "&")
                .replace("&lt;", "<")
                .replace("&gt;", ">")
                .replace("&quot;", "\"")
                .replace("&#39;", "'")
                .replaceAll("\\s+", " ")
                .trim();
        if (text.isEmpty()) return null;
        return text.length() > 5000 ? text.substring(0, 5000) : text;
    }

    private static String findIsbn(Metadata metadata) {
        if (metadata.getIdentifiers() == null) return null;
        for (var identifier : metadata.getIdentifiers()) {
            if (identifier == null || identifier.getValue() == null) continue;
            String scheme = identifier.getScheme() == null ? "" : identifier.getScheme().toLowerCase();
            String compact = identifier.getValue().replaceAll("[\\s-]", "");
            if (scheme.contains("isbn") || compact.matches("(?i)((97[89])?\\d{9}[\\dX])")) {
                return identifier.getValue().trim();
            }
        }
        return null;
    }

    private static String findPubYear(Metadata metadata) {
        if (metadata.getDates() == null) return null;
        Pattern pattern = Pattern.compile("(\\d{4})(?:[-/](\\d{1,2}))?");
        for (var date : metadata.getDates()) {
            if (date == null || date.getValue() == null) continue;
            Matcher matcher = pattern.matcher(date.getValue());
            if (!matcher.find()) continue;
            String year = matcher.group(1);
            if (matcher.group(2) != null) {
                try {
                    int month = Integer.parseInt(matcher.group(2));
                    if (month >= 1 && month <= 12) {
                        return year + "-" + String.format("%02d", month);
                    }
                } catch (NumberFormatException ignored) {
                    // 非法月份，仅保留年份
                }
            }
            return year;
        }
        return null;
    }

    private byte[] download(String key) {
        try (InputStream in = fileOperator.getFileStream(key)) {
            return in.readAllBytes();
        } catch (Exception e) {
            throw new IllegalStateException("读取 EPUB 文件失败：" + rootMessage(e), e);
        }
    }

    private static SpineReference findTarget(Spine spine, String href, Integer spineIndex) {
        String needle = normalizeHref(href);
        List<SpineReference> refs = spine.getSpineReferences();
        if (needle != null) {
            for (SpineReference ref : refs) {
                if (hrefMatches(ref, needle)) return ref;
            }
        }
        if (spineIndex != null && spineIndex >= 0 && spineIndex < refs.size()) {
            return refs.get(spineIndex);
        }
        return null;
    }

    private static boolean hrefMatches(SpineReference ref, String needle) {
        if (ref == null || ref.getResource() == null) return false;
        Resource r = ref.getResource();
        String rh = normalizeHref(r.getHref());
        if (needle.equals(rh)) return true;
        // 比较文件名/末段，兼容不同 base 路径
        String nTail = tail(needle);
        String rTail = tail(rh);
        return nTail != null && nTail.equals(rTail);
    }

    private static boolean sameResource(SpineReference a, SpineReference b) {
        if (a == b) return true;
        if (a == null || b == null || a.getResource() == null || b.getResource() == null) return false;
        Resource ra = a.getResource();
        Resource rb = b.getResource();
        if (ra == rb) return true;
        if (ra.getId() != null && ra.getId().equals(rb.getId())) return true;
        String ha = normalizeHref(ra.getHref());
        String hb = normalizeHref(rb.getHref());
        return ha != null && ha.equals(hb);
    }

    private static boolean isReferencedInSpine(Spine spine, Resource resource) {
        if (spine == null || resource == null) return false;
        for (SpineReference ref : spine.getSpineReferences()) {
            if (sameResource(ref, new SpineReference(resource))) return true;
        }
        return false;
    }

    private static void removeTocRefs(List<TOCReference> refs, Resource resource) {
        if (refs == null || resource == null) return;
        refs.removeIf(ref -> {
            boolean match = ref.getResource() != null && sameRes(ref.getResource(), resource);
            if (ref.getChildren() != null && !ref.getChildren().isEmpty()) {
                removeTocRefs(ref.getChildren(), resource);
            }
            return match;
        });
    }

    private static boolean sameRes(Resource a, Resource b) {
        if (a == b) return true;
        if (a == null || b == null) return false;
        if (a.getId() != null && a.getId().equals(b.getId())) return true;
        String ha = normalizeHref(a.getHref());
        String hb = normalizeHref(b.getHref());
        return ha != null && ha.equals(hb);
    }

    private static String normalizeHref(String href) {
        if (href == null) return null;
        String h = href.trim();
        int hash = h.indexOf('#');
        if (hash >= 0) h = h.substring(0, hash);
        int q = h.indexOf('?');
        if (q >= 0) h = h.substring(0, q);
        try {
            h = URLDecoder.decode(h, StandardCharsets.UTF_8);
        } catch (Exception ignored) {
        }
        h = h.replace('\\', '/');
        while (h.startsWith("./")) h = h.substring(2);
        while (h.startsWith("/")) h = h.substring(1);
        return h.isEmpty() ? null : h;
    }

    private static String tail(String href) {
        if (href == null) return null;
        int i = href.lastIndexOf('/');
        return i >= 0 ? href.substring(i + 1) : href;
    }

    private static String rootMessage(Throwable e) {
        Throwable t = e;
        while (t.getCause() != null && t.getCause() != t) t = t.getCause();
        String msg = t.getMessage();
        return (msg == null || msg.isBlank()) ? e.getClass().getSimpleName() : msg;
    }
}
