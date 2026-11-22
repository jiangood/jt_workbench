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
                        .description("知识星球同步作业参数")
                        .add(Configs.string("zsxq.token", "API Token")
                                .asSecret()
                                .hint("知识星球网页端 Cookie 中的 zsxq_access_token"))
                        .add(Configs.integer("zsxq.image-backfill-batch", "图片回填每轮帖子数")
                                .defaultValue(100).min(1).max(500)
                                .hint("知识星球同步作业每轮回填的历史帖子数，默认 100；作业每 3 小时执行一次，调小可降低星球接口压力"))
                        .add(Configs.integer("zsxq.column-sync-interval-hours", "专栏同步间隔（小时）")
                                .defaultValue(24).min(1).max(168)
                                .hint("专栏列表与专栏话题的同步间隔，默认 24 小时；调小会增加接口请求量"))
                        .add(Configs.integer("zsxq.risk-cooldown-minutes", "风控冷却基数（分钟）")
                                .defaultValue(240).min(30).max(720)
                                .hint("触发风控（1059）或限流后暂停抓取的基数，默认 240；连续触发按 2/4/8 倍递增，最长 12 小时"))
        );
    }
}
