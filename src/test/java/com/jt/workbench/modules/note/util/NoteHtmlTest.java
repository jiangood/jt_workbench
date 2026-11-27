package com.jt.workbench.modules.note.util;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class NoteHtmlTest {

    @Test
    void htmlBecomesReadablePlainText() {
        String text = NoteHtml.toPlainText("<h1>标题</h1><p>第一段 &amp; 第二行<br/>继续</p>");
        assertEquals("标题\n第一段 & 第二行\n继续", text);
    }

    @Test
    void scriptAndStyleAreNotSearchable() {
        assertEquals("正文", NoteHtml.toPlainText("<style>p{color:red}</style><p>正文</p><script>alert(1)</script>"));
    }

    @Test
    void plainTextFallsBackToEscapedParagraphs() {
        assertEquals("<p>&lt;提示&gt;</p><p><br/></p><p>第二行</p>",
                NoteHtml.plainTextToHtml("<提示>\n\n第二行"));
    }

    @Test
    void longTextIsTruncatedForSearch() {
        String html = "<p>" + "字".repeat(NoteHtml.PLAIN_TEXT_MAX_LENGTH + 100) + "</p>";
        assertTrue(NoteHtml.toPlainText(html).length() <= NoteHtml.PLAIN_TEXT_MAX_LENGTH);
    }
}
