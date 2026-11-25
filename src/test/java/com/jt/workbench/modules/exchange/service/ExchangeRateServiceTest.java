package com.jt.workbench.modules.exchange.service;

import org.junit.jupiter.api.Test;

import java.time.LocalDate;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ExchangeRateServiceTest {

    @Test
    void normalizeRangeSupportsKnownPeriodsAndFallsBackToThreeMonths() {
        assertEquals("1m", ExchangeRateService.normalizeRange(" 1M "));
        assertEquals("6m", ExchangeRateService.normalizeRange("6m"));
        assertEquals("1y", ExchangeRateService.normalizeRange("1y"));
        assertEquals("3m", ExchangeRateService.normalizeRange("3m"));
        assertEquals("3m", ExchangeRateService.normalizeRange("invalid"));
        assertEquals("3m", ExchangeRateService.normalizeRange(null));
    }

    @Test
    void parseHistorySortsDatesAndIgnoresInvalidValues() {
        String json = """
                {
                  "base": "USD",
                  "rates": {
                    "2026-11-24": {"CNY": 6.6645},
                    "2026-11-20": {"CNY": 6.6777},
                    "2026-11-21": {"CNY": null},
                    "2026-11-23": {"CNY": 6.6647}
                  }
                }
                """;

        List<ExchangeRateService.RatePoint> points = ExchangeRateService.parseHistory(json);

        assertEquals(3, points.size());
        assertEquals(LocalDate.of(2026, 11, 20), points.get(0).date());
        assertEquals(6.6777, points.get(0).close());
        assertEquals(LocalDate.of(2026, 11, 24), points.get(2).date());
        assertEquals(6.6645, points.get(2).close());
    }

    @Test
    void selectRangeUsesCalendarPeriods() {
        List<ExchangeRateService.RatePoint> points = List.of(
                new ExchangeRateService.RatePoint(LocalDate.of(2026, 7, 23), 6.8000),
                new ExchangeRateService.RatePoint(LocalDate.of(2026, 8, 24), 6.7500),
                new ExchangeRateService.RatePoint(LocalDate.of(2026, 10, 24), 6.7000),
                new ExchangeRateService.RatePoint(LocalDate.of(2026, 11, 24), 6.6645)
        );
        LocalDate today = LocalDate.of(2026, 11, 25);

        assertEquals(1, ExchangeRateService.selectRange(points, "1m", today).size());
        assertEquals(2, ExchangeRateService.selectRange(points, "3m", today).size());
        assertEquals(4, ExchangeRateService.selectRange(points, "1y", today).size());
    }

    @Test
    void buildPayloadCalculatesDailyChangeAndReturnsOrderedHistory() {
        List<ExchangeRateService.RatePoint> points = List.of(
                new ExchangeRateService.RatePoint(LocalDate.of(2026, 11, 23), 6.6647),
                new ExchangeRateService.RatePoint(LocalDate.of(2026, 11, 24), 6.6645)
        );

        Map<String, Object> data = ExchangeRateService.buildPayload(points, "3m");

        assertTrue((Boolean) data.get("available"));
        assertEquals("USD/CNY", data.get("symbol"));
        assertEquals("3m", data.get("range"));
        assertEquals(6.6645, data.get("price"));
        assertEquals(6.6647, data.get("prevClose"));
        assertEquals(-0.0002, data.get("change"));
        assertEquals("2026-11-24", data.get("asOf"));
        List<?> history = (List<?>) data.get("history");
        assertEquals(2, history.size());
        assertEquals("2026-11-23", ((Map<?, ?>) history.get(0)).get("date"));
    }

    @Test
    void buildPayloadHandlesSinglePointWithoutPreviousClose() {
        Map<String, Object> data = ExchangeRateService.buildPayload(List.of(
                new ExchangeRateService.RatePoint(LocalDate.of(2026, 11, 24), 6.6645)
        ), "1m");

        assertFalse(data.containsKey("prevClose") && data.get("prevClose") != null);
        assertEquals(6.6645, data.get("price"));
        assertEquals(1, ((List<?>) data.get("history")).size());
    }
}
