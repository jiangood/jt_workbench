package com.jt.workbench.modules.news;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.UUID;

/**
 * 默认屏蔽词种子。
 * 仅补齐缺失项，不覆盖已有数据。
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class NewsSourceSeed implements ApplicationRunner {

    private final JdbcTemplate jdbc;

    @Override
    public void run(ApplicationArguments args) {
        try {
            seedBlockWords();
        } catch (Exception e) {
            log.warn("seed default news block words skipped: {}", e.getMessage());
        }
    }

    private void seedBlockWords() {
        Integer count = jdbc.queryForObject("SELECT COUNT(*) FROM news_block_word", Integer.class);
        if (count != null && count > 0) return;

        List<String> words = List.of(
                "广告", "推广", "软文", "赞助", "商务合作", "招商", "加盟",
                "优惠券", "领券", "秒杀", "团购", "返利", "抽奖", "带货",
                "限时特惠", "打折促销", "清仓甩卖", "代购",
                "sponsored", "promoted", "advertisement"
        );
        int added = 0;
        for (String w : words) {
            try {
                String id = UUID.randomUUID().toString().replace("-", "");
                int n = jdbc.update(
                        "INSERT INTO news_block_word (id, word, enabled) " +
                        "SELECT ?, ?, TRUE WHERE NOT EXISTS (SELECT 1 FROM news_block_word WHERE word = ?)",
                        id, w, w);
                if (n > 0) added++;
            } catch (Exception e) {
                log.warn("seed news block word failed word={} err={}", w, e.getMessage());
            }
        }
        if (added > 0) log.info("seeded {} default news block words", added);
    }
}
