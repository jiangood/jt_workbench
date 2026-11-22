package com.jt.workbench.modules.job.service;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.slf4j.Logger;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

import java.sql.Timestamp;
import java.time.Instant;

/**
 * 清理已读资讯：status='read' 且超过保留期（3 天）的条目。
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class NewsReadPruneService {

    private static final long DAY_MS = 86_400_000L;
    private static final long READ_RETENTION_MS = 3 * DAY_MS;

    private final JdbcTemplate jdbc;

    public String run(Logger logger, java.util.function.Consumer<String> progress) {
        long now = System.currentTimeMillis();
        int deleted = jdbc.update(
                "DELETE FROM news_item WHERE status = 'read' AND create_time < ?",
                Timestamp.from(Instant.ofEpochMilli(now - READ_RETENTION_MS)));
        logger.info("资讯清理：已读 {} 条", deleted);
        return "清理已读 " + deleted + " 条";
    }
}
