package com.jt.workbench.modules.book.repo;

import com.jt.workbench.modules.book.entity.Book;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.data.jpa.test.autoconfigure.DataJpaTest;
import org.springframework.boot.jdbc.test.autoconfigure.AutoConfigureTestDatabase;
import org.springframework.boot.jpa.test.autoconfigure.TestEntityManager;
import org.springframework.boot.persistence.autoconfigure.EntityScan;
import org.springframework.context.annotation.Configuration;
import org.springframework.data.jpa.repository.config.EnableJpaRepositories;
import org.springframework.test.context.ContextConfiguration;

import static org.junit.jupiter.api.Assertions.assertEquals;

/** 阅读位置与进度原子回写回归：校验查询初始化，以及已读状态不被残留进度覆盖。 */
@DataJpaTest(properties = {
        "spring.datasource.url=jdbc:h2:mem:book-repository;MODE=MySQL;DB_CLOSE_DELAY=-1",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "spring.jpa.hibernate.ddl-auto=create-drop",
        "spring.jpa.properties.hibernate.dialect=org.hibernate.dialect.H2Dialect"
})
@ContextConfiguration(classes = BookRepositoryTest.RepositoryTestConfig.class)
@AutoConfigureTestDatabase(replace = AutoConfigureTestDatabase.Replace.NONE)
class BookRepositoryTest {

    @Autowired
    private TestEntityManager entityManager;

    @Autowired
    private BookRepository repository;

    @Test
    void updateReadingPositionPersistsCfiAndProgressTogether() {
        persist("book-1", "unread", 0);

        repository.updateReadingPosition("book-1", "epubcfi(/6/2!/4/2:10)", "v1", 42, 1234L);
        entityManager.clear();

        Book saved = repository.findById("book-1").orElseThrow();
        assertEquals("epubcfi(/6/2!/4/2:10)", saved.getReadCfi());
        assertEquals("v1", saved.getReadCfiVersion());
        assertEquals(42, saved.getProgress());
        assertEquals("reading", saved.getStatus());
        assertEquals(1234L, saved.getLastReadAt());
    }

    @Test
    void updateReadingPositionKeepsFinishedBookProgress() {
        persist("book-2", "read", 73);

        repository.updateReadingPosition("book-2", "epubcfi(/6/2!/4/2:20)", "v1", 20, 5678L);
        entityManager.clear();

        Book saved = repository.findById("book-2").orElseThrow();
        assertEquals(73, saved.getProgress());
        assertEquals("read", saved.getStatus());
    }

    private Book persist(String id, String status, int progress) {
        Book book = new Book();
        book.setId(id);
        book.setStatus(status);
        book.setProgress(progress);
        return entityManager.persistAndFlush(book);
    }

    @Configuration(proxyBeanMethods = false)
    @EnableJpaRepositories(basePackageClasses = BookRepository.class)
    @EntityScan(basePackageClasses = Book.class)
    static class RepositoryTestConfig {
    }
}
