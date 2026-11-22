package com.jt.workbench.modules.zsxq;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.time.LocalDateTime;
import java.util.UUID;

/**
 * 兼容迁移：旧库（Node 版）把知识星球 token 存在 {@code zsxq_token}，新版框架只认注册过的
 * {@code zsxq.token}，未迁移时同步作业会一直提示「未配置知识星球 token」。
 *
 * <p>启动时若新 key 不存在、旧 key 存在，则把值复制到 {@code zsxq.token}（不动旧行）。
 * 已有新配置时不做任何修改。</p>
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class ZsxqLegacyConfigMigration implements ApplicationRunner {

    private final JdbcTemplate jdbc;

    @Override
    public void run(ApplicationArguments args) {
        try {
            Integer current = jdbc.queryForObject(
                    "SELECT COUNT(*) FROM sys_config WHERE config_key = 'zsxq.token'", Integer.class);
            if (current != null && current > 0) return;

            String legacy = jdbc.query("SELECT config_value FROM sys_config WHERE config_key = 'zsxq_token'",
                    rs -> rs.next() ? rs.getString(1) : null);
            if (legacy == null || legacy.isBlank()) return;

            jdbc.update("INSERT INTO sys_config (id, config_key, config_value, create_time, update_time) "
                            + "VALUES (?, 'zsxq.token', ?, ?, ?)",
                    UUID.randomUUID().toString().replace("-", ""), legacy,
                    LocalDateTime.now(), LocalDateTime.now());
            log.info("已将旧配置 zsxq_token 迁移为 zsxq.token，请到「系统参数」确认");
        } catch (Exception e) {
            log.warn("知识星球 token 旧配置迁移跳过：{}", e.getMessage());
        }
    }
}
