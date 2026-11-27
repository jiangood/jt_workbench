package com.jt.workbench.modules.zsxq.service;

import com.jt.workbench.modules.zsxq.entity.ZsxqFile;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** 附件对象 key / 内容类型：保证下载文件名可辨认，且不会把路径字符带进 S3。 */
class ZsxqFileServiceTest {

    @Test
    void objectKeyKeepsFileIdAndSafeName() {
        ZsxqFile file = new ZsxqFile();
        file.setFileId("54825845551514422");
        file.setName("行业研报/2026.pdf");

        assertEquals("zsxq-file/54825845551514422_行业研报_2026.pdf", ZsxqFileService.objectKey(file));
    }

    @Test
    void blankNameFallsBackToFileId() {
        ZsxqFile file = new ZsxqFile();
        file.setFileId("54825845551514422");
        file.setName("   ");
        assertEquals("zsxq-file/54825845551514422_54825845551514422", ZsxqFileService.objectKey(file));
    }

    @Test
    void longNameIsTruncatedButExtensionKept() {
        ZsxqFile file = new ZsxqFile();
        file.setFileId("1");
        file.setName("x".repeat(200) + ".pdf");

        String key = ZsxqFileService.objectKey(file);
        assertTrue(key.endsWith(".pdf"), key);
        assertTrue(key.length() < 140, key);
    }

    @Test
    void contentTypeIsGuessedByExtension() {
        assertEquals("application/pdf", ZsxqFileService.guessContentType("a.PDF"));
        assertEquals("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                ZsxqFileService.guessContentType("a.xlsx"));
        assertEquals("application/octet-stream", ZsxqFileService.guessContentType("a.unknown"));
    }
}
