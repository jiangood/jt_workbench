package com.jt.workbench.modules.job.service;

import io.github.jiangood.openadmin.framework.spi.FileOperator;
import io.github.jiangood.openadmin.modules.job.JobResult;
import lombok.RequiredArgsConstructor;
import org.slf4j.Logger;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

import javax.sql.DataSource;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.function.Consumer;

/**
 * 数据库备份：将数据库导出为文件并保存到对象存储（FileOperator / SysFile 存储后端，如 S3）。
 *
 * <p>当前支持 H2 文件库：通过 {@code BACKUP TO} 生成一致性备份 zip 后上传。
 * 非 H2 数据源暂不支持自动备份。</p>
 */
@Service
@RequiredArgsConstructor
public class DbBackupService {

    private static final DateTimeFormatter TS = DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss");

    private final JdbcTemplate jdbc;
    private final FileOperator fileOperator;

    public JobResult backup(Logger logger, Consumer<String> progress) {
        progress.accept("检查数据源");
        String url = jdbcUrl();
        if (url == null || !url.startsWith("jdbc:h2:")) {
            String msg = "当前数据源不是 H2（" + (url == null ? "unknown" : url) + "），暂不支持自动备份";
            logger.warn(msg);
            return JobResult.skip(msg);
        }

        String ts = LocalDateTime.now().format(TS);
        String key = "private/db-backup/jt-workbench-" + ts + ".zip";
        Path temp = null;
        try {
            progress.accept("创建临时文件");
            temp = Files.createTempFile("jt-db-backup-", ".zip");
            Files.deleteIfExists(temp); // H2 BACKUP TO 要求目标文件不存在

            progress.accept("导出数据库");
            String escaped = temp.toAbsolutePath().toString().replace("'", "''");
            jdbc.execute("BACKUP TO '" + escaped + "'");

            long size = Files.size(temp);
            progress.accept("上传备份文件");
            try (InputStream in = Files.newInputStream(temp)) {
                fileOperator.save(key, in);
            }

            String sizeText = formatSize(size);
            logger.info("数据库备份完成：{} ({})", key, sizeText);
            return JobResult.ok("备份完成：" + key + "（" + sizeText + "）");
        } catch (Exception e) {
            logger.error("数据库备份失败", e);
            throw new RuntimeException("数据库备份失败：" + e.getMessage(), e);
        } finally {
            if (temp != null) {
                try {
                    Files.deleteIfExists(temp);
                } catch (Exception ignored) {
                    // 临时文件清理失败不影响备份结果
                }
            }
        }
    }

    private String jdbcUrl() {
        try {
            DataSource ds = jdbc.getDataSource();
            if (ds == null) return null;
            try (Connection c = ds.getConnection()) {
                return c.getMetaData().getURL();
            }
        } catch (Exception e) {
            return null;
        }
    }

    private static String formatSize(long bytes) {
        if (bytes < 1024) return bytes + " B";
        if (bytes < 1024 * 1024) return String.format("%.1f KB", bytes / 1024.0);
        return String.format("%.1f MB", bytes / (1024.0 * 1024.0));
    }
}
