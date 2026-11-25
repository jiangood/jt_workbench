package com.jt.workbench.modules.zsxq.client;

import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** 回归：请求签名与错误文案必须与网页端行为一致。 */
class ZsxqApiClientTest {

    private final JsonMapper mapper = JsonMapper.builder().build();

    @Test
    void signatureMatchesBrowserSha1() {
        String url = "https://api.zsxq.com/v2/groups/48885445242158/topics?count=20&scope=all";
        String signature = ZsxqApiClient.signature(url, "1795583896", "5f0a1b2c-3d4e-4f50-8a9b-0c1d2e3f4a5b");
        assertEquals("aaf00b3c83a2e096cada10165845f96ea967fece", signature);
    }

    @Test
    void requestIdUsesWebFormat() {
        String id = ZsxqApiClient.newZsxqId();
        assertTrue(id.matches("^[0-9a-f]{9}(-[0-9a-f]{4}){3}-[0-9a-f]{11}$"), id);
    }

    @Test
    void cookieUsesFullBrowserCookieAsIs() {
        ZsxqApiClient client = new ZsxqApiClient("zsxq_access_token=abc; zsxqsessionid=xyz; abtest_env=product");
        assertEquals("zsxq_access_token=abc; zsxqsessionid=xyz; abtest_env=product", client.cookieHeader());
    }

    @Test
    void cookieAddsAbtestWhenMissing() {
        ZsxqApiClient client = new ZsxqApiClient("zsxq_access_token=abc");
        assertEquals("abtest_env=product; zsxq_access_token=abc", client.cookieHeader());
    }

    @Test
    void blankCookieStaysBlank() {
        ZsxqApiClient client = new ZsxqApiClient("");
        assertEquals("", client.cookieHeader());
    }

    @Test
    void riskControlUsesInfoBecauseErrorIsGeneric() {
        JsonNode root = mapper.readTree("""
                {"succeeded":false,"code":1059,"error":"内部错误",
                 "info":"不支持非官方工具访问，建议使用官方 Skill 获取内容","resp_data":{}}
                """);
        assertEquals("不支持非官方工具访问，建议使用官方 Skill 获取内容",
                ZsxqApiClient.errorMessage(root, 1059));
    }

    @Test
    void normalErrorIsKept() {
        JsonNode root = mapper.readTree("""
                {"succeeded":false,"code":15403,"error":"主题已经被删除","info":"","resp_data":{}}
                """);
        assertEquals("主题已经被删除", ZsxqApiClient.errorMessage(root, 15403));
    }

    @Test
    void errorAndInfoAreCombinedWhenBothMeaningful() {
        JsonNode root = mapper.readTree("""
                {"succeeded":false,"code":1234,"error":"参数错误","info":"end_time 格式不对","resp_data":{}}
                """);
        assertEquals("参数错误：end_time 格式不对", ZsxqApiClient.errorMessage(root, 1234));
    }
}
