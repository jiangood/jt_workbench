package com.jt.workbench.modules.job;

import com.jt.workbench.modules.job.service.ZsxqQualityLabelService;
import io.github.jiangood.openadmin.modules.job.BaseJob;
import io.github.jiangood.openadmin.modules.job.JobDescription;
import io.github.jiangood.openadmin.modules.job.JobResult;
import jakarta.annotation.Resource;
import org.quartz.DisallowConcurrentExecution;
import org.quartz.JobDataMap;
import org.slf4j.Logger;
import org.springframework.stereotype.Component;

/**
 * 知识星球内容质量 AI 标注（默认关闭）。
 *
 * <p>对未标记话题调用可配置的 AI 接口判定 DRY/WATER，拿不准跳过。
 * 默认使用免 key 的 Pollinations OpenAI-compatible 接口，也可改为任意兼容接口。</p>
 */
@Component
@DisallowConcurrentExecution
@JobDescription(
        key = "jt.zsxqQualityLabel",
        label = "知识星球AI标注",
        defaultCron = "0 30 3 * * ?",
        defaultEnabled = false
)
public class ZsxqQualityLabelJob extends BaseJob {

    @Resource
    private ZsxqQualityLabelService service;

    @Override
    public JobResult execute(JobDataMap data, Logger logger) {
        return service.run(logger, this::progress);
    }

    /** 兼容当前框架版本缺失 BaseJob#progress(String) 的情况。 */
    protected void progress(String msg) {
        // no-op
    }
}
