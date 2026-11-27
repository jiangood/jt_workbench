package com.jt.workbench.modules.zsxq.client;

import org.springframework.web.util.HtmlUtils;

import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 知识星球正文（{@code talk.text}）转 HTML。
 *
 * <p>{@code talk.text} 本身不是 HTML：换行是普通 {@code \n}，链接/书籍/话题等用自定义
 * {@code <e ...>} 标记，属性值通常做过 URL 编码。专栏里的普通长贴只有这份正文，没有
 * {@code article} 元数据，因此回填正文时需要把标记还原成普通链接，并转义其余文本，
 * 输出可直接交给前端 DOMPurify 清洗的 HTML。</p>
 *
 * <p>规则与前端 {@code web/src/pages/zsxq/richText.js} 保持一致：优先取 title/name/text/value
 * 作为链接文字，只允许 http(s) 链接；没有安全链接时只保留文字，避免把标签源码露出来。</p>
 */
public final class ZsxqRichText {

    private static final Pattern RICH_TAG = Pattern.compile(
            "<e\\b([^>]*?)(?:/\\s*>|>([\\s\\S]*?)</e\\s*>)",
            Pattern.CASE_INSENSITIVE);
    private static final Pattern ATTRIBUTE = Pattern.compile(
            "([^\\s=/>]+)(?:\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s\"'=<>`]+)))?");
    private static final Pattern ENTITY = Pattern.compile(
            "&(#x[0-9a-f]+|#\\d+|[a-z][a-z0-9]+);",
            Pattern.CASE_INSENSITIVE);

    private static final Map<String, String> NAMED_ENTITIES = Map.of(
            "amp", "&",
            "lt", "<",
            "gt", ">",
            "quot", "\"",
            "apos", "'",
            "nbsp", " "
    );

    private ZsxqRichText() {
    }

    /** 把星球正文转成 HTML（转义文本 + 还原 {@code <e>} 链接 + 换行转 {@code <br/>}）。 */
    public static String toHtml(String raw) {
        if (raw == null || raw.isEmpty()) return "";
        StringBuilder out = new StringBuilder(raw.length() + 64);
        Matcher matcher = RICH_TAG.matcher(raw);
        int cursor = 0;
        while (matcher.find()) {
            appendEscaped(out, raw.substring(cursor, matcher.start()));
            out.append(tokenHtml(matcher.group(1), matcher.group(2)));
            cursor = matcher.end();
        }
        appendUnfinished(out, raw.substring(cursor));
        return out.toString()
                .replace("\r\n", "\n")
                .replace('\r', '\n')
                .replace("\n", "<br/>");
    }

    /** 正文里的图片统一用官方图床地址，前端会改走站内代理并懒加载。 */
    public static String imageHtml(String url) {
        String src = url == null ? "" : url.trim();
        if (!src.startsWith("https://images.zsxq.com/")) return "";
        return "<p><img src=\"" + escape(src) + "\" loading=\"lazy\" referrerpolicy=\"no-referrer\"/></p>";
    }

    /** 处理摘要截断或旧数据里未闭合的 {@code <e ...>}，尽量还原标题；不露出标签源码。 */
    private static void appendUnfinished(StringBuilder out, String rest) {
        if (rest.isEmpty()) return;
        int start = indexOfUnfinishedTag(rest);
        if (start < 0) {
            appendEscaped(out, rest);
            return;
        }
        appendEscaped(out, rest.substring(0, start));
        String tail = rest.substring(start);
        int close = tail.indexOf('>');
        String attrs = close < 0 ? tail.substring(2) : tail.substring(2, close);
        String inner = close < 0 ? "" : tail.substring(close + 1);
        out.append(tokenHtml(attrs, inner));
    }

    private static int indexOfUnfinishedTag(String text) {
        String lower = text.toLowerCase(Locale.ROOT);
        int index = lower.lastIndexOf("<e");
        while (index >= 0) {
            int after = index + 2;
            if (after >= text.length() || !Character.isLetterOrDigit(text.charAt(after))) return index;
            index = lower.lastIndexOf("<e", index - 1);
        }
        return -1;
    }

    private static String tokenHtml(String attrSource, String inner) {
        Map<String, String> attrs = parseAttributes(attrSource);
        String title = decodeAttribute(firstNonBlank(
                attrs.get("title"), attrs.get("name"), attrs.get("text"), attrs.get("value")));
        String body = decodeEntities(inner == null ? "" : inner).trim();
        String label = title.isBlank() ? body : title;
        String href = safeExternalUrl(decodeAttribute(firstNonBlank(attrs.get("href"), attrs.get("url"))));

        if (!href.isEmpty()) {
            String text = label.isBlank() ? href : label;
            return "<a href=\"" + escape(href) + "\" target=\"_blank\" rel=\"noreferrer noopener\">"
                    + escape(text) + "</a>";
        }
        return label.isBlank() ? "" : escape(label);
    }

    private static Map<String, String> parseAttributes(String source) {
        Map<String, String> attrs = new HashMap<>();
        Matcher matcher = ATTRIBUTE.matcher(source == null ? "" : source);
        while (matcher.find()) {
            String name = matcher.group(1).toLowerCase(Locale.ROOT);
            String value = matcher.group(2) != null ? matcher.group(2)
                    : matcher.group(3) != null ? matcher.group(3) : matcher.group(4);
            attrs.putIfAbsent(name, value == null ? "" : value);
        }
        return attrs;
    }

    private static String firstNonBlank(String... values) {
        for (String value : values) {
            if (value != null && !value.isBlank()) return value;
        }
        return "";
    }

    /** 解码 title/href 等属性：先解 URL 编码，再兼容 HTML 实体转义。 */
    private static String decodeAttribute(String value) {
        if (value == null || value.isEmpty()) return "";
        try {
            // 星球用 encodeURIComponent：空格是 %20，+ 就是字面量；URLDecoder 会把 + 当空格，先保护起来
            return decodeEntities(URLDecoder.decode(value.replace("+", "%2B"), StandardCharsets.UTF_8));
        } catch (IllegalArgumentException e) {
            // 坏百分号编码不能影响整篇正文，保留实体解码后的原文
            return decodeEntities(value);
        }
    }

    private static String decodeEntities(String value) {
        Matcher matcher = ENTITY.matcher(value == null ? "" : value);
        StringBuilder out = new StringBuilder();
        while (matcher.find()) {
            String entity = matcher.group(1);
            String replacement = replaceEntity(entity);
            matcher.appendReplacement(out, Matcher.quoteReplacement(replacement));
        }
        matcher.appendTail(out);
        return out.toString();
    }

    private static String replaceEntity(String entity) {
        if (entity.isEmpty() || entity.charAt(0) != '#') {
            String named = NAMED_ENTITIES.get(entity.toLowerCase(Locale.ROOT));
            return named == null ? "&" + entity + ";" : named;
        }
        boolean hex = entity.length() > 1
                && (entity.charAt(1) == 'x' || entity.charAt(1) == 'X');
        try {
            int code = Integer.parseInt(entity.substring(hex ? 2 : 1), hex ? 16 : 10);
            if (code < 0 || code > Character.MAX_CODE_POINT) return "&" + entity + ";";
            return new String(Character.toChars(code));
        } catch (NumberFormatException e) {
            return "&" + entity + ";";
        }
    }

    /** 富文本链接只允许 http(s)，拒绝 javascript:/data: 等危险协议。 */
    private static String safeExternalUrl(String value) {
        String url = value == null ? "" : value.trim();
        if (url.regionMatches(true, 0, "http://", 0, 7)
                || url.regionMatches(true, 0, "https://", 0, 8)) return url;
        if (url.startsWith("//")) return "https:" + url;
        return "";
    }

    private static void appendEscaped(StringBuilder out, String text) {
        if (text != null && !text.isEmpty()) out.append(escape(text));
    }

    private static String escape(String text) {
        return HtmlUtils.htmlEscape(text == null ? "" : text, StandardCharsets.UTF_8.name());
    }
}
