package com.jt.workbench.modules.zsxq.repo;

import com.jt.workbench.modules.zsxq.entity.ZsxqTopic;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.data.jpa.test.autoconfigure.DataJpaTest;
import org.springframework.boot.jdbc.test.autoconfigure.AutoConfigureTestDatabase;
import org.springframework.boot.jpa.test.autoconfigure.TestEntityManager;
import org.springframework.boot.persistence.autoconfigure.EntityScan;
import org.springframework.context.annotation.Configuration;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.jpa.repository.config.EnableJpaRepositories;
import org.springframework.test.context.ContextConfiguration;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** 仓库查询初始化与 CLOB 正文搜索回归：避免应用启动阶段查询校验失败。 */
@DataJpaTest(properties = {
        "spring.datasource.url=jdbc:h2:mem:zsxq-topic-repository;MODE=MySQL;DB_CLOSE_DELAY=-1",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "spring.jpa.hibernate.ddl-auto=create-drop",
        "spring.jpa.properties.hibernate.dialect=org.hibernate.dialect.H2Dialect"
})
@ContextConfiguration(classes = ZsxqTopicRepositoryTest.RepositoryTestConfig.class)
@AutoConfigureTestDatabase(replace = AutoConfigureTestDatabase.Replace.NONE)
class ZsxqTopicRepositoryTest {

    @Autowired
    private TestEntityManager entityManager;

    @Autowired
    private ZsxqTopicRepository repository;

    @Test
    void searchMatchesArticleContentCaseInsensitively() {
        ZsxqTopic topic = new ZsxqTopic();
        topic.setId("topic-1");
        topic.setTopicId("123");
        topic.setGroupId("group-1");
        topic.setAuthorId("author-1");
        topic.setArticleTitle("标题");
        topic.setArticleContent("<p>" + "x".repeat(12_000) + "Hibernate CLOB Search</p>");
        entityManager.persistAndFlush(topic);
        entityManager.clear();

        Page<ZsxqTopic> result = repository.search(
                "clob search", null, false, null, PageRequest.of(0, 10));

        assertEquals(1, result.getTotalElements());
        assertTrue(result.getContent().stream().anyMatch(item -> "topic-1".equals(item.getId())));
    }

    @Test
    void searchFiltersByRead() {
        ZsxqTopic read = new ZsxqTopic();
        read.setId("topic-read");
        read.setTopicId("1");
        read.setGroupId("g1");
        read.setDigest("已读内容");
        read.setRead(true);
        entityManager.persistAndFlush(read);

        ZsxqTopic unread = new ZsxqTopic();
        unread.setId("topic-unread");
        unread.setTopicId("2");
        unread.setGroupId("g1");
        unread.setDigest("未读内容");
        unread.setRead(false);
        entityManager.persistAndFlush(unread);

        ZsxqTopic plain = new ZsxqTopic();
        plain.setId("topic-plain");
        plain.setTopicId("3");
        plain.setGroupId("g1");
        plain.setDigest("默认未读内容");
        entityManager.persistAndFlush(plain);
        entityManager.clear();

        Page<ZsxqTopic> readResult = repository.search(null, null, false, "READ", PageRequest.of(0, 10));
        assertEquals(1, readResult.getTotalElements());
        assertEquals("topic-read", readResult.getContent().get(0).getId());

        Page<ZsxqTopic> unreadResult = repository.search(null, null, false, "UNREAD", PageRequest.of(0, 10));
        assertEquals(2, unreadResult.getTotalElements());
        assertTrue(unreadResult.getContent().stream().anyMatch(item -> "topic-unread".equals(item.getId())));
        assertTrue(unreadResult.getContent().stream().anyMatch(item -> "topic-plain".equals(item.getId())));

        Page<ZsxqTopic> allResult = repository.search(null, null, false, null, PageRequest.of(0, 10));
        assertEquals(3, allResult.getTotalElements());
    }

    @Configuration(proxyBeanMethods = false)
    @EnableJpaRepositories(basePackageClasses = ZsxqTopicRepository.class)
    @EntityScan(basePackageClasses = ZsxqTopic.class)
    static class RepositoryTestConfig {
    }
}
