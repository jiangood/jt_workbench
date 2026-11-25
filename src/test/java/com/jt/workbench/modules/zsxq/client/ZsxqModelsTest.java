package com.jt.workbench.modules.zsxq.client;

import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.PropertyNamingStrategies;
import tools.jackson.databind.json.JsonMapper;

import static org.junit.jupiter.api.Assertions.assertEquals;

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
}
