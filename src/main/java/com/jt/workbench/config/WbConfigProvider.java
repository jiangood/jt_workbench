package com.jt.workbench.config;

import io.github.jiangood.openadmin.framework.config.dynamic.ConfigGroup;
import io.github.jiangood.openadmin.framework.config.dynamic.Configs;
import io.github.jiangood.openadmin.framework.spi.ConfigProvider;
import org.springframework.stereotype.Component;

import java.util.List;

/**
 * 业务作业参数（系统管理 → 系统参数）。
 * key 遵循框架约定：全小写、点分隔，注册后才能被 SysConfigService 读取。
 */
@Component
public class WbConfigProvider implements ConfigProvider {

    @Override
    public List<ConfigGroup> define() {
        return List.of(
                Configs.group("zsxq", "知识星球", 100)
                        .description("知识星球同步与历史回填作业参数")
                        .add(Configs.text("zsxq.cookie", "Cookie")
                                .asSecret()
                                .hint("直接粘贴浏览器 api.zsxq.com 请求头里的完整 Cookie（含 zsxq_access_token）"))
                        .add(Configs.integer("zsxq.risk-retry-count", "风控原地重试次数")
                                .defaultValue(3).min(1).max(6)
                                .hint("命中 1059/40001 时同一请求换 request-id 重试的次数，默认 3；仍失败才进冷却"))
                        .add(Configs.integer("zsxq.risk-retry-pause-seconds", "风控重试退避（秒）")
                                .defaultValue(3).min(1).max(60)
                                .hint("首次重试等待秒数，之后按 2/4/8 倍递增（另加 0~1 秒抖动），默认 3"))
                        .add(Configs.integer("zsxq.head-pages", "头部增量翻页数")
                                .defaultValue(2).min(1).max(10)
                                .hint("每轮从最新往回抓的页数（每页 20 条），碰到已同步帖子即停；默认 2，调小可降低请求量"))
                        .add(Configs.integer("zsxq.page-pause-seconds", "翻页间隔（秒）")
                                .defaultValue(8).min(1).max(120)
                                .hint("每次翻页请求前的等待秒数，另加 0~2 秒随机抖动；风控期间可调大到 30~60"))
                        .add(Configs.integer("zsxq.topic-pause-seconds", "话题/评论间隔（秒）")
                                .defaultValue(3).min(1).max(60)
                                .hint("每个话题、每次评论/图片请求后的等待秒数，另加 0~2 秒随机抖动"))
                        .add(Configs.bool("zsxq.refresh-old-comments", "补抓老帖新增评论")
                                .defaultValue(false)
                                .hint("已同步过的帖子评论数增加时是否补抓；关闭可显著减少请求量"))
                        .add(Configs.integer("zsxq.image-backfill-batch", "图片回填每轮帖子数")
                                .defaultValue(10).min(0).max(500)
                                .hint("每日历史回填作业处理的帖子数，默认 10；0 表示关闭图片回填"))
                        .add(Configs.integer("zsxq.column-article-backfill-batch", "专栏正文回填每轮条数")
                                .defaultValue(200).min(0).max(200)
                                .hint("每日历史回填作业处理的专栏完整正文条数，默认 200；0 表示关闭"))
                        .add(Configs.integer("zsxq.column-sync-interval-hours", "专栏同步间隔（小时）")
                                .defaultValue(24).min(1).max(168)
                                .hint("专栏列表与专栏话题的同步间隔，默认 24 小时；调小会增加接口请求量"))
                        .add(Configs.integer("zsxq.risk-cooldown-minutes", "风控冷却基数（分钟）")
                                .defaultValue(240).min(30).max(720)
                                .hint("触发风控（1059）或限流后暂停抓取的基数，默认 240；连续触发按 2/4/8 倍递增，最长 12 小时"))
        );
    }
}
