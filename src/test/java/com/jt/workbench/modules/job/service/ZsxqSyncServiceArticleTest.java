package com.jt.workbench.modules.job.service;

import com.jt.workbench.modules.zsxq.client.ZsxqModels;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.PropertyNamingStrategies;
import tools.jackson.databind.json.JsonMapper;

import static org.junit.jupiter.api.Assertions.assertEquals;

/** 专栏完整正文提取回归：优先正文页地址，正文 HTML 不做截断。 */
class ZsxqSyncServiceArticleTest {

    private final ObjectMapper mapper = JsonMapper.builder()
            .propertyNamingStrategy(PropertyNamingStrategies.SNAKE_CASE)
            .build();

    @Test
    void articleContentUsesEmbeddedHtmlAndInlineUrlFirst() {
        String json = """
                {"topic_id":123,"article":{
                  "article_url":"https://articles.zsxq.com/id_outer.html",
                  "inline_article_url":"//articles.zsxq.com/id_inline.html",
                  "content":"<p>完整正文</p>"}}
                """;
        ZsxqModels.Topic topic = mapper.treeToValue(mapper.readTree(json), ZsxqModels.Topic.class);

        assertEquals("<p>完整正文</p>", ZsxqSyncService.articleContentOf(topic));
        assertEquals("https://articles.zsxq.com/id_inline.html", ZsxqSyncService.articleContentUrlOf(topic));
    }

    @Test
    void articleContentFallsBackToTopLevelContent() {
        String json = """
                {"topic_id":123,"content":"<div><p>顶层正文</p></div>",
                 "article":{"article_url":"articles.zsxq.com/id_abc.html"}}
                """;
        ZsxqModels.Topic topic = mapper.treeToValue(mapper.readTree(json), ZsxqModels.Topic.class);

        assertEquals("<div><p>顶层正文</p></div>", ZsxqSyncService.articleContentOf(topic));
        assertEquals("https://articles.zsxq.com/id_abc.html", ZsxqSyncService.articleContentUrlOf(topic));
    }

    @Test
    void missingArticleReturnsEmptyContent() {
        ZsxqModels.Topic topic = mapper.treeToValue(mapper.readTree("{\"topic_id\":123}"), ZsxqModels.Topic.class);

        assertEquals("", ZsxqSyncService.articleContentOf(topic));
        assertEquals("", ZsxqSyncService.articleContentUrlOf(topic));
    }
}
