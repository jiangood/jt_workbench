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
    void searchFiltersByQuality() {
        ZsxqTopic dry = new ZsxqTopic();
        dry.setId("topic-dry");
        dry.setTopicId("1");
        dry.setGroupId("g1");
        dry.setDigest("干货内容");
        dry.setQuality("DRY");
        entityManager.persistAndFlush(dry);

        ZsxqTopic water = new ZsxqTopic();
        water.setId("topic-water");
        water.setTopicId("2");
        water.setGroupId("g1");
        water.setDigest("水帖内容");
        water.setQuality("WATER");
        entityManager.persistAndFlush(water);

        ZsxqTopic plain = new ZsxqTopic();
        plain.setId("topic-plain");
        plain.setTopicId("3");
        plain.setGroupId("g1");
        plain.setDigest("普通内容");
        entityManager.persistAndFlush(plain);
        entityManager.clear();

        Page<ZsxqTopic> dryResult = repository.search(null, null, false, "DRY", PageRequest.of(0, 10));
        assertEquals(1, dryResult.getTotalElements());
        assertEquals("topic-dry", dryResult.getContent().get(0).getId());

        Page<ZsxqTopic> waterResult = repository.search(null, null, false, "WATER", PageRequest.of(0, 10));
        assertEquals(1, waterResult.getTotalElements());
        assertEquals("topic-water", waterResult.getContent().get(0).getId());

        Page<ZsxqTopic> allResult = repository.search(null, null, false, null, PageRequest.of(0, 10));
        assertEquals(3, allResult.getTotalElements());
    }

    @Configuration(proxyBeanMethods = false)
    @EnableJpaRepositories(basePackageClasses = ZsxqTopicRepository.class)
    @EntityScan(basePackageClasses = ZsxqTopic.class)
    static class RepositoryTestConfig {
    }
}
