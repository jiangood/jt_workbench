package com.jt.workbench.modules.zsxq.client;

import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.PropertyNamingStrategies;
import tools.jackson.databind.json.JsonMapper;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** 回归：17 位以上的星球 ID 必须按字符串精确解析，不能被 Double 四舍五入。 */
class ZsxqModelsTest {

    private final ObjectMapper mapper = JsonMapper.builder()
            .propertyNamingStrategy(PropertyNamingStrategies.SNAKE_CASE)
            .build();

    @Test
    void topicIdsAreParsedExactly() {
        String json = """
                {
                  "topics": [{
                    "topic_id": 22258421152844422,
                    "type": "talk",
                    "create_time": "2026-11-25T10:40:00.819+0800",
                    "comments_count": 10,
                    "likes_count": 3,
                    "talk": {
                      "text": "hello",
                      "owner": { "user_id": 88484111558422, "name": "tester" },
                      "images": [{
                        "image_id": 12345678901234567,
                        "original": { "url": "https://images.zsxq.com/x", "width": 1, "height": 2 }
                      }]
                    }
                  }]
                }
                """;

        ZsxqModels.TopicPage page = mapper.treeToValue(mapper.readTree(json), ZsxqModels.TopicPage.class);

        ZsxqModels.Topic topic = page.topics.get(0);
        assertEquals("22258421152844422", topic.getTopicId());
        assertEquals("88484111558422", topic.getTalk().getOwner().getUserId());
        assertEquals("12345678901234567", topic.getTalk().getImages().get(0).getImageId());
    }

    @Test
    void commentIdsAndColumnStatisticsAreParsedExactly() {
        String commentsJson = """
                {"comments":[{"comment_id":55521458448142420,"text":"hi",
                  "owner":{"user_id":88484111558422,"name":"u"}}]}
                """;
        ZsxqModels.CommentPage comments = mapper.treeToValue(mapper.readTree(commentsJson), ZsxqModels.CommentPage.class);
        assertEquals("55521458448142420", comments.comments.get(0).getCommentId());

        String columnsJson = """
                {"columns":[{"column_id":518414128484,"name":"c",
                  "statistics":{"topics_count":10}}]}
                """;
        ZsxqModels.ColumnPage columns = mapper.treeToValue(mapper.readTree(columnsJson), ZsxqModels.ColumnPage.class);
        ZsxqModels.Column column = columns.columns.get(0);
        assertEquals("518414128484", column.getColumnId());
        assertEquals(10, column.topicsCount());
    }

    /** 长文章（专栏文章）：article 可能在 talk 内，也可能在话题顶层。 */
    @Test
    void articleMetadataIsParsed() {
        String json = """
                {"topics":[
                  {"topic_id":111,"type":"talk","create_time":"2026-01-01T00:00:00.000+0800",
                   "talk":{"owner":{"user_id":88484111558422,"name":"作者A"},
                     "article":{"article_id":222,"title":"文章标题",
                       "article_url":"articles.zsxq.com/id_abc.html"}}},
                  {"topic_id":333,"type":"talk","create_time":"2026-01-02T00:00:00.000+0800",
                   "owner":{"user_id":88484111558423,"name":"作者B"},
                   "article":{"title":"顶层标题","inline_article_url":"//articles.zsxq.com/id_def.html"}}
                ]}
                """;

        ZsxqModels.TopicPage page = mapper.treeToValue(mapper.readTree(json), ZsxqModels.TopicPage.class);

        ZsxqModels.Article first = page.topics.get(0).getTalk().getArticle();
        assertEquals("文章标题", first.getTitle());
        assertEquals("https://articles.zsxq.com/id_abc.html", first.url());

        ZsxqModels.Topic second = page.topics.get(1);
        assertEquals("顶层标题", second.getArticle().getTitle());
        assertEquals("https://articles.zsxq.com/id_def.html", second.getArticle().url());
        assertEquals("作者B", second.getOwner().getName());
    }

    /** 附件元数据：file_id 同样必须按字符串精确解析。 */
    @Test
    void topicFilesAreParsed() {
        String json = """
                {"topics":[{"topic_id":22258421152844422,"type":"talk",
                  "talk":{"text":"附件","files":[
                    {"file_id":54825845551514422,"name":"研报.pdf","size":123456,"hash":"abc",
                     "create_time":"2026-11-25T10:40:00.819+0800","download_count":9}
                  ]}}]}
                """;
        ZsxqModels.Topic topic = mapper.treeToValue(mapper.readTree(json), ZsxqModels.TopicPage.class).topics.get(0);

        ZsxqModels.TopicFile file = topic.getTalk().getFiles().get(0);
        assertEquals("54825845551514422", file.getFileId());
        assertEquals("研报.pdf", file.getName());
        assertEquals(123456L, file.getSize());
        assertTrue(topic.getTalk().toString().contains("files=1"), topic.getTalk().toString());
    }

    /** 任务日志依赖 toString：ID 要完整、长正文截断、换行压平，避免刷屏。 */
    @Test
    void toStringIsReadableForJobLogs() {
        String longText = "第一行\\n" + "x".repeat(200);
        String json = """
                {"topics":[{"topic_id":22258421152844422,"type":"talk",
                  "create_time":"2026-11-25T10:40:00.819+0800","comments_count":10,
                  "talk":{"text":"%s","owner":{"user_id":88484111558422,"name":"tester"}}}]}
                """.formatted(longText);
        ZsxqModels.Topic topic = mapper.treeToValue(mapper.readTree(json), ZsxqModels.TopicPage.class).topics.get(0);

        String text = topic.toString();
        assertTrue(text.contains("topicId=22258421152844422"), text);
        assertTrue(text.contains("name=tester"), text);
        assertTrue(text.contains("commentsCount=10"), text);
        assertTrue(text.contains("…"), text);
        assertTrue(!text.contains("\n"), text);
        assertTrue(!text.contains("x".repeat(120)), text);
        assertTrue(text.length() < 800, text);
    }
}
