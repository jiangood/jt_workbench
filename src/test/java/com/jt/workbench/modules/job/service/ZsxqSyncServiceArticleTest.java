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

    /** 部分详情接口把长文正文放在 article_content，不能漏读。 */
    @Test
    void articleContentAliasIsSupported() {
        ZsxqModels.Topic topic = mapper.treeToValue(mapper.readTree("""
                {"topic_id":123,"article":{"article_content":"<p>正文别名</p>"}}
                """), ZsxqModels.Topic.class);

        assertEquals("<p>正文别名</p>", ZsxqSyncService.articleContentOf(topic));
    }

    @Test
    void missingArticleReturnsEmptyContent() {
        ZsxqModels.Topic topic = mapper.treeToValue(mapper.readTree("{\"topic_id\":123}"), ZsxqModels.Topic.class);

        assertEquals("", ZsxqSyncService.articleContentOf(topic));
        assertEquals("", ZsxqSyncService.articleContentUrlOf(topic));
        assertEquals("", ZsxqSyncService.columnArticleContentOf(topic));
    }

    /** 专栏里的普通长贴没有 article，完整正文在 talk.text；图片追加到正文末尾。 */
    @Test
    void columnContentFallsBackToTalkText() {
        String json = """
                {"topic_id":123,"type":"talk","title":"文章标题...",
                 "talk":{"text":"第一行\\n第二行 <提示>",
                   "images":[
                     {"original":{"url":"https://images.zsxq.com/a.jpg","width":1,"height":2}},
                     {"large":{"url":"https://images.zsxq.com/b.jpg","width":1,"height":2}}
                   ]}}
                """;
        ZsxqModels.Topic topic = mapper.treeToValue(mapper.readTree(json), ZsxqModels.Topic.class);

        String content = ZsxqSyncService.columnArticleContentOf(topic);
        assertEquals("第一行<br/>第二行 &lt;提示&gt;"
                + "<p><img src=\"https://images.zsxq.com/a.jpg\" loading=\"lazy\" referrerpolicy=\"no-referrer\"/></p>"
                + "<p><img src=\"https://images.zsxq.com/b.jpg\" loading=\"lazy\" referrerpolicy=\"no-referrer\"/></p>",
                content);
        assertEquals("第一行", ZsxqSyncService.columnArticleTitle(topic));
    }

    /** 星球截断的标题可以用正文第一行补全；长段落不当作标题。 */
    @Test
    void truncatedTitleFallsBackToFirstLine() {
        ZsxqModels.Topic shortTopic = mapper.treeToValue(mapper.readTree("""
                {"topic_id":1,"title":"八条投资原则之五...","talk":{"text":"八条投资原则之五——业务模式简单\\n正文"}}
                """), ZsxqModels.Topic.class);
        assertEquals("八条投资原则之五——业务模式简单", ZsxqSyncService.columnArticleTitle(shortTopic));

        String longLine = "很长".repeat(80);
        ZsxqModels.Topic longTopic = mapper.treeToValue(mapper.readTree("""
                {"topic_id":2,"title":"被截断的标题...","talk":{"text":"%s\\n正文"}}
                """.formatted(longLine)), ZsxqModels.Topic.class);
        assertEquals("被截断的标题...", ZsxqSyncService.columnArticleTitle(longTopic));
    }
}
