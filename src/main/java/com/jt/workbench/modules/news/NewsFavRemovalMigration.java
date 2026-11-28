package com.jt.workbench.modules.news;

import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * 收藏功能已移除：启动时把历史 status='fav' 的资讯迁移为 'read'。
 *
 * <p>无收藏保护后，这些条目按现有保留期清理（已读 3 天 / 其余 15 天）。
 * 幂等：没有 'fav' 行时不做任何事；表尚未建出时静默跳过。</p>
 */
@Component
public class NewsFavRemovalMigration implements ApplicationRunner {

    private final JdbcTemplate jdbc;

    public NewsFavRemovalMigration(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    @Override
    public void run(ApplicationArguments args) {
        try {
            jdbc.update("UPDATE news_item SET status = 'read' WHERE status = 'fav'");
        } catch (Exception ignored) {
            // 表可能尚未由 JPA 建出；建表后下次启动再迁移
        }
    }
}
