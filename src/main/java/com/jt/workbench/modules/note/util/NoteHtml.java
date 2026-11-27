package com.jt.workbench.modules.note.util;

import org.springframework.web.util.HtmlUtils;

import java.util.regex.Pattern;

/**
 * 笔记富文本与纯文本之间的转换。
 *
 * <p>笔记的编辑入口是富文本编辑器，但列表预览与关键字搜索仍使用纯文本字段，
 * 因此保存时从 HTML 派生纯文本。这里只做展示级的粗提取，不承担 HTML 清洗，
 * 展示端仍会经过 DOMPurify。</p>
 */
public final class NoteHtml {

    /** 纯文本正文的保存上限（TEXT 列足够放常见文章，超长部分不参与搜索） */
    public static final int PLAIN_TEXT_MAX_LENGTH = 20000;

    private static final Pattern SCRIPT_STYLE = Pattern.compile(
            "(?is)<(script|style)\\b[^>]*>.*?</\\1\\s*>");
    private static final Pattern TAG = Pattern.compile("(?s)<[^>]*>");
    private static final Pattern BLOCK_BREAK = Pattern.compile(
            "(?i)<\\s*(br|/p|/div|/li|/h[1-6]|/tr|/blockquote|/pre)\\b[^>]*>");
    private static final Pattern SPACES = Pattern.compile("[\\t\\x0B\\f\\r ]+");

    private NoteHtml() {
    }

    /** HTML -> 单段纯文本（保留换行的语义，方便列表预览截断） */
    public static String toPlainText(String html) {
        if (html == null || html.isBlank()) return "";
        String text = SCRIPT_STYLE.matcher(html).replaceAll(" ");
        text = BLOCK_BREAK.matcher(text).replaceAll("\n");
        text = TAG.matcher(text).replaceAll(" ");
        text = HtmlUtils.htmlUnescape(text);
        text = SPACES.matcher(text).replaceAll(" ");
        text = text.replaceAll(" *\\n *", "\n").replaceAll("\\n+", "\n").trim();
        if (text.length() > PLAIN_TEXT_MAX_LENGTH) {
            text = text.substring(0, PLAIN_TEXT_MAX_LENGTH);
        }
        return text;
    }

    /** 纯文本 -> 简单 HTML（兼容没有富文本正文的历史笔记） */
    public static String plainTextToHtml(String plain) {
        if (plain == null || plain.isEmpty()) return "";
        String[] lines = plain.replace("\r\n", "\n").replace('\r', '\n').split("\n", -1);
        StringBuilder out = new StringBuilder(plain.length() + 32);
        for (String line : lines) {
            out.append("<p>");
            if (line.isEmpty()) {
                out.append("<br/>");
            } else {
                out.append(HtmlUtils.htmlEscape(line));
            }
            out.append("</p>");
        }
        return out.toString();
    }
}
