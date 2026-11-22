package com.jt.workbench.modules.news;

import io.github.jiangood.openadmin.modules.config.entity.SysConfig;
import io.github.jiangood.openadmin.modules.config.repository.SysConfigRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.sql.Timestamp;
import java.time.LocalDateTime;
import java.util.List;
import java.util.Map;

/**
 * 一次性回补：历史 news_item.create_time 由 RSS 作业按 UTC 墙钟写入，
 * 统一回补 +8 小时为北京墙钟（与其他模块 create_time 语义一致）。
 *
 * <p>存量数据全部出自 RSS 抓取作业、无混合时区数据，整表 +8h 即可；
 * 新数据写入端（{@code RssFetchService}）已改为北京墙钟，无需再次回补。</p>
 *
 * <p>幂等：以 sys_config 标记行防重跑，后续启动直接跳过。</p>
 *
 * <p>用 {@link ApplicationRunner} 而非框架 {@code StartupHook}：后者在容器初始化早期
 * 实例化 Bean，注入 {@code JdbcTemplate} 会与 DataSource/JPA 形成循环依赖导致启动失败。</p>
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class NewsCreateTimeBackfill implements ApplicationRunner {

    private static final String MARKER_KEY = "news:createTimeBackfillBeijing8h";

    private final JdbcTemplate jdbc;
    private final SysConfigRepository configRepo;

    @Override
    public void run(ApplicationArguments args) {
        try {
            if (configRepo.findByConfigKey(MARKER_KEY).isPresent()) {
                return;
            }
            int updated = 0;
            List<Map<String, Object>> rows = jdbc.queryForList(
                    "SELECT id, create_time FROM news_item WHERE create_time IS NOT NULL");
            for (Map<String, Object> row : rows) {
                LocalDateTime old = toLocalDateTime(row.get("create_time"));
                if (old == null) continue;
                updated += jdbc.update("UPDATE news_item SET create_time = ? WHERE id = ?",
                        old.plusHours(8), row.get("id"));
            }
            SysConfig marker = new SysConfig();
            marker.setConfigKey(MARKER_KEY);
            marker.setConfigValue(String.valueOf(updated));
            configRepo.save(marker);
            log.info("资讯 create_time 回补 UTC→北京墙钟：{} 条", updated);
        } catch (Exception e) {
            log.warn("资讯 create_time 回补跳过：{}", e.getMessage());
        }
    }

    private static LocalDateTime toLocalDateTime(Object value) {
        if (value instanceof Timestamp t) return t.toLocalDateTime();
        if (value instanceof LocalDateTime ldt) return ldt;
        return null;
    }
}
