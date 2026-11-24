package com.jt.workbench.modules.job;

import com.jt.workbench.modules.job.service.NewsOldPruneService;
import io.github.jiangood.openadmin.modules.job.BaseJob;
import io.github.jiangood.openadmin.modules.job.JobDescription;
import io.github.jiangood.openadmin.modules.job.JobResult;
import jakarta.annotation.Resource;
import org.quartz.JobDataMap;
import org.slf4j.Logger;
import org.springframework.stereotype.Component;

/** 清理过期资讯（每 10 分钟）。 */
@Component
@JobDescription(
        key = "jt.newsOldPrune",
        label = "清理过期资讯",
        defaultCron = "0 0/10 * * * ?",
        defaultEnabled = true
)
public class NewsOldPruneJob extends BaseJob {

    @Resource
    private NewsOldPruneService service;

    @Override
    public JobResult execute(JobDataMap data, Logger logger) {
        return service.run(logger, this::progress);
    }
    /** 兼容当前框架版本缺失 BaseJob#progress(String) 的情况。 */
    protected void progress(String msg) {
        // no-op
    }
}
