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
                    + ", likesCount=" + likesCount + ", commentsCount=" + commentsCount
                    + ", readingCount=" + readingCount + ", digested=" + digested + ", sticky=" + sticky
                    + ", talk=" + talk + "}";
        }
    }

    public static class TalkContent {
        public User owner;
        public String text;
        public List<Image> images;

        public User getOwner() {
            return owner;
        }

        public String getText() {
            return text;
        }

        public List<Image> getImages() {
            return images;
        }

        @Override
        public String toString() {
            return "TalkContent{owner=" + owner + ", images=" + (images == null ? 0 : images.size())
                    + ", text=" + brief(text) + "}";
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
