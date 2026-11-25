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

    private ZsxqModels() {
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
    }

    public static class Statistics {
        public Integer topicsCount;
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
    }

    // ---------- resp_data 外壳 ----------

    public static class GroupPage {
        public List<Group> groups;
    }

    public static class TopicPage {
        public List<Topic> topics;
    }

    public static class CommentPage {
        public List<Comment> comments;
    }

    public static class ColumnPage {
        public List<Column> columns;
    }

    public static class TopicDetail {
        public Topic topic;
    }
}
