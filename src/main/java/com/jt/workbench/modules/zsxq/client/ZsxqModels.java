package com.jt.workbench.modules.zsxq.client;

import java.util.List;

/**
 * 知识星球只读接口的最小模型。
 *
 * <p>所有 ID 一律使用 {@link String}：知识星球的话题/评论 ID 是 17 位以上的整数，
 * 超过 JavaScript/双精度浮点的安全整数范围（2^53），任何经过 {@code Double} 的中转都会丢精度。
 * 这里直接按字符串接收，避免“列表里是 ...420、真实帖子是 ...422”的问题。</p>
 */
public final class ZsxqModels {

    /** 日志里的正文/描述最多保留的字符数，避免把整篇帖子打进任务日志。 */
    private static final int LOG_TEXT_LIMIT = 120;

    private ZsxqModels() {
    }

    /** 日志展示用短文本：压掉换行、截断过长正文，null 安全。 */
    private static String brief(String text) {
        if (text == null) return "null";
        String s = text.replace('\r', ' ').replace('\n', ' ').trim();
        return s.length() <= LOG_TEXT_LIMIT ? s : s.substring(0, LOG_TEXT_LIMIT) + "…";
    }

    public static class Group {
        public String groupId;
        public String name;
        public User owner;

        public String getGroupId() {
            return groupId;
        }

        public String getName() {
            return name;
        }

        public User getOwner() {
            return owner;
        }

        @Override
        public String toString() {
            return "Group{groupId=" + groupId + ", name=" + name + ", owner=" + owner + "}";
        }
    }

    public static class User {
        public String userId;
        public String name;

        public String getUserId() {
            return userId;
        }

        public String getName() {
            return name;
        }

        @Override
        public String toString() {
            return "User{userId=" + userId + ", name=" + name + "}";
        }
    }

    public static class Column {
        public String columnId;
        public String name;
        public String description;
        public String coverUrl;
        public Integer topicsCount;
        public Statistics statistics;

        public String getColumnId() {
            return columnId;
        }

        public String getName() {
            return name;
        }

        public String getDescription() {
            return description;
        }

        public String getCoverUrl() {
            return coverUrl;
        }

        /** 专栏话题数：新版接口放在 statistics.topics_count，兼容旧的顶层字段。 */
        public int topicsCount() {
            if (statistics != null && statistics.topicsCount != null) return statistics.topicsCount;
            return topicsCount == null ? 0 : topicsCount;
        }

        @Override
        public String toString() {
            return "Column{columnId=" + columnId + ", name=" + name
                    + ", topicsCount=" + topicsCount()
                    + ", description=" + brief(description)
                    + ", coverUrl=" + brief(coverUrl) + "}";
        }
    }

    public static class Statistics {
        public Integer topicsCount;

        @Override
        public String toString() {
            return "Statistics{topicsCount=" + topicsCount + "}";
        }
    }

    public static class Topic {
        public String topicId;
        public String topicUid;
        public String type;
        public String createTime;
        public String title;
        public String content;
        public User owner;
        public Article article;
        public TalkContent talk;
        public Integer likesCount;
        public Integer commentsCount;
        public Integer rewardsCount;
        public Integer readingCount;
        public Boolean digested;
        public Boolean sticky;

        public String getTopicId() {
            return topicId;
        }

        public String getTopicUid() {
            return topicUid;
        }

        public String getType() {
            return type;
        }

        public String getCreateTime() {
            return createTime;
        }

        /** 页面/长文章列表里的标题（普通话题通常为空）。 */
        public String getTitle() {
            return title;
        }

        /** 页面/长文章列表里的正文或摘要（普通话题通常为空）。 */
        public String getContent() {
            return content;
        }

        /** 部分接口把作者放在话题顶层（专栏文章列表）。 */
        public User getOwner() {
            return owner;
        }

        /** 部分接口把长文章信息放在话题顶层。 */
        public Article getArticle() {
            return article;
        }

        public TalkContent getTalk() {
            return talk;
        }

        public Integer getLikesCount() {
            return likesCount;
        }

        public Integer getCommentsCount() {
            return commentsCount;
        }

        public Integer getRewardsCount() {
            return rewardsCount;
        }

        public Integer getReadingCount() {
            return readingCount;
        }

        public Boolean getDigested() {
            return digested;
        }

        public Boolean getSticky() {
            return sticky;
        }

        @Override
        public String toString() {
            return "Topic{topicId=" + topicId + ", type=" + type + ", createTime=" + createTime
                    + ", title=" + brief(title)
                    + ", likesCount=" + likesCount + ", commentsCount=" + commentsCount
                    + ", readingCount=" + readingCount + ", digested=" + digested + ", sticky=" + sticky
                    + ", owner=" + owner + ", article=" + article + ", talk=" + talk + "}";
        }
    }

    public static class TalkContent {
        public User owner;
        public String text;
        public List<Image> images;
        /** 长文章：正文需另行获取，这里通常只有标题与原文链接。 */
        public Article article;

        public User getOwner() {
            return owner;
        }

        public String getText() {
            return text;
        }

        public List<Image> getImages() {
            return images;
        }

        public Article getArticle() {
            return article;
        }

        @Override
        public String toString() {
            return "TalkContent{owner=" + owner + ", images=" + (images == null ? 0 : images.size())
                    + ", article=" + article + ", text=" + brief(text) + "}";
        }
    }

    /** 知识星球长文章（article）元数据；正文在 articles.zsxq.com，需要登录后另行获取。 */
    public static class Article {
        public String articleId;
        public String title;
        public String articleUrl;
        /** 详情接口里长文的原文地址。 */
        public String inlineArticleUrl;
        public String summary;
        public String content;
        /** 部分详情接口把长文正文放在 article_content。 */
        public String articleContent;

        public String getArticleId() {
            return articleId;
        }

        public String getTitle() {
            return title;
        }

        public String getArticleUrl() {
            return articleUrl;
        }

        public String getInlineArticleUrl() {
            return inlineArticleUrl;
        }

        public String getSummary() {
            return summary;
        }

        public String getContent() {
            if (content != null && !content.isBlank()) return content;
            return articleContent;
        }

        /** 取可点击的原文地址：优先 article_url，其次 inline_article_url，并补全协议。 */
        public String url() {
            String url = safeUrl(articleUrl);
            return url.isEmpty() ? safeUrl(inlineArticleUrl) : url;
        }

        /** 完整正文页地址：优先 inline_article_url，其次 article_url。 */
        public String contentUrl() {
            String url = safeUrl(inlineArticleUrl);
            return url.isEmpty() ? safeUrl(articleUrl) : url;
        }

        private static String safeUrl(String value) {
            String url = value == null ? "" : value.trim();
            if (url.isEmpty()) return "";
            if (url.startsWith("//")) return "https:" + url;
            if (url.startsWith("articles.zsxq.com") || url.startsWith("file.zsxq.com")) return "https://" + url;
            return url;
        }

        @Override
        public String toString() {
            return "Article{articleId=" + articleId + ", title=" + brief(title)
                    + ", url=" + brief(url()) + "}";
        }
    }

    public static class Image {
        public String imageId;
        public String type;
        public ImageSize original;
        public ImageSize thumbnail;
        public ImageSize large;

        public String getImageId() {
            return imageId;
        }

        public String getType() {
            return type;
        }

        public ImageSize getOriginal() {
            return original;
        }

        public ImageSize getThumbnail() {
            return thumbnail;
        }

        public ImageSize getLarge() {
            return large;
        }

        /** 优先取原图，其次大图/缩略图；没有地址时返回空串。 */
        public String primaryUrl() {
            if (original != null && original.getUrl() != null && !original.getUrl().isBlank()) {
                return original.getUrl().trim();
            }
            if (large != null && large.getUrl() != null && !large.getUrl().isBlank()) {
                return large.getUrl().trim();
            }
            if (thumbnail != null && thumbnail.getUrl() != null && !thumbnail.getUrl().isBlank()) {
                return thumbnail.getUrl().trim();
            }
            return "";
        }

        @Override
        public String toString() {
            return "Image{imageId=" + imageId + ", type=" + type + ", original=" + original + "}";
        }
    }

    public static class ImageSize {
        public String url;
        public Integer width;
        public Integer height;

        public String getUrl() {
            return url;
        }

        public Integer getWidth() {
            return width;
        }

        public Integer getHeight() {
            return height;
        }

        @Override
        public String toString() {
            return "ImageSize{" + width + "x" + height + ", url=" + url + "}";
        }
    }

    public static class Comment {
        public String commentId;
        public User owner;
        public String text;
        public String createTime;
        public Integer likesCount;

        public String getCommentId() {
            return commentId;
        }

        public User getOwner() {
            return owner;
        }

        public String getText() {
            return text;
        }

        public String getCreateTime() {
            return createTime;
        }

        public Integer getLikesCount() {
            return likesCount;
        }

        @Override
        public String toString() {
            return "Comment{commentId=" + commentId + ", owner=" + owner + ", createTime=" + createTime
                    + ", likesCount=" + likesCount + ", text=" + brief(text) + "}";
        }
    }

    // ---------- resp_data 外壳 ----------

    public static class GroupPage {
        public List<Group> groups;

        @Override
        public String toString() {
            return "GroupPage{groups=" + (groups == null ? 0 : groups.size()) + "}";
        }
    }

    public static class TopicPage {
        public List<Topic> topics;

        @Override
        public String toString() {
            return "TopicPage{topics=" + (topics == null ? 0 : topics.size()) + "}";
        }
    }

    public static class CommentPage {
        public List<Comment> comments;

        @Override
        public String toString() {
            return "CommentPage{comments=" + (comments == null ? 0 : comments.size()) + "}";
        }
    }

    public static class ColumnPage {
        public List<Column> columns;

        @Override
        public String toString() {
            return "ColumnPage{columns=" + (columns == null ? 0 : columns.size()) + "}";
        }
    }

    public static class TopicDetail {
        public Topic topic;

        @Override
        public String toString() {
            return "TopicDetail{topic=" + topic + "}";
        }
    }
}
