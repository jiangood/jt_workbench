package com.jt.workbench.modules.job.service;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;

class ZsxqTokenProbeServiceTest {

    @Test
    void tokenFromCookie_extractsAccessToken() {
        assertEquals("tok_123", ZsxqTokenProbeService.tokenFromCookie(
                "abtest_env=product; zsxq_access_token=tok_123; zsxqsessionid=abc"));
    }

    @Test
    void tokenFromCookie_missingOrBlank() {
        assertEquals("", ZsxqTokenProbeService.tokenFromCookie("zsxqsessionid=abc"));
        assertEquals("", ZsxqTokenProbeService.tokenFromCookie(null));
        assertEquals("", ZsxqTokenProbeService.tokenFromCookie("  "));
    }
}
