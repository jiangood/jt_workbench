package com.jt.workbench.modules.job.service;

import com.sun.net.httpserver.HttpServer;
import io.github.jiangood.openadmin.modules.config.service.SysConfigService;
import io.github.jiangood.openadmin.modules.job.JobResult;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;

import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * 资讯AI摘要端到端（不联网）：内嵌 JDK HttpServer 冒充 OpenAI-compatible 接口，
 * 真实 H2 schema + 真实 SysConfigService，验证选取 → 调用 → 落库；无正文条目标记为空串不重试。
 */
@SpringBootTest(properties = {
        "spring.datasource.url=jdbc:h2:mem:news-ai-summary-test;MODE=MySQL;DB_CLOSE_DELAY=-1",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "spring.jpa.hibernate.ddl-auto=create-drop",
        "spring.jpa.properties.hibernate.dialect=org.hibernate.dialect.H2Dialect",
        "spring.quartz.auto-startup=false"
})
class NewsAiSummaryServiceTest {

    @Autowired
    private JdbcTemplate jdbc;

    @Autowired
    private SysConfigService configService;

    @Autowired
    private NewsAiSummaryService service;

    @Test
    void generatesAndStoresSummaryViaOpenAiCompatibleEndpoint() throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/chat/completions", exchange -> {
            byte[] body = "{\"choices\":[{\"message\":{\"content\":\"这是一条测试摘要。\"}}]}"
                    .getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, body.length);
            exchange.getResponseBody().write(body);
            exchange.close();
        });
        server.start();
        try {
            configService.update(Map.of(NewsAiSummaryService.KEY_ENABLED, true));
            configService.update(Map.of(NewsAiSummaryService.KEY_BASE_URL,
                    "http://127.0.0.1:" + server.getAddress().getPort()));
            configService.update(Map.of(NewsAiSummaryService.KEY_PAUSE_SECONDS, 0));

            jdbc.update("INSERT INTO news_item (id, title, content, status, create_time) " +
                            "VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)",
                    "test-news-1", "测试标题", "<p>这是一段用于生成摘要的正文内容。</p>", "unread");

            JobResult result = service.run(LoggerFactory.getLogger(getClass()), msg -> {});

            assertEquals(JobResult.ok("生成摘要 1 条"), result);
            assertEquals("这是一条测试摘要。",
                    jdbc.queryForObject("SELECT ai_summary FROM news_item WHERE id = 'test-news-1'", String.class));
        } finally {
            server.stop(0);
        }
    }

    @Test
    void marksNoTextItemsWithoutCallingLlm() {
        // 无真实正文（仅标签）：不调用外部接口，标记 '' 避免反复重试；不显示摘要
        jdbc.update("INSERT INTO news_item (id, title, content, status, create_time) " +
                        "VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)",
                "test-news-empty", "空正文", "<p></p>", "unread");

        // base-url 指向不可用地址：若误调 LLM 会失败计数；此处不应发生
        configService.update(Map.of(NewsAiSummaryService.KEY_BASE_URL, "http://127.0.0.1:1"));
        configService.update(Map.of(NewsAiSummaryService.KEY_PAUSE_SECONDS, 0));

        JobResult result = service.run(LoggerFactory.getLogger(getClass()), msg -> {});

        // content 长度 > 0（"<p></p>"）会被选中，但去标签后为空 → 标记 ''、计入无正文跳过、不算失败
        assertEquals("生成摘要 0 条，无正文跳过 1 条", result.message());
        assertEquals("", jdbc.queryForObject("SELECT ai_summary FROM news_item WHERE id = 'test-news-empty'", String.class));
        // 标记为 '' 后不会被再次选中
        JobResult second = service.run(LoggerFactory.getLogger(getClass()), msg -> {});
        assertEquals("没有待生成摘要的资讯", second.message());
    }
}
