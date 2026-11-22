package com.jt.workbench.modules.job.service;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.slf4j.Logger;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

import java.sql.Timestamp;
import java.time.Instant;

/**
 * 清理过期资讯：非收藏（status <> 'fav'）且超过保留期（15 天）的条目。
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class NewsOldPruneService {

    private static final long DAY_MS = 86_400_000L;
    private static final long NEWS_RETENTION_MS = 15 * DAY_MS;

    private final JdbcTemplate jdbc;

    public String run(Logger logger, java.util.function.Consumer<String> progress) {
        long now = System.currentTimeMillis();
        int deleted = jdbc.update(
                "DELETE FROM news_item WHERE status <> 'fav' AND create_time < ?",
                Timestamp.from(Instant.ofEpochMilli(now - NEWS_RETENTION_MS)));
        logger.info("资讯清理：过期 {} 条", deleted);
        return "清理过期 " + deleted + " 条";
    }
}
