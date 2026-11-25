package com.jt.workbench.modules.zsxq.client;

/**
 * 知识星球接口业务错误。
 *
 * <p>业务码来自响应体的 {@code code}；HTTP/网络错误使用 0 或 HTTP 状态码。
 * 常用码：1059 风控/非官方工具拦截、40001 限流、15403 主题已删除、
 * 401/10001/10002/10003 鉴权失败。</p>
 */
public class ZsxqApiException extends RuntimeException {

    private final int code;

    public ZsxqApiException(int code, String message) {
        super(message == null || message.isBlank() ? "知识星球接口错误（code=" + code + "）" : message);
        this.code = code;
    }

    public int getCode() {
        return code;
    }

    /** 任务日志里直接打印异常对象时也能看到业务码。 */
    @Override
    public String toString() {
        return "ZsxqApiException{code=" + code + ", message=" + getMessage() + "}";
    }
}
