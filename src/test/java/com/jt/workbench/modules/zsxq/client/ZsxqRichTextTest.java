package com.jt.workbench.modules.zsxq.client;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** 回归：专栏普通长贴的 talk.text 要还原成可展示的 HTML，而不是原样或标签源码。 */
class ZsxqRichTextTest {

    @Test
    void richLinksAndLineBreaksBecomeHtml() {
        String text = "推荐一本书《<e type=\"web\" href=\"https%3A%2F%2Fbook.zsxq.com%2F1\" "
                + "title=\"%E6%BB%A1%E4%BB%93%E7%BB%BF\" />》\n第二行 & <提示>";

        String html = ZsxqRichText.toHtml(text);

        assertEquals("推荐一本书《<a href=\"https://book.zsxq.com/1\" target=\"_blank\" "
                + "rel=\"noreferrer noopener\">满仓绿</a>》<br/>第二行 &amp; &lt;提示&gt;", html);
    }

    @Test
    void plusSignInAttributeStaysLiteral() {
        assertEquals("C++", ZsxqRichText.toHtml("<e type=\"hashtag\" title=\"C++\" />"));
    }

    @Test
    void unsafeLinksOnlyKeepText() {
        String text = "点这里<e type=\"web\" href=\"javascript%3Aalert(1)\" title=\"不要点\" />";

        assertEquals("点这里不要点", ZsxqRichText.toHtml(text));
    }

    @Test
    void unfinishedTagStillShowsReadableTitle() {
        assertEquals("前缀 <a href=\"https://book.zsxq.com/1\" target=\"_blank\" "
                        + "rel=\"noreferrer noopener\">满仓绿</a>", ZsxqRichText.toHtml(
                "前缀 <e type=\"web\" href=\"https%3A%2F%2Fbook.zsxq.com%2F1\" title=\"%E6%BB%A1%E4%BB%93%E7%BB%BF\""));
    }

    @Test
    void imageTagOnlyAllowsOfficialHost() {
        assertTrue(ZsxqRichText.imageHtml("https://images.zsxq.com/a.jpg").contains("src=\"https://images.zsxq.com/a.jpg\""));
        assertFalse(ZsxqRichText.imageHtml("https://evil.test/a.jpg").contains("<img"));
        assertEquals("", ZsxqRichText.imageHtml(null));
    }
}
