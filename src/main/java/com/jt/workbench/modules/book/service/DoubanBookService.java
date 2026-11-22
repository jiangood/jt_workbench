package com.jt.workbench.modules.book.service;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import com.jt.workbench.modules.book.entity.Book;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.*;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

/**
 * 从豆瓣获取图书元信息（按 ISBN / 书名检索），用于书架“同步豆瓣信息”。
 * 说明：豆瓣无稳定公开 API，这里通过页面/公开 JSON 端点做轻量解析，可能受反爬或页面结构变化影响。
 */
@Service
public class DoubanBookService {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private static final HttpClient CLIENT = HttpClient.newBuilder()
            .followRedirects(HttpClient.Redirect.NORMAL)
            .connectTimeout(Duration.ofSeconds(8))
            .build();

    private static final Pattern SUBJECT_ID_PATTERN = Pattern.compile("/subject/(\\d+)/?");
    private static final Pattern JSON_LD_PATTERN = Pattern.compile(
            "<script[^>]*type=[\"']application/ld\\+json[\"'][^>]*>(.*?)</script>",
            Pattern.CASE_INSENSITIVE | Pattern.DOTALL);
    private static final Pattern RATING_PATTERN = Pattern.compile(
            "<strong[^>]*class=[\"'][^\"']*rating_num[^\"']*[\"'][^>]*>([0-9.]+)</strong>",
            Pattern.CASE_INSENSITIVE);
    private static final Pattern OG_IMAGE_PATTERN = Pattern.compile(
            "<meta[^>]+property=[\"']og:image[\"'][^>]+content=[\"']([^\"']+)[\"']",
            Pattern.CASE_INSENSITIVE);
    private static final Pattern TITLE_SPAN_PATTERN = Pattern.compile(
            "<span[^>]*property=[\"']v:itemreviewed[\"'][^>]*>(.*?)</span>",
            Pattern.CASE_INSENSITIVE | Pattern.DOTALL);
    private static final Pattern INFO_BLOCK_PATTERN = Pattern.compile(
            "<div[^>]*id=[\"']info[\"'][^>]*>(.*?)</div>",
            Pattern.CASE_INSENSITIVE | Pattern.DOTALL);

    public Map<String, Object> lookup(Book book) {
        if (book == null) {
            throw new IllegalArgumentException("书籍不存在");
        }

        String isbn = digits(book.getIsbn());
        String title = trimToNull(book.getTitle());

        SubjectRef ref = null;
        String lastError = null;

        if (isbn != null) {
            try {
                ref = resolveByIsbn(isbn);
            } catch (Exception e) {
                lastError = "按 ISBN 查询失败：" + rootMessage(e);
            }
        }

        if (ref == null) {
            String keyword = isbn != null ? isbn : title;
            if (keyword != null) {
                try {
                    ref = resolveBySuggest(keyword);
                } catch (Exception e) {
                    String msg = "按书名/关键词查询失败：" + rootMessage(e);
                    lastError = lastError == null ? msg : lastError + "；" + msg;
                }
            }
        }

        if (ref == null || ref.subjectId == null) {
            String reason = lastError != null ? lastError : "未在豆瓣找到匹配图书";
            throw new IllegalStateException(reason + "。可先补充准确的 ISBN 或书名后重试。");
        }

        try {
            String html = fetchHtml(ref.subjectUrl());
            Map<String, Object> data = parseSubject(html, ref.subjectId, ref.subjectUrl(), ref);
            if (data.isEmpty()) {
                throw new IllegalStateException("已定位到豆瓣条目，但未能解析出可用信息");
            }
            return data;
        } catch (IOException | InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("获取豆瓣图书详情失败：" + rootMessage(e));
        } catch (RuntimeException e) {
            throw e;
        } catch (Exception e) {
            throw new IllegalStateException("解析豆瓣图书信息失败：" + rootMessage(e));
        }
    }

    private SubjectRef resolveByIsbn(String isbn) throws Exception {
        // 直接访问 ISBN 页，通常会 302 到 /subject/{id}/
        String url = "https://book.douban.com/isbn/" + URLEncoder.encode(isbn, StandardCharsets.UTF_8) + "/";
        HttpResponse<String> resp = send(url, true);
        if (resp.statusCode() >= 200 && resp.statusCode() < 300) {
            String finalUrl = resp.uri() == null ? url : resp.uri().toString();
            Matcher m = SUBJECT_ID_PATTERN.matcher(finalUrl);
            if (m.find()) {
                return new SubjectRef(m.group(1), null, null, null);
            }
            // 某些情况下返回页面但 URI 未体现 subject，可从内容中提取
            Matcher body = SUBJECT_ID_PATTERN.matcher(resp.body() == null ? "" : resp.body());
            if (body.find()) {
                return new SubjectRef(body.group(1), null, null, null);
            }
        }
        // ISBN 页不可用时回退到 suggest
        return resolveBySuggest(isbn);
    }

    private SubjectRef resolveBySuggest(String keyword) throws Exception {
        String url = "https://book.douban.com/j/subject_suggest?q=" + URLEncoder.encode(keyword, StandardCharsets.UTF_8);
        HttpResponse<String> resp = send(url, false);
        if (resp.statusCode() != 200) {
            throw new IOException("HTTP " + resp.statusCode());
        }
        String body = resp.body() == null ? "[]" : resp.body().trim();
        JsonNode arr = MAPPER.readTree(body);
        if (!arr.isArray() || arr.isEmpty()) return null;

        for (JsonNode item : arr) {
            String type = text(item, "type");
            String itemUrl = firstText(item, "url", "link");
            String id = firstText(item, "id", "subject_id");
            if (id == null && itemUrl != null) {
                Matcher m = SUBJECT_ID_PATTERN.matcher(itemUrl);
                if (m.find()) id = m.group(1);
            }
            boolean bookLike = "b".equalsIgnoreCase(type) || "book".equalsIgnoreCase(type)
                    || (itemUrl != null && itemUrl.contains("/subject/"));
            if (id == null || !bookLike) continue;

            String pic = normalizeCover(firstText(item, "pic", "img", "cover", "image"));
            String year = firstText(item, "year");
            String suggestTitle = firstText(item, "title", "name");
            String authorName = firstText(item, "author_name");
            return new SubjectRef(id, suggestTitle, pic, authorName, year);
        }
        // 宽松兜底：取第一个带 id 的条目
        for (JsonNode item : arr) {
            String itemUrl = firstText(item, "url", "link");
            String id = firstText(item, "id", "subject_id");
            if (id == null && itemUrl != null) {
                Matcher m = SUBJECT_ID_PATTERN.matcher(itemUrl);
                if (m.find()) id = m.group(1);
            }
            if (id != null) {
                String pic = normalizeCover(firstText(item, "pic", "img", "cover", "image"));
                String year = firstText(item, "year");
                String suggestTitle = firstText(item, "title", "name");
                String authorName = firstText(item, "author_name");
                return new SubjectRef(id, suggestTitle, pic, authorName, year);
            }
        }
        return null;
    }

    private String fetchHtml(String url) throws Exception {
        HttpResponse<String> resp = send(url, true);
        if (resp.statusCode() == 404) throw new IllegalStateException("豆瓣条目不存在或无法访问");
        if (resp.statusCode() >= 400) throw new IOException("HTTP " + resp.statusCode());
        return resp.body() == null ? "" : resp.body();
    }

    private Map<String, Object> parseSubject(String html, String subjectId, String subjectUrl, SubjectRef hint) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("doubanId", subjectId);
        out.put("doubanUrl", subjectUrl);

        // 1) JSON-LD（优先，结构较稳定）
        JsonNode bookNode = findBookJsonLd(html);
        if (bookNode != null) {
            putIfPresent(out, "title", clean(firstText(bookNode, "name", "title")));
            String author = extractAuthors(bookNode.get("author"));
            putIfPresent(out, "author", clean(author));
            putIfPresent(out, "isbn", normalizeIsbn(firstText(bookNode, "isbn")));
            putIfPresent(out, "coverUrl", normalizeCover(firstText(bookNode, "image", "thumbnailUrl")));
            putIfPresent(out, "doubanUrl", firstText(bookNode, "url"));
        }

        // 2) HTML 兜底/补充
        if (isBlank(out.get("title"))) {
            putIfPresent(out, "title", clean(extractFirstGroup(TITLE_SPAN_PATTERN, html)));
        }
        if (isBlank(out.get("coverUrl"))) {
            putIfPresent(out, "coverUrl", normalizeCover(extractFirstGroup(OG_IMAGE_PATTERN, html)));
        }
        if (isBlank(out.get("coverUrl")) && hint != null) {
            putIfPresent(out, "coverUrl", normalizeCover(hint.pic));
        }
        if (isBlank(out.get("title")) && hint != null) {
            putIfPresent(out, "title", clean(hint.title));
        }
        if (isBlank(out.get("author")) && hint != null) {
            putIfPresent(out, "author", clean(hint.authorName));
        }

        String rating = extractFirstGroup(RATING_PATTERN, html);
        if (rating != null) {
            try {
                double r = Double.parseDouble(rating.trim());
                if (r > 0) putIfPresent(out, "rating", String.format(java.util.Locale.US, "%.1f", r));
            } catch (NumberFormatException ignored) {
            }
        }

        Map<String, String> info = parseInfoBlock(html);
        if (isBlank(out.get("author"))) putIfPresent(out, "author", clean(firstOf(info, "作者")));
        if (isBlank(out.get("publisher"))) putIfPresent(out, "publisher", clean(firstOf(info, "出版社", "出品方")));
        if (isBlank(out.get("isbn"))) putIfPresent(out, "isbn", normalizeIsbn(firstOf(info, "ISBN")));
        if (isBlank(out.get("pubYear"))) putIfPresent(out, "pubYear", clean(firstOf(info, "出版年", "出版时间")));
        // suggest 可能带年份，可作为弱兜底
        if (isBlank(out.get("pubYear")) && hint != null) putIfPresent(out, "pubYear", clean(hint.year));

        String summary = extractSummary(html);
        putIfPresent(out, "summary", summary);

        // 确保 doubanUrl 规范
        out.put("doubanUrl", "https://book.douban.com/subject/" + subjectId + "/");
        return out;
    }

    private JsonNode findBookJsonLd(String html) {
        Matcher m = JSON_LD_PATTERN.matcher(html == null ? "" : html);
        while (m.find()) {
            String json = htmlUnescape(m.group(1).trim());
            if (json.isEmpty()) continue;
            try {
                JsonNode node = MAPPER.readTree(json);
                JsonNode book = findBookNode(node);
                if (book != null) return book;
            } catch (Exception ignored) {
                // 某些 ld+json 块可能不是合法 JSON，忽略继续
            }
        }
        return null;
    }

    private JsonNode findBookNode(JsonNode node) {
        if (node == null || node.isNull()) return null;
        if (node.isArray()) {
            for (JsonNode item : node) {
                JsonNode found = findBookNode(item);
                if (found != null) return found;
            }
            return null;
        }
        if (node.isObject()) {
            String type = text(node, "@type");
            if ("Book".equalsIgnoreCase(type) || "Product".equalsIgnoreCase(type)
                    || node.has("isbn") || (node.has("name") && node.has("author"))) {
                return node;
            }
            // @graph 场景
            if (node.has("@graph")) return findBookNode(node.get("@graph"));
        }
        return null;
    }

    private String extractAuthors(JsonNode authorNode) {
        if (authorNode == null || authorNode.isNull()) return null;
        List<String> names = new ArrayList<>();
        if (authorNode.isArray()) {
            for (JsonNode a : authorNode) collectAuthorName(a, names);
        } else {
            collectAuthorName(authorNode, names);
        }
        names = names.stream().map(DoubanBookService::clean).filter(Objects::nonNull).distinct().collect(Collectors.toList());
        return names.isEmpty() ? null : String.join(" / ", names);
    }

    private void collectAuthorName(JsonNode a, List<String> names) {
        if (a == null || a.isNull()) return;
        if (a.isTextual()) {
            names.add(a.asText());
        } else if (a.isObject()) {
            String n = firstText(a, "name");
            if (n != null) names.add(n);
        }
    }

    private Map<String, String> parseInfoBlock(String html) {
        Map<String, String> map = new LinkedHashMap<>();
        Matcher m = INFO_BLOCK_PATTERN.matcher(html == null ? "" : html);
        if (!m.find()) return map;
        String block = m.group(1);
        // 统一换行，便于按 <br> 或行切分
        block = block.replaceAll("(?i)<br\\s*/?>", "\n");
        String text = stripTags(block);
        text = htmlUnescape(text);
        for (String rawLine : text.split("\n")) {
            String line = rawLine.replace('\u00A0', ' ').trim();
            if (line.isEmpty()) continue;
            int idx = line.indexOf(':');
            if (idx < 0) idx = line.indexOf('：');
            if (idx <= 0) continue;
            String key = line.substring(0, idx).trim();
            String val = line.substring(idx + 1).trim();
            if (!key.isEmpty() && !val.isEmpty()) {
                val = val.replaceAll("\\s+", " ").trim();
                map.putIfAbsent(key, val);
            }
        }
        return map;
    }

    private String extractSummary(String html) {
        if (html == null) return null;
        // 优先“展开全部”内容
        List<String> candidates = new ArrayList<>();
        collectIntroTexts(html, "link-report", candidates);
        if (candidates.isEmpty()) collectIntroTexts(html, "content", candidates);
        String best = null;
        for (String c : candidates) {
            String t = clean(stripTags(c));
            if (t == null) continue;
            if (best == null || t.length() > best.length()) best = t;
        }
        if (best == null) return null;
        // 限制长度，避免超大文本
        if (best.length() > 4000) best = best.substring(0, 4000) + "…";
        return best;
    }

    private void collectIntroTexts(String html, String containerId, List<String> out) {
        Pattern container = Pattern.compile(
                "<div[^>]*id=[\"']" + Pattern.quote(containerId) + "[\"'][^>]*>(.*?)</div>\\s*</div>",
                Pattern.CASE_INSENSITIVE | Pattern.DOTALL);
        // 简化：直接在整页找 intro 块也可，但范围太大；这里尝试 id=link-report 区域（弱匹配）
        Pattern area = Pattern.compile(
                "<div[^>]*id=[\"']" + Pattern.quote(containerId) + "[\"'][^>]*>(.*?)(?:<div[^>]*class=[\"'][^\"']*related_info|<div[^>]*id=[\"']rec-ebook-section)",
                Pattern.CASE_INSENSITIVE | Pattern.DOTALL);
        Matcher am = area.matcher(html);
        String scope = am.find() ? am.group(1) : html;
        Pattern intro = Pattern.compile("<div[^>]*class=[\"'][^\"']*intro[^\"']*[\"'][^>]*>(.*?)</div>",
                Pattern.CASE_INSENSITIVE | Pattern.DOTALL);
        Matcher im = intro.matcher(scope);
        while (im.find()) out.add(im.group(1));
    }

    private HttpResponse<String> send(String url, boolean referer) throws IOException, InterruptedException {
        HttpRequest.Builder b = HttpRequest.newBuilder(URI.create(url))
                .timeout(Duration.ofSeconds(12))
                .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36")
                .header("Accept", "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8")
                .header("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8");
        if (referer) b.header("Referer", "https://book.douban.com/");
        b.GET();
        return CLIENT.send(b.build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
    }

    private static String extractFirstGroup(Pattern p, String text) {
        if (text == null) return null;
        Matcher m = p.matcher(text);
        return m.find() ? m.group(1) : null;
    }

    private static String stripTags(String html) {
        if (html == null) return null;
        return html.replaceAll("(?is)<script.*?>.*?</script>", " ")
                .replaceAll("(?is)<style.*?>.*?</style>", " ")
                .replaceAll("(?is)<[^>]+>", " ");
    }

    private static String htmlUnescape(String s) {
        if (s == null) return null;
        return s.replace("&nbsp;", " ")
                .replace("&amp;", "&")
                .replace("&quot;", "\"")
                .replace("&#39;", "'")
                .replace("&lt;", "<")
                .replace("&gt;", ">")
                .replace("\u00A0", " ");
    }

    private static String text(JsonNode node, String field) {
        if (node == null || !node.has(field)) return null;
        JsonNode v = node.get(field);
        if (v == null || v.isNull()) return null;
        String s;
        if (v.isString()) {
            s = v.asString();
        } else if (v.isNumber() || v.isBoolean()) {
            s = v.asString();
        } else {
            s = v.toString();
        }
        return trimToNull(s);
    }

    private static String firstText(JsonNode node, String... fields) {
        if (node == null || fields == null) return null;
        for (String f : fields) {
            String v = text(node, f);
            if (v != null) return v;
        }
        return null;
    }

    private static String firstOf(Map<String, String> map, String... keys) {
        if (map == null || keys == null) return null;
        for (String k : keys) {
            String v = map.get(k);
            if (v != null && !v.isBlank()) return v.trim();
        }
        return null;
    }

    private static void putIfPresent(Map<String, Object> out, String key, String value) {
        if (value != null && !value.isBlank()) out.put(key, value.trim());
    }

    private static boolean isBlank(Object v) {
        return v == null || String.valueOf(v).isBlank();
    }

    private static String trimToNull(String s) {
        if (s == null) return null;
        String t = s.trim();
        return t.isEmpty() ? null : t;
    }

    private static String clean(String s) {
        if (s == null) return null;
        String t = htmlUnescape(stripTags(s));
        if (t == null) return null;
        t = t.replaceAll("\\s+", " ").trim();
        // 去掉包裹引号等噪声
        if (t.length() >= 2 && ((t.startsWith("\"") && t.endsWith("\"")) || (t.startsWith("'") && t.endsWith("'")))) {
            t = t.substring(1, t.length() - 1).trim();
        }
        return t.isEmpty() ? null : t;
    }

    private static String digits(String s) {
        if (s == null) return null;
        String d = s.replaceAll("[^0-9Xx]", "");
        if (d.length() == 10 || d.length() == 13) return d.toUpperCase(Locale.ROOT);
        return null;
    }

    private static String normalizeIsbn(String s) {
        String d = digits(s);
        return d != null ? d : trimToNull(s);
    }

    private static String normalizeCover(String url) {
        String u = trimToNull(url);
        if (u == null) return null;
        if (u.startsWith("//")) u = "https:" + u;
        // 豆瓣封面常见小图转较大图
        u = u.replace("/s/public/", "/l/public/");
        u = u.replace("/spic/", "/lpic/");
        u = u.replace("/mpic/", "/lpic/");
        return u;
    }

    private static String rootMessage(Throwable e) {
        if (e == null) return "未知错误";
        Throwable t = e;
        while (t.getCause() != null && t.getCause() != t) t = t.getCause();
        String msg = t.getMessage();
        return (msg == null || msg.isBlank()) ? e.getClass().getSimpleName() : msg;
    }

    private static class SubjectRef {
        final String subjectId;
        final String title;
        final String pic;
        final String authorName;
        final String year;

        SubjectRef(String subjectId, String title, String pic, String authorName) {
            this(subjectId, title, pic, authorName, null);
        }

        SubjectRef(String subjectId, String title, String pic, String authorName, String year) {
            this.subjectId = subjectId;
            this.title = title;
            this.pic = pic;
            this.authorName = authorName;
            this.year = year;
        }

        String subjectUrl() {
            return "https://book.douban.com/subject/" + subjectId + "/";
        }
    }
}
