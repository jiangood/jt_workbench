package com.jt.workbench.modules.zsxq;

import com.jt.workbench.modules.zsxq.entity.ZsxqGroup;
import com.jt.workbench.modules.zsxq.entity.ZsxqTopic;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.util.List;

/**
 * 启动时将已存在的 zsxq 表列按实体声明的长度对齐。
 *
 * <p>{@code ddl-auto: update} 只新增缺失表/列，不会改动已存在列；实体上声明的
 * {@code length} 对老库（表已建好、列长仍为默认 255）不生效，这里补齐。
 * H2 / MySQL 两套语法逐个尝试，失败只记录不中断启动。</p>
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class ZsxqColumnLengthMigration implements ApplicationRunner {

    private final JdbcTemplate jdbc;

    @Override
    public void run(ApplicationArguments args) {
        try {
            ensureLength("zsxq_topic", "digest", ZsxqTopic.DIGEST_MAX_LENGTH);
            ensureLength("zsxq_topic", "cover", 2048);
            ensureLength("zsxq_topic", "attach", 4096);
            ensureLength("zsxq_group", "name", 1024);
            ensureLength("zsxq_group", "introduction", 2048);
            ensureLength("zsxq_group", "logo", 1024);
            ensureLength("zsxq_column", "name", 512);
            ensureLength("zsxq_column", "description", 2048);
            ensureLength("zsxq_column", "cover_url", 2048);
            log.info("zsxq 表字段长度对齐完成");
        } catch (Exception e) {
            log.warn("zsxq 表字段长度对齐跳过：{}", e.getMessage());
        }
    }

    /** H2 语法 → MySQL 语法，逐个尝试。 */
    private void ensureLength(String table, String column, int length) {
        List<String> sqls = List.of(
                "ALTER TABLE " + table + " ALTER COLUMN " + column + " SET DATA TYPE VARCHAR(" + length + ")",
                "ALTER TABLE " + table + " MODIFY COLUMN " + column + " VARCHAR(" + length + ")");
        for (String sql : sqls) {
            try {
                jdbc.execute(sql);
                return;
            } catch (Exception e) {
                log.debug("跳过失败语句 {}（err={}）", sql, e.getMessage());
            }
        }
        log.warn("无法对齐 {}.{} 到长度 {}", table, column, length);
    }
}
