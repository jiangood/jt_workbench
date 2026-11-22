package com.jt.workbench.modules.stock.controller;

import com.jt.workbench.modules.stock.entity.StockWatch;
import com.jt.workbench.modules.stock.repo.StockWatchRepository;
import io.github.jiangood.openadmin.util.dto.AjaxResult;
import io.github.jiangood.openadmin.framework.perm.HasPermission;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.domain.Sort;
import org.springframework.data.web.PageableDefault;
import org.springframework.web.bind.annotation.*;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.Charset;
import java.time.Duration;
import java.util.*;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

/**
 * 自选股：列表（可按分组过滤）、增删改、实时行情、VIX 看板。
 */
@RestController
@RequestMapping("admin/stock")
public class StockController {

    private static final Pattern SINA_LINE = Pattern.compile("hq_str_((?:sh|sz|bj)\\d{6})=\"([^\"]*)\"");
    private static final Charset GBK = Charset.forName("GB18030");

    @org.springframework.beans.factory.annotation.Autowired
    private StockWatchRepository stockWatchRepository;

    private final HttpClient httpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(8))
            .followRedirects(HttpClient.Redirect.NORMAL)
            .build();

    @HasPermission("stock:read")
    @PostMapping("page")
    public AjaxResult page(@PageableDefault(sort = "code", size = 20) Pageable pageable,
                           @RequestParam(required = false) String groupName) {
        Page<StockWatch> page = (groupName != null && !groupName.isBlank())
                ? stockWatchRepository.findByGroupName(groupName, pageable)
                : stockWatchRepository.findAll(pageable);
        return new AjaxResult().ok().data(page);
    }

    /** 持仓监控用：返回全部自选股列表（含停用/待确认），供前端展示与排序筛选。 */
    @HasPermission("stock:read")
    @GetMapping("list")
    public AjaxResult list() {
        List<StockWatch> list = stockWatchRepository.findAll(Sort.by(Sort.Order.asc("code").nullsLast()));
        return new AjaxResult().ok().data(list);
    }

    @HasPermission("stock:read")
    @GetMapping("info/{code}")
    public AjaxResult info(@PathVariable String code) {
        StockWatch item = stockWatchRepository.findByCodeNative(code);
        return item != null ? new AjaxResult().ok().data(item) : new AjaxResult();
    }

    @HasPermission("stock:manage")
    @PostMapping("create")
    public AjaxResult create(@RequestBody StockWatch input) {
        normalize(input);
        StockWatch saved = stockWatchRepository.save(input);
        return new AjaxResult().ok().data(saved);
    }

    @HasPermission("stock:manage")
    @PostMapping("update")
    public AjaxResult update(@RequestBody StockWatch input) {
        if (input.getId() != null && stockWatchRepository.existsById(input.getId())) {
            normalize(input);
            stockWatchRepository.save(input);
        }
        return new AjaxResult();
    }

    private void normalize(StockWatch s) {
        if (s == null) return;
        if (s.getCode() != null) {
            String c = s.getCode().trim().toLowerCase();
            s.setCode(c.isEmpty() ? null : c);
        }
        if (s.getName() != null) {
            String n = s.getName().trim();
            s.setName(n.isEmpty() ? null : n);
        }
        if (s.getGroupName() != null) {
            String g = s.getGroupName().trim();
            s.setGroupName(g.isEmpty() ? null : g);
        }
        if (s.getUpdDate() != null) {
            String d = s.getUpdDate().trim();
            s.setUpdDate(d.isEmpty() ? null : d);
        }
        if (s.getEnabled() == null) s.setEnabled(true);
    }

    @HasPermission("stock:manage")
    @PostMapping("delete")
    public AjaxResult delete(@RequestBody io.github.jiangood.openadmin.util.dto.IdReq req) {
        stockWatchRepository.deleteById(req.getId());
        return new AjaxResult();
    }

    @HasPermission("stock:read")
    @GetMapping("options")
    public AjaxResult options() {
        java.util.List<String> groups = stockWatchRepository.findAll().stream()
                .map(StockWatch::getGroupName)
                .filter(g -> g != null && !g.isBlank())
                .distinct()
                .toList();
        return new AjaxResult().ok().data(groups);
    }

    /** 启用自选股实时行情（新浪，GB18030）。 */
    @HasPermission("stock:read")
    @GetMapping("quote")
    public AjaxResult quote() {
        List<StockWatch> watch = stockWatchRepository.findAll(Sort.by("code")).stream()
                .filter(s -> !Boolean.FALSE.equals(s.getEnabled()))
                .filter(s -> s.getCode() != null && !s.getCode().isBlank())
                .collect(Collectors.toList());
        if (watch.isEmpty()) {
            return new AjaxResult().ok().data(Map.of("quotes", List.of()));
        }

        String codes = watch.stream().map(StockWatch::getCode).collect(Collectors.joining(","));
        Map<String, String> nameMap = watch.stream()
                .filter(s -> s.getCode() != null)
                .collect(Collectors.toMap(StockWatch::getCode, s -> s.getName() == null ? "" : s.getName(), (a, b) -> a));

        List<Map<String, Object>> quotes = new ArrayList<>();
        try {
            HttpRequest req = HttpRequest.newBuilder(URI.create("https://hq.sinajs.cn/list=" + codes))
                    .timeout(Duration.ofSeconds(10))
                    .header("Referer", "https://finance.sina.com.cn")
                    .header("User-Agent", "Mozilla/5.0")
                    .GET()
                    .build();
            HttpResponse<byte[]> resp = httpClient.send(req, HttpResponse.BodyHandlers.ofByteArray());
            if (resp.statusCode() == 200) {
                String body = new String(resp.body(), GBK);
                Matcher m = SINA_LINE.matcher(body);
                while (m.find()) {
                    String code = m.group(1);
                    String raw = m.group(2);
                    String[] f = raw.split(",", -1);
                    if (f.length < 32) continue;
                    double prevClose = parseDouble(f[2]);
                    double rawPrice = parseDouble(f[3]);
                    boolean preOpen = !(rawPrice > 0);
                    double base = prevClose > 0 ? prevClose : 0;
                    double price = preOpen ? base : rawPrice;
                    double change = preOpen ? 0 : price - base;
                    double changePct = (preOpen || base == 0) ? 0 : (change / base) * 100.0;
                    String time = (f.length > 31 ? f[30] : "") + " " + (f.length > 31 ? f[31] : "");
                    Map<String, Object> q = new LinkedHashMap<>();
                    q.put("code", code);
                    q.put("name", nameMap.getOrDefault(code, f[0]));
                    q.put("price", round2(price));
                    q.put("change", round2(change));
                    q.put("changePct", round4(changePct));
                    q.put("preOpen", preOpen);
                    q.put("prevClose", round2(prevClose));
                    q.put("time", time.trim());
                    quotes.add(q);
                }
            }
        } catch (Exception ignored) {
            // 行情源异常时返回空列表，前端降级显示
        }

        return new AjaxResult().ok().data(Map.of("quotes", quotes));
    }

    private static final String VIX_YAHOO_URL = "https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?interval=1d&range=1mo&includePrePost=false";
    private static final String VIX_CNBC_QUOTE_URL = "https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=.VIX&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json&events=1";
    private static final String VIX_CNBC_CHART_URL = "https://ts-api.cnbc.com/harmony/app/charts/1M.json?symbol=.VIX";
    private static final Pattern CNBC_BAR = Pattern.compile("\"close\":\"(-?\\d+(?:\\.\\d+)?)\",\"volume\":\\d+,\"tradeTime\":\"\\d{14}\",\"tradeTimeinMills\":(\\d+)");
    private static final int VIX_HISTORY_LIMIT = 30;
    /** Yahoo 最近一次失败时间点，失败后 10 分钟内不再重试，避免每次进首页都等超时。 */
    private volatile long vixYahooSkipUntil = 0L;

    /** VIX 指数看板数据（Yahoo Finance ^VIX 优先，不可达时回退 CNBC，含最近约 1 个月日线）。 */
    @HasPermission("stock:read")
    @GetMapping("vix")
    public AjaxResult vix() {
        Map<String, Object> data = null;
        if (System.currentTimeMillis() >= vixYahooSkipUntil) {
            try {
                data = fetchVixFromYahoo();
            } catch (Exception ignored) {
            }
            if (data == null) {
                vixYahooSkipUntil = System.currentTimeMillis() + 10 * 60 * 1000L;
            }
        }
        if (data == null) {
            try {
                data = fetchVixFromCnbc();
            } catch (Exception ignored) {
            }
        }
        if (data == null) {
            data = new LinkedHashMap<>();
            data.put("available", false);
        }
        return new AjaxResult().ok().data(data);
    }

    private Map<String, Object> fetchVixFromYahoo() throws Exception {
        HttpRequest req = HttpRequest.newBuilder(URI.create(VIX_YAHOO_URL))
                .timeout(Duration.ofSeconds(12))
                .header("User-Agent", "Mozilla/5.0")
                .header("Accept", "application/json")
                .GET()
                .build();
        HttpResponse<String> resp = httpClient.send(req, HttpResponse.BodyHandlers.ofString());
        if (resp.statusCode() != 200) return null;
        String body = resp.body();
        Double current = extractJsonNumber(body, "regularMarketPrice");
        Double prev = extractJsonNumber(body, "chartPreviousClose");
        Double marketTimeSec = extractJsonNumber(body, "regularMarketTime");
        String symbol = extractJsonString(body, "symbol");
        if (symbol == null || symbol.isBlank()) symbol = "^VIX";

        List<Long> timestamps = extractJsonLongArray(body, "timestamp");
        List<Double> closes = extractJsonCloseArray(body);
        List<Map<String, Object>> history = new ArrayList<>();
        int n = Math.min(timestamps.size(), closes.size());
        for (int i = 0; i < n; i++) {
            Double c = closes.get(i);
            if (c == null) continue;
            Map<String, Object> p = new LinkedHashMap<>();
            p.put("t", timestamps.get(i) * 1000L);
            p.put("close", round2(c));
            history.add(p);
        }

        if (current == null && !history.isEmpty()) {
            current = ((Number) history.get(history.size() - 1).get("close")).doubleValue();
        }
        if (prev == null && history.size() >= 2) {
            prev = ((Number) history.get(history.size() - 2).get("close")).doubleValue();
        }
        if (current == null) return null;
        Double change = (prev != null) ? current - prev : null;
        Double changePct = (change != null && prev != null && prev != 0) ? (change / prev) * 100.0 : null;

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("available", true);
        out.put("source", "yahoo");
        out.put("symbol", symbol);
        out.put("price", round2(current));
        out.put("prevClose", prev == null ? null : round2(prev));
        out.put("change", change == null ? null : round2(change));
        out.put("changePct", changePct == null ? null : round4(changePct));
        out.put("marketTime", marketTimeSec == null ? null : marketTimeSec.longValue() * 1000L);
        out.put("history", history);
        return out;
    }

    /** CNBC 公开行情接口：国内网络可访问，作为 Yahoo 被墙/不可达时的回退源。 */
    private Map<String, Object> fetchVixFromCnbc() throws Exception {
        HttpRequest qreq = HttpRequest.newBuilder(URI.create(VIX_CNBC_QUOTE_URL))
                .timeout(Duration.ofSeconds(10))
                .header("User-Agent", "Mozilla/5.0")
                .header("Accept", "application/json")
                .GET()
                .build();
        HttpResponse<String> qresp = httpClient.send(qreq, HttpResponse.BodyHandlers.ofString());
        if (qresp.statusCode() != 200) return null;
        String qj = qresp.body();
        Double last = extractQuotedNumber(qj, "last");
        if (last == null) return null;
        Double prev = extractQuotedNumber(qj, "previous_day_closing");
        Double change = extractQuotedNumber(qj, "change");
        Double changePct = extractQuotedNumber(qj, "change_pct");

        List<Map<String, Object>> history = new ArrayList<>();
        try {
            HttpRequest creq = HttpRequest.newBuilder(URI.create(VIX_CNBC_CHART_URL))
                    .timeout(Duration.ofSeconds(10))
                    .header("User-Agent", "Mozilla/5.0")
                    .header("Accept", "application/json")
                    .GET()
                    .build();
            HttpResponse<String> cresp = httpClient.send(creq, HttpResponse.BodyHandlers.ofString());
            if (cresp.statusCode() == 200) {
                Matcher m = CNBC_BAR.matcher(cresp.body());
                while (m.find()) {
                    double c = Double.parseDouble(m.group(1));
                    long t = Long.parseLong(m.group(2));
                    Map<String, Object> p = new LinkedHashMap<>();
                    p.put("t", t);
                    p.put("close", round2(c));
                    history.add(p);
                }
            }
        } catch (Exception ignored) {
        }
        if (history.size() > VIX_HISTORY_LIMIT) {
            history = new ArrayList<>(history.subList(history.size() - VIX_HISTORY_LIMIT, history.size()));
        }
        if (change == null && prev != null) change = last - prev;
        if (changePct == null && change != null && prev != null && prev != 0) changePct = change / prev * 100.0;
        if (prev == null && history.size() >= 2) {
            prev = ((Number) history.get(history.size() - 2).get("close")).doubleValue();
            change = last - prev;
            changePct = prev != 0 ? change / prev * 100.0 : null;
        }
        Long marketTime = history.isEmpty() ? null : ((Number) history.get(history.size() - 1).get("t")).longValue();

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("available", true);
        out.put("source", "cnbc");
        out.put("symbol", "^VIX");
        out.put("price", round2(last));
        out.put("prevClose", prev == null ? null : round2(prev));
        out.put("change", change == null ? null : round2(change));
        out.put("changePct", changePct == null ? null : round4(changePct));
        out.put("marketTime", marketTime);
        out.put("history", history);
        return out;
    }

    /** 解析 CNBC 字符串型数字，如 "last":"35.89"、"change":"+7.45"、"change_pct":"+26.20%"。 */
    private static Double extractQuotedNumber(String json, String key) {
        if (json == null) return null;
        Pattern p = Pattern.compile("\\\"" + Pattern.quote(key) + "\\\"\\s*:\\s*\\\"\\s*([+-]?\\d+(?:\\.\\d+)?)");
        Matcher m = p.matcher(json);
        if (m.find()) {
            try {
                return Double.parseDouble(m.group(1));
            } catch (Exception ignored) {
            }
        }
        return null;
    }

    private static Double extractJsonNumber(String json, String key) {
        if (json == null) return null;
        Pattern p = Pattern.compile("\\\"" + Pattern.quote(key) + "\\\"\\s*:\\s*(-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)");
        Matcher m = p.matcher(json);
        if (m.find()) {
            try {
                return Double.parseDouble(m.group(1));
            } catch (Exception ignored) {
            }
        }
        return null;
    }

    private static String extractJsonString(String json, String key) {
        if (json == null) return null;
        Pattern p = Pattern.compile("\\\"" + Pattern.quote(key) + "\\\"\\s*:\\s*\\\"([^\\\"]*)\\\"");
        Matcher m = p.matcher(json);
        return m.find() ? m.group(1) : null;
    }

    private static List<Long> extractJsonLongArray(String json, String key) {
        List<Long> out = new ArrayList<>();
        if (json == null) return out;
        Pattern p = Pattern.compile("\\\"" + Pattern.quote(key) + "\\\"\\s*:\\s*\\[(.*?)\\]", Pattern.DOTALL);
        Matcher m = p.matcher(json);
        if (!m.find()) return out;
        Matcher n = Pattern.compile("-?\\d+").matcher(m.group(1));
        while (n.find()) {
            try {
                out.add(Long.parseLong(n.group()));
            } catch (Exception ignored) {
            }
        }
        return out;
    }

    /** 提取 quote.close 数组（允许 null）。 */
    private static List<Double> extractJsonCloseArray(String json) {
        List<Double> out = new ArrayList<>();
        if (json == null) return out;
        int qi = json.indexOf("\"quote\"");
        if (qi < 0) return out;
        int ci = json.indexOf("\"close\"", qi);
        if (ci < 0) return out;
        int lb = json.indexOf('[', ci);
        if (lb < 0) return out;
        int depth = 0;
        int rb = -1;
        for (int i = lb; i < json.length(); i++) {
            char ch = json.charAt(i);
            if (ch == '[') depth++;
            else if (ch == ']') {
                depth--;
                if (depth == 0) {
                    rb = i;
                    break;
                }
            }
        }
        if (rb < 0) return out;
        String inside = json.substring(lb + 1, rb);
        Matcher m = Pattern.compile("null|-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?").matcher(inside);
        while (m.find()) {
            String tok = m.group();
            if ("null".equals(tok)) out.add(null);
            else {
                try {
                    out.add(Double.parseDouble(tok));
                } catch (Exception ignored) {
                    out.add(null);
                }
            }
        }
        return out;
    }

    private static double parseDouble(String s) {
        try {
            return Double.parseDouble(s.trim());
        } catch (Exception e) {
            return 0;
        }
    }

    private static double round2(double v) {
        return Math.round(v * 100.0) / 100.0;
    }

    private static double round4(double v) {
        return Math.round(v * 10000.0) / 10000.0;
    }
}
