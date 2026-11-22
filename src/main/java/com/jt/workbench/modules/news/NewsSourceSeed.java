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
 * 内置资讯订阅源与默认屏蔽词种子。
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
            seedSources();
        } catch (Exception e) {
            log.warn("seed builtin news sources skipped: {}", e.getMessage());
        }
        try {
            seedBlockWords();
        } catch (Exception e) {
            log.warn("seed default news block words skipped: {}", e.getMessage());
        }
    }

    private void seedSources() {
        List<Seed> seeds = List.of(
                new Seed("wb-src-infoq-cn", "InfoQ 中文", "RSS", "https://www.infoq.cn/feed"),
                new Seed("wb-src-36kr", "36Kr", "RSS", "https://www.36kr.com/feed"),
                new Seed("wb-src-sspai", "少数派", "RSS", "https://sspai.com/feed"),
                new Seed("wb-src-ruanyf", "阮一峰的网络日志", "RSS", "https://www.ruanyifeng.com/blog/atom.xml"),
                new Seed("wb-src-cloudflare", "Cloudflare Blog", "RSS", "https://blog.cloudflare.com/rss/"),
                new Seed("wb-src-github", "GitHub Blog", "RSS", "https://github.blog/feed/"),
                new Seed("wb-src-solidot", "Solidot", "RSS", "https://www.solidot.org/index.rss"),
                new Seed("wb-src-meituan", "美团技术团队", "RSS", "https://tech.meituan.com/feed/"),
                new Seed("wb-src-wallstreetcn", "华尔街见闻", "RSS", "https://feed.wallstreetcn.com/"),
                new Seed("wb-src-marketwatch", "MarketWatch", "RSS", "http://feeds.marketwatch.com/marketwatch/topstories/"),
                new Seed("wb-src-zhihu-hot", "知乎热榜", "RSS", "https://rsshub.app/zhihu/hotlist"),
                new Seed("wb-src-zhihu-daily", "知乎日报", "RSS", "https://rsshub.app/zhihu/daily")
        );

        int added = 0;
        for (Seed s : seeds) {
            try {
                Integer exists = jdbc.queryForObject("SELECT COUNT(*) FROM news_source WHERE id = ?", Integer.class, s.id());
                if (exists != null && exists > 0) continue;
                int n = jdbc.update(
                        "INSERT INTO news_source (id, name, type, url, enabled) " +
                        "SELECT ?, ?, ?, ?, TRUE WHERE NOT EXISTS (SELECT 1 FROM news_source WHERE id = ?)",
                        s.id(), s.name(), s.type(), s.url(), s.id());
                if (n > 0) added++;
            } catch (Exception e) {
                log.warn("seed news source failed id={} name={} err={}", s.id(), s.name(), e.getMessage());
            }
        }
        if (added > 0) log.info("seeded {} builtin news sources", added);
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

    private record Seed(String id, String name, String type, String url) {}
}
