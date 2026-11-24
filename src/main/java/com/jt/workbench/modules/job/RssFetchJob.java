package com.jt.workbench.modules.job;

import com.jt.workbench.modules.job.service.RssFetchService;
import io.github.jiangood.openadmin.modules.job.BaseJob;
import io.github.jiangood.openadmin.modules.job.JobDescription;
import io.github.jiangood.openadmin.modules.job.JobResult;
import jakarta.annotation.Resource;
import org.quartz.JobDataMap;
import org.springframework.stereotype.Component;
import org.slf4j.Logger;

/** RSS/Atom 抓取（每 20 分钟）。 */
@Component
@JobDescription(
        key = "jt.rssFetch",
        label = "RSS 抓取",
        defaultCron = "0 0/20 * * * ?",
        defaultEnabled = true
)
public class RssFetchJob extends BaseJob {

    @Resource
    private RssFetchService service;

    @Override
    public JobResult execute(JobDataMap data, Logger logger) {
        return service.fetchAll(logger, this::progress);
    }
    /** 兼容当前框架版本缺失 BaseJob#progress(String) 的情况。 */
    protected void progress(String msg) {
        // no-op
    }
}
