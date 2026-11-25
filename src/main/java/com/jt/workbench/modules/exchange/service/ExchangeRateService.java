package com.jt.workbench.modules.exchange.service;

import org.springframework.stereotype.Service;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 美元兑人民币日线参考汇率。数据由 Frankfurter 提供的欧洲央行参考汇率聚合，
 * 服务端只负责请求、缓存、裁剪周期与简单涨跌计算，趋势展示交由前端。
 */
@Service
public class ExchangeRateService {

    private static final ZoneId ZONE = ZoneId.systemDefault();
    private static final long CACHE_TTL_MILLIS = 60 * 60 * 1000L;
    private static final String API_URL = "https://api.frankfurter.app/%s..?from=USD&to=CNY";
    private static final Pattern RATE_POINT = Pattern.compile(
            "\"(\\d{4}-\\d{2}-\\d{2})\"\\s*:\\s*\\{\\s*\"CNY\"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)");

    private final HttpClient httpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(8))
            .followRedirects(HttpClient.Redirect.NORMAL)
            .build();

    private volatile CachedHistory cachedHistory;

    public Map<String, Object> usdCny(String requestedRange) {
        String range = normalizeRange(requestedRange);
        List<RatePoint> all = loadHistory();
        if (all.isEmpty()) return unavailable(range);

        List<RatePoint> history = selectRange(all, range, LocalDate.now(ZONE));
        if (history.isEmpty()) return unavailable(range);
        return buildPayload(history, range);
    }

    /** 一次缓存一年数据，切换 1/3/6/12 月只裁剪本地数据，避免重复请求上游。 */
    private synchronized List<RatePoint> loadHistory() {
        CachedHistory current = cachedHistory;
        long now = System.currentTimeMillis();
        if (current != null && now - current.loadedAt() < CACHE_TTL_MILLIS) {
            return current.points();
        }

        try {
            LocalDate start = LocalDate.now(ZONE).minusYears(1).minusDays(7);
            HttpRequest request = HttpRequest.newBuilder(URI.create(API_URL.formatted(start)))
                    .timeout(Duration.ofSeconds(12))
                    .header("User-Agent", "Mozilla/5.0")
                    .header("Accept", "application/json")
                    .GET()
                    .build();
            HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() != 200) {
                return current == null ? List.of() : current.points();
            }

            List<RatePoint> points = parseHistory(response.body());
            if (points.isEmpty()) {
                return current == null ? List.of() : current.points();
            }
            cachedHistory = new CachedHistory(now, List.copyOf(points));
            return points;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return current == null ? List.of() : current.points();
        } catch (Exception ignored) {
            // 上游不可用时优先展示尚未过期的本地缓存，没有缓存则返回前端降级状态。
            return current == null ? List.of() : current.points();
        }
    }

    static List<RatePoint> parseHistory(String json) {
        if (json == null || json.isBlank()) return List.of();
        List<RatePoint> points = new ArrayList<>();
        Matcher matcher = RATE_POINT.matcher(json);
        while (matcher.find()) {
            try {
                LocalDate date = LocalDate.parse(matcher.group(1));
                double close = Double.parseDouble(matcher.group(2));
                if (Double.isFinite(close) && close > 0) {
                    points.add(new RatePoint(date, round4(close)));
                }
            } catch (DateTimeParseException | NumberFormatException ignored) {
                // 忽略单条异常数据，不影响其他交易日。
            }
        }
        points.sort(Comparator.comparing(RatePoint::date));
        return points;
    }

    static String normalizeRange(String range) {
        if (range == null) return "3m";
        return switch (range.trim().toLowerCase(Locale.ROOT)) {
            case "1m" -> "1m";
            case "6m" -> "6m";
            case "1y" -> "1y";
            default -> "3m";
        };
    }

    static List<RatePoint> selectRange(List<RatePoint> all, String range, LocalDate today) {
        LocalDate start = switch (range) {
            case "1m" -> today.minusMonths(1);
            case "6m" -> today.minusMonths(6);
            case "1y" -> today.minusYears(1);
            default -> today.minusMonths(3);
        };
        return all.stream()
                .filter(point -> !point.date().isBefore(start) && !point.date().isAfter(today))
                .toList();
    }

    static Map<String, Object> buildPayload(List<RatePoint> history, String range) {
        RatePoint latest = history.get(history.size() - 1);
        RatePoint previous = history.size() >= 2 ? history.get(history.size() - 2) : null;
        Double change = previous == null ? null : round4(latest.close() - previous.close());
        Double changePct = previous == null || previous.close() == 0
                ? null : round4(change / previous.close() * 100.0);

        List<Map<String, Object>> points = new ArrayList<>();
        for (RatePoint point : history) {
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("date", point.date().toString());
            item.put("close", point.close());
            points.add(item);
        }

        Map<String, Object> data = new LinkedHashMap<>();
        data.put("available", true);
        data.put("base", "USD");
        data.put("quote", "CNY");
        data.put("symbol", "USD/CNY");
        data.put("source", "frankfurter");
        data.put("sourceName", "欧洲央行参考汇率");
        data.put("range", range);
        data.put("price", latest.close());
        data.put("prevClose", previous == null ? null : previous.close());
        data.put("change", change);
        data.put("changePct", changePct);
        data.put("asOf", latest.date().toString());
        data.put("history", points);
        return data;
    }

    private static Map<String, Object> unavailable(String range) {
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("available", false);
        data.put("symbol", "USD/CNY");
        data.put("range", range);
        return data;
    }

    private static double round4(double value) {
        return Math.round(value * 10000.0) / 10000.0;
    }

    record RatePoint(LocalDate date, double close) {
    }

    private record CachedHistory(long loadedAt, List<RatePoint> points) {
    }
}
