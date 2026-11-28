package com.jt.workbench.modules.job.service;

import io.github.jiangood.openadmin.modules.job.JobResult;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.slf4j.Logger;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.Node;
import org.w3c.dom.NodeList;
import org.xml.sax.InputSource;

import javax.xml.parsers.DocumentBuilderFactory;
import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;

/**
 * RSS/Atom 抓取与去重入库。
 *
 * <p>流程与旧脚本一致：按源拉取 → 写入本地 rss_item 暂存表 → 同标题（title_hash）
 * 只保留正文最长的一条 → 写入 news_item（按 source_id+external_id 幂等）→ 清理 7 天前暂存。</p>
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class RssFetchService {

    private static final int MAX_FEED_BYTES = 5 * 1024 * 1024;
    private static final int MAX_ITEMS_PER_SOURCE = 100;
    private static final int MAX_ITEMS_TOTAL = 10_000;
    private static final int CONTENT_MAX = 200_000;
    private static final long RETENTION_MS = 7L * 24 * 60 * 60 * 1000;

    private static final DateTimeFormatter RFC1123 = DateTimeFormatter.RFC_1123_DATE_TIME;
    /** 墙钟统一北京时区：news_item.pub_time / create_time 均按 Asia/Shanghai 墙钟读写 */
    private static final ZoneId ZONE_SHANGHAI = ZoneId.of("Asia/Shanghai");

    private final JdbcTemplate jdbc;

    private record FeedItem(String externalId, String title, String titleHash, String link,
                            String author, Long publishedAt, String contentHtml, int contentLen) {}

    /** 抓取全部启用数据源，返回执行摘要（异常由 Quartz 记为失败）。 */
    public JobResult fetchAll(Logger logger, java.util.function.Consumer<String> progress) {
        List<java.util.Map<String, Object>> sources = jdbc.queryForList(
                "SELECT id, url, name FROM news_source WHERE enabled = 1 ORDER BY name, id");
        if (sources.isEmpty()) return JobResult.skip("没有启用的 RSS 数据源");

        ensureSchema();

        HttpClient client = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(15))
                .followRedirects(HttpClient.Redirect.NORMAL)
                .build();

        long now = System.currentTimeMillis();
        int succeeded = 0, inserted = 0, skipped = 0, deduped = 0, fetchedNew = 0;
        List<String> errors = new ArrayList<>();

        for (int s = 0; s < sources.size() && fetchedNew < MAX_ITEMS_TOTAL; s++) {
            String sourceId = String.valueOf(sources.get(s).get("ID"));
            String url = String.valueOf(sources.get(s).get("URL"));
            progress.accept("抓取 " + (s + 1) + "/" + sources.size());
            try {
                String xml = fetch(client, url);
                List<FeedItem> items = parseFeed(xml);
                if (items.size() > MAX_ITEMS_PER_SOURCE) items = items.subList(0, MAX_ITEMS_PER_SOURCE);
                for (FeedItem item : items) {
                    if (fetchedNew >= MAX_ITEMS_TOTAL) break;
                    Integer exists = jdbc.queryForObject(
                            "SELECT COUNT(*) FROM rss_item WHERE source_id = ? AND external_id = ?",
                            Integer.class, sourceId, item.externalId());
                    if (exists != null && exists > 0) { skipped++; continue; }
                    jdbc.update(
                            "INSERT INTO rss_item (source_id, external_id, title, title_hash, link, author, published_at, content_html, content_len, fetched_at, reported) " +
                            "SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0 WHERE NOT EXISTS " +
                            "(SELECT 1 FROM rss_item WHERE source_id = ? AND external_id = ?)",
                            sourceId, item.externalId(), item.title(), item.titleHash(), item.link(), item.author(),
                            item.publishedAt(), item.contentHtml(), item.contentLen(), now, sourceId, item.externalId());
                    inserted++;
                    fetchedNew++;
                }
                succeeded++;
            } catch (Exception e) {
                String message = e instanceof java.net.ConnectException ? "连接失败" : e.getMessage();
                errors.add(sourceId + ": " + message);
                logger.warn("RSS 抓取失败 sourceId={} url={} error={}", sourceId, url, message);
            }
        }

        // 与本地历史比对：同标题只取正文最长的未上报条目
        List<java.util.Map<String, Object>> candidates = jdbc.queryForList(
                "SELECT source_id, external_id, title, link, author, published_at, content_html " +
                "FROM rss_item WHERE reported = 0 ORDER BY fetched_at ASC");
        List<java.util.Map<String, Object>> bestRows = jdbc.queryForList(
                "SELECT source_id, external_id, title_hash FROM rss_item WHERE title_hash IN " +
                "(SELECT DISTINCT title_hash FROM rss_item WHERE reported = 0) " +
                "ORDER BY content_len DESC, fetched_at DESC");

        java.util.Map<String, java.util.Map<String, Object>> bestByHash = new java.util.HashMap<>();
        for (java.util.Map<String, Object> row : bestRows) {
            bestByHash.putIfAbsent(String.valueOf(row.get("TITLE_HASH")), row);
        }

        int reported = 0;
        for (java.util.Map<String, Object> row : candidates) {
            String sourceId = String.valueOf(row.get("SOURCE_ID"));
            String externalId = String.valueOf(row.get("EXTERNAL_ID"));
            // rss_item 没有 title_hash 列被 SELECT 出来时补查（兼容上面 SELECT 的列集合）
            String hash = jdbc.queryForObject(
                    "SELECT title_hash FROM rss_item WHERE source_id = ? AND external_id = ?",
                    String.class, sourceId, externalId);
            java.util.Map<String, Object> best = hash == null ? null : bestByHash.get(hash);
            boolean isBest = best != null && sourceId.equals(String.valueOf(best.get("SOURCE_ID")))
                    && externalId.equals(String.valueOf(best.get("EXTERNAL_ID")));

            if (!isBest) {
                jdbc.update("UPDATE rss_item SET reported = 2 WHERE source_id = ? AND external_id = ?", sourceId, externalId);
                deduped++;
                continue;
            }

            insertNews(row, now);
            jdbc.update("UPDATE rss_item SET reported = 1 WHERE source_id = ? AND external_id = ?", sourceId, externalId);
            reported++;
        }

        int pruned = jdbc.update("DELETE FROM rss_item WHERE fetched_at < ?", now - RETENTION_MS);

        if (succeeded == 0) {
            throw new IllegalStateException("全部 RSS 数据源抓取失败：" + String.join("; ", errors.subList(0, Math.min(3, errors.size()))));
        }
        String summary = "成功 " + succeeded + "/" + sources.size() + " 个数据源"
                + "，新入暂存 " + inserted + " 条"
                + (reported > 0 ? "，入库 " + reported + " 条" : "")
                + (deduped > 0 ? "，标题去重 " + deduped + " 条" : "")
                + (skipped > 0 ? "，跳过已采集 " + skipped + " 条" : "")
                + (pruned > 0 ? "，清理过期 " + pruned + " 条" : "");
        if (errors.isEmpty()) {
            return JobResult.ok(summary);
        }
        return JobResult.partial(summary + "；失败 " + errors.size() + " 个："
                + String.join("; ", errors.subList(0, Math.min(3, errors.size()))));
    }

    // ---------- 抓取与解析 ----------

    private String fetch(HttpClient client, String url) throws Exception {
        HttpRequest request = HttpRequest.newBuilder(URI.create(url))
                .timeout(Duration.ofSeconds(25))
                .header("accept", "application/rss+xml, application/atom+xml, application/xml, text/xml, */*")
                .header("user-agent", "jt-workbench-agent/1.0")
                .GET().build();
        HttpResponse<InputStream> response = client.send(request, HttpResponse.BodyHandlers.ofInputStream());
        if (response.statusCode() >= 400) throw new IllegalStateException("HTTP " + response.statusCode());
        try (InputStream in = response.body()) {
            byte[] bytes = readBounded(in, MAX_FEED_BYTES);
            return new String(bytes, StandardCharsets.UTF_8);
        }
    }

    private static byte[] readBounded(InputStream in, int max) throws Exception {
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int total = 0;
        int n;
        while ((n = in.read(buf)) != -1) {
            total += n;
            if (total > max) throw new IllegalStateException("feed exceeds 5 MiB");
            out.write(buf, 0, n);
        }
        return out.toByteArray();
    }

    private List<FeedItem> parseFeed(String xml) throws Exception {
        DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
        factory.setNamespaceAware(true);
        factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
        factory.setFeature("http://xml.org/sax/features/external-general-entities", false);
        factory.setFeature("http://xml.org/sax/features/external-parameter-entities", false);
        factory.setFeature("http://apache.org/xml/features/nonvalidating/load-external-dtd", false);
        factory.setXIncludeAware(false);
        factory.setExpandEntityReferences(false);
        Document doc = factory.newDocumentBuilder().parse(new InputSource(new ByteArrayInputStream(xml.getBytes(StandardCharsets.UTF_8))));
        Element root = doc.getDocumentElement();

        String atom = localName(root);
        NodeList nodes = "feed".equals(atom)
                ? root.getElementsByTagNameNS("*", "entry")
                : root.getElementsByTagNameNS("*", "item");
        List<FeedItem> out = new ArrayList<>();
        for (int i = 0; i < nodes.getLength(); i++) {
            Element el = (Element) nodes.item(i);
            String title = nullToEmpty(firstText(el, "title", "title"));
            String link = firstLink(el);
            String guid = firstText(el, "guid", "id");
            if (isBlank(guid)) guid = link;
            if (isBlank(guid)) guid = title + "|" + nullToEmpty(firstText(el, "pubDate", "published", "updated", "date"));
            String externalId = isBlank(guid) ? sha256("anon|" + title) : guid.trim();
            if (externalId.length() > 1000) externalId = externalId.substring(0, 1000);

            String raw = firstText(el, "encoded", "content", "description", "summary");
            String content = raw == null ? null : (raw.length() <= CONTENT_MAX ? raw : raw.substring(0, CONTENT_MAX));
            String author = firstText(el, "creator", "author");
            Long published = parseTime(firstText(el, "pubDate", "published", "updated", "date"));
            out.add(new FeedItem(externalId, title, titleHash(title, externalId), link,
                    blankToNull(author), published, content, plainLength(content)));
        }
        return out;
    }

    private static String localName(Node node) {
        String name = node.getLocalName();
        return name == null ? node.getNodeName() : name;
    }

    private static String firstText(Element parent, String... names) {
        for (String name : names) {
            NodeList nl = parent.getElementsByTagNameNS("*", name);
            if (nl.getLength() > 0) {
                String text = nl.item(0).getTextContent();
                if (text != null && !text.isBlank()) return text.trim();
            }
        }
        return null;
    }

    private static String firstLink(Element parent) {
        NodeList nl = parent.getElementsByTagNameNS("*", "link");
        for (int i = 0; i < nl.getLength(); i++) {
            Element link = (Element) nl.item(i);
            String href = link.getAttribute("href");
            String rel = link.getAttribute("rel");
            if (!href.isBlank() && (rel.isBlank() || "alternate".equals(rel))) return href.trim();
        }
        if (nl.getLength() > 0) {
            String text = nl.item(0).getTextContent();
            if (text != null && !text.isBlank()) return text.trim();
        }
        return null;
    }

    private static Long parseTime(String value) {
        if (isBlank(value)) return null;
        try { return Instant.parse(value.trim()).toEpochMilli(); } catch (Exception ignored) {}
        try { return OffsetDateTime.parse(value.trim()).toInstant().toEpochMilli(); } catch (Exception ignored) {}
        try { return java.time.ZonedDateTime.parse(value.trim()).toInstant().toEpochMilli(); } catch (Exception ignored) {}
        try { return java.time.LocalDateTime.parse(value.trim()).atZone(ZoneOffset.ofHours(8)).toInstant().toEpochMilli(); } catch (Exception ignored) {}
        try {
            return java.time.ZonedDateTime.parse(value.trim(), RFC1123).toInstant().toEpochMilli();
        } catch (Exception ignored) {}
        try {
            return new java.text.SimpleDateFormat("EEE, dd MMM yyyy HH:mm:ss Z", Locale.US)
                    .parse(value.trim()).getTime();
        } catch (Exception ignored) {}
        return null;
    }

    private static String normalizeTitle(String title) {
        return title.trim().toLowerCase(Locale.ROOT).replaceAll("\\s+", " ");
    }

    private static String titleHash(String title, String externalId) {
        return sha256(isBlank(title) ? "__no_title__:" + externalId : normalizeTitle(title));
    }

    private static int plainLength(String html) {
        if (html == null) return 0;
        return html.replaceAll("<[^>]*>", " ").replaceAll("\\s+", " ").trim().length();
    }

    private static String sha256(String input) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(input.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder(digest.length * 2);
            for (byte b : digest) sb.append(String.format("%02x", b));
            return sb.toString();
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    // ---------- 本地库 ----------

    private void ensureSchema() {
        jdbc.execute("CREATE TABLE IF NOT EXISTS rss_item ("
                + "source_id VARCHAR(200) NOT NULL, external_id VARCHAR(1000) NOT NULL, "
                + "title VARCHAR(1000), title_hash VARCHAR(64) NOT NULL, link VARCHAR(1000), "
                + "author VARCHAR(500), published_at BIGINT, content_html CLOB, "
                + "content_len INT NOT NULL DEFAULT 0, fetched_at BIGINT NOT NULL, "
                + "reported INT NOT NULL DEFAULT 0, PRIMARY KEY (source_id, external_id))");
        jdbc.execute("CREATE INDEX IF NOT EXISTS idx_rss_item_title_hash ON rss_item (title_hash)");
        jdbc.execute("CREATE INDEX IF NOT EXISTS idx_rss_item_reported ON rss_item (reported, title_hash)");
    }

    private void insertNews(java.util.Map<String, Object> row, long now) {
        String sourceId = String.valueOf(row.get("SOURCE_ID"));
        String externalId = String.valueOf(row.get("EXTERNAL_ID"));
        String title = row.get("TITLE") == null ? null : String.valueOf(row.get("TITLE"));
        String content = row.get("CONTENT_HTML") == null ? null : String.valueOf(row.get("CONTENT_HTML"));
        String author = row.get("AUTHOR") == null ? null : String.valueOf(row.get("AUTHOR"));
        Object pub = row.get("PUBLISHED_AT");
        long publishedAt = pub == null ? now : ((Number) pub).longValue();
        if (publishedAt <= 0 || publishedAt > now) publishedAt = now;
        String id = UUID.randomUUID().toString().replace("-", "");

        jdbc.update(
                "INSERT INTO news_item (id, title, content, author, source_id, external_id, status, pub_time, create_time, top) "
                        + "SELECT ?, ?, ?, ?, ?, ?, 'unread', ?, ?, FALSE "
                        + "WHERE NOT EXISTS (SELECT 1 FROM news_item WHERE source_id = ? AND external_id = ?)",
                id, title, content, author, sourceId, externalId,
                // pub_time 列为 TIMESTAMP(6) WITH TIME ZONE：绑定北京墙钟，按会话时区(+08)解释后即为正确时刻
                LocalDateTime.ofInstant(Instant.ofEpochMilli(publishedAt), ZONE_SHANGHAI),
                LocalDateTime.now(ZONE_SHANGHAI),
                sourceId, externalId);
    }

    private static boolean isBlank(String value) { return value == null || value.isBlank(); }
    private static String nullToEmpty(String value) { return value == null ? "" : value; }
    private static String blankToNull(String value) { return isBlank(value) ? null : value; }
}
