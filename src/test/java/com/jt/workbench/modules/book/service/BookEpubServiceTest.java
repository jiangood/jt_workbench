package com.jt.workbench.modules.book.service;

import com.jt.workbench.modules.book.entity.Book;
import io.documentnode.epub4j.domain.Author;
import io.documentnode.epub4j.domain.Identifier;
import io.documentnode.epub4j.domain.Resource;
import io.documentnode.epub4j.epub.EpubWriter;
import org.junit.jupiter.api.Test;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;

import static org.junit.jupiter.api.Assertions.assertEquals;

/** 直接上传 EPUB 时自动读取元数据的回归测试。 */
class BookEpubServiceTest {

    private final BookEpubService service = new BookEpubService(null, null, null);

    @Test
    void fillMetadataFromEpubReadsCommonFields() throws Exception {
        var epub = new io.documentnode.epub4j.domain.Book();
        epub.getMetadata().addTitle("撒哈拉的故事");
        epub.getMetadata().addAuthor(new Author("三毛"));
        epub.getMetadata().addPublisher("北京十月文艺出版社");
        epub.getMetadata().addDescription("<p>这是<b>简介</b>。</p>");
        epub.getMetadata().addIdentifier(new Identifier("ISBN", "9787530214787"));
        epub.getMetadata().addDate(new io.documentnode.epub4j.domain.Date("2011-07"));
        epub.addSection("第一章", new Resource(
                "<html><body>正文</body></html>".getBytes(StandardCharsets.UTF_8), "chapter1.xhtml"));

        ByteArrayOutputStream out = new ByteArrayOutputStream();
        new EpubWriter().write(epub, out);

        Book book = new Book();
        service.fillMetadataFromEpub(book, new ByteArrayInputStream(out.toByteArray()));

        assertEquals("撒哈拉的故事", book.getTitle());
        assertEquals("三毛", book.getAuthor());
        assertEquals("北京十月文艺出版社", book.getPublisher());
        assertEquals("这是 简介 。", book.getSummary());
        assertEquals("9787530214787", book.getIsbn());
        assertEquals("2011-07", book.getPubYear());
    }
}
