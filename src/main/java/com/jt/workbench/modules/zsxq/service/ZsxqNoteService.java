package com.jt.workbench.modules.zsxq.service;

import com.jt.workbench.modules.note.entity.Note;
import com.jt.workbench.modules.note.repo.NoteRepository;
import com.jt.workbench.modules.note.service.NoteService;
import com.jt.workbench.modules.note.util.NoteHtml;
import com.jt.workbench.modules.zsxq.client.ZsxqRichText;
import com.jt.workbench.modules.zsxq.entity.ZsxqFile;
import com.jt.workbench.modules.zsxq.entity.ZsxqTopic;
import io.github.jiangood.openadmin.modules.system.entity.SysFile;
import io.github.jiangood.openadmin.modules.system.service.SysFileService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.web.util.HtmlUtils;

import java.io.InputStream;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 知识星球话题转个人笔记。
 *
 * <p>正文沿用星球同步好的 HTML（专栏文章）或把普通帖子正文转成 HTML；正文图片与话题附件
 * 会复制到框架文件库，笔记因此不再依赖知识星球接口。转换失败的单张图片/附件不影响整体，
 * 附件会以「原始附件」链接兜底。</p>
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class ZsxqNoteService {

    private static final Pattern IMG_SRC = Pattern.compile(
            "(?is)(<img\\b[^>]*?\\bsrc\\s*=\\s*)([\"'])(.*?)\\2");

    private static final int TITLE_MAX_LENGTH = 200;

    private final NoteRepository noteRepository;
    private final NoteService noteService;
    private final ZsxqImageService imageService;
    private final ZsxqFileService fileService;
    private final SysFileService sysFileService;

    /**
     * 将话题转为笔记；同一话题重复转换时直接返回已有笔记。
     *
     * @param titleOverride    用户可改的标题，为空时按文章标题/正文首行生成
     * @param folderId         笔记目录，可为空（未分类）
     * @param sourceUrlOverride 用户可改的原文链接，为空时按专栏地址/话题详情自动生成
     */
    public Note convert(ZsxqTopic topic, String titleOverride, String folderId, String sourceUrlOverride) {
        String topicId = topic.getTopicId() == null ? "" : topic.getTopicId().trim();
        String sourceUrl = blankToNull(sourceUrlOverride);
        if (sourceUrl == null) sourceUrl = sourceUrl(topic);

        if (!topicId.isEmpty()) {
            Note existing = noteRepository.findFirstBySourceTopicId(topicId).orElse(null);
            if (existing != null) {
                // 历史转换的笔记可能还没有原文链接，重复转换时顺手补上
                noteService.backfillSourceUrl(existing.getId(), sourceUrl);
                return existing;
            }
        }

        List<String> importedAttachments = new ArrayList<>();
        List<ZsxqFile> failedAttachments = new ArrayList<>();
        String html = buildContentHtml(topic, failedAttachments);
        importAttachments(topic, importedAttachments, failedAttachments);
        html = appendFailedAttachments(html, topicId, failedAttachments);

        Note note = new Note();
        note.setTitle(resolveTitle(topic, titleOverride));
        note.setContentHtml(html);
        note.setAttachments(importedAttachments.isEmpty() ? null : String.join(",", importedAttachments));
        note.setFolderId(blankToNull(folderId));
        note.setSourceType("zsxq");
        note.setSourceTopicId(topicId.isEmpty() ? null : topicId);
        note.setSourceUrl(sourceUrl);
        return noteService.create(note);
    }

    // ---------- 正文 ----------

    private String buildContentHtml(ZsxqTopic topic, List<ZsxqFile> failedAttachments) {
        String article = topic.getArticleContent();
        if (article != null && !article.isBlank()) {
            return rewriteOfficialImages(article);
        }

        StringBuilder html = new StringBuilder(ZsxqRichText.toHtml(topic.getDigest()));
        List<String> keys = imageService.parseKeys(topic.getImages());
        if (keys.isEmpty()) {
            String cover = blankToNull(topic.getCover());
            if (cover != null) keys = List.of(cover);
        }
        for (String key : keys) {
            html.append(importImage(key));
        }
        return html.toString();
    }

    /** 把专栏正文里的星球官方图片落到框架文件库，替换成站内 /file/ 地址 */
    private String rewriteOfficialImages(String html) {
        Matcher matcher = IMG_SRC.matcher(html);
        StringBuilder out = new StringBuilder(html.length() + 64);
        while (matcher.find()) {
            String src = HtmlUtils.htmlUnescape(matcher.group(3)).trim();
            String replacement = src;
            if (src.contains("images.zsxq.com/")) {
                String stored = importImageUrl(src);
                String fallback = fallbackImageUrl(src);
                if (stored != null) replacement = stored;
                else if (fallback != null) replacement = fallback;
            }
            matcher.appendReplacement(out, Matcher.quoteReplacement(
                    matcher.group(1) + "\"" + replacement + "\""));
        }
        matcher.appendTail(out);
        return out.toString();
    }

    /** 正文图片：优先复制到框架文件库；失败时退回站内代理，保证仍可查看 */
    private String importImage(String keyOrUrl) {
        String value = blankToNull(keyOrUrl);
        if (value == null) return "";
        String stored = value.startsWith("http://") || value.startsWith("https://")
                ? importImageUrl(value) : importImageKey(value);
        String src = stored != null ? stored : fallbackImageUrl(value);
        return src == null ? "" : "<p><img src=\"" + HtmlUtils.htmlEscape(src) + "\" loading=\"lazy\"/></p>";
    }

    private String importImageUrl(String url) {
        try {
            String normalized = url.startsWith("//") ? "https:" + url : url;
            String zsxqKey = imageService.storeUrl(normalized);
            if (zsxqKey == null) return null;
            return importImageKey(zsxqKey);
        } catch (Exception e) {
            log.warn("知识星球图片转笔记失败 url={} error={}", url, e.getMessage());
            return null;
        }
    }

    private String importImageKey(String zsxqKey) {
        try {
            byte[] bytes = imageService.read(zsxqKey);
            String name = "zsxq-" + baseName(zsxqKey);
            SysFile file = sysFileService.uploadFile(bytes, name, false);
            return "/file/" + file.getObjectName();
        } catch (Exception e) {
            log.warn("知识星球图片写入文件库失败 key={} error={}", zsxqKey, e.getMessage());
            return null;
        }
    }

    private static String fallbackImageUrl(String value) {
        String normalized = value.startsWith("//") ? "https:" + value : value;
        if (normalized.startsWith("http://") || normalized.startsWith("https://")) {
            return "/admin/zsxq/image?u=" + URLEncoder.encode(normalized, StandardCharsets.UTF_8);
        }
        if (normalized.startsWith(ZsxqImageService.KEY_PREFIX)) {
            return "/admin/zsxq/image?key=" + URLEncoder.encode(normalized, StandardCharsets.UTF_8);
        }
        return null;
    }

    // ---------- 附件 ----------

    private void importAttachments(ZsxqTopic topic, List<String> imported, List<ZsxqFile> failed) {
        String topicId = blankToNull(topic.getTopicId());
        if (topicId == null) return;
        List<ZsxqFile> files = fileService.byTopicIds(List.of(topicId)).get(topicId);
        if (files == null) return;

        Set<String> seen = new LinkedHashSet<>();
        for (ZsxqFile file : files) {
            if (!seen.add(file.getFileId())) continue;
            try {
                ZsxqFile stored = fileService.ensureStored(file);
                long size = stored.getFileSize() == null ? 0 : stored.getFileSize();
                String name = fileService.fileName(stored);
                try (InputStream in = fileService.open(stored)) {
                    SysFile importedFile = sysFileService.uploadFile(in, name, size, false);
                    imported.add(importedFile.getObjectName());
                }
            } catch (Exception e) {
                log.warn("知识星球附件转笔记失败 topicId={} fileId={} error={}",
                        topicId, file.getFileId(), e.getMessage());
                failed.add(file);
            }
        }
    }

    /** 无法导入文件库的附件保留原始下载链接，避免信息丢失 */
    private static String appendFailedAttachments(String html, String topicId, List<ZsxqFile> failed) {
        if (failed.isEmpty() || topicId.isEmpty()) return html;
        StringBuilder out = new StringBuilder(html);
        out.append("<p><strong>其他附件（原始链接）</strong></p><ul>");
        for (ZsxqFile file : failed) {
            String name = file.getName() == null || file.getName().isBlank() ? file.getFileId() : file.getName();
            String href = "/admin/zsxq/file?topicId=" + URLEncoder.encode(topicId, StandardCharsets.UTF_8)
                    + "&fileId=" + URLEncoder.encode(String.valueOf(file.getFileId()), StandardCharsets.UTF_8);
            out.append("<li><a href=\"").append(HtmlUtils.htmlEscape(href)).append("\" target=\"_blank\" rel=\"noreferrer\">")
                    .append(HtmlUtils.htmlEscape(name)).append("</a></li>");
        }
        return out.append("</ul>").toString();
    }

    // ---------- 标题与来源 ----------

    private static String resolveTitle(ZsxqTopic topic, String titleOverride) {
        String title = blankToNull(titleOverride);
        if (title == null) title = blankToNull(topic.getArticleTitle());
        if (title == null) {
            String text = NoteHtml.toPlainText(ZsxqRichText.toHtml(topic.getDigest()));
            for (String line : text.split("\n")) {
                if (!line.isBlank()) {
                    title = line.trim();
                    break;
                }
            }
        }
        if (title == null) title = "知识星球笔记 " + LocalDate.now();
        return title.length() > TITLE_MAX_LENGTH ? title.substring(0, TITLE_MAX_LENGTH) : title;
    }

    private static String sourceUrl(ZsxqTopic topic) {
        String articleUrl = blankToNull(topic.getArticleUrl());
        if (articleUrl != null) return articleUrl;
        String topicId = blankToNull(topic.getTopicId());
        if (topicId == null) return null;
        return "https://wx.zsxq.com/dweb2/index/topic_detail/" + topicId;
    }

    private static String baseName(String key) {
        int slash = key.lastIndexOf('/');
        String name = slash < 0 ? key : key.substring(slash + 1);
        return name.isBlank() ? "image" : name;
    }

    private static String blankToNull(String value) {
        return value == null || value.isBlank() ? null : value.trim();
    }
}
