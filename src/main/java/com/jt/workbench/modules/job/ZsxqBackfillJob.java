package com.jt.workbench.modules.job;

import com.jt.workbench.modules.job.service.ZsxqSyncService;
import io.github.jiangood.openadmin.modules.job.BaseJob;
import io.github.jiangood.openadmin.modules.job.JobDescription;
import io.github.jiangood.openadmin.modules.job.JobResult;
import jakarta.annotation.Resource;
import org.quartz.DisallowConcurrentExecution;
import org.quartz.JobDataMap;
import org.springframework.stereotype.Component;
import org.slf4j.Logger;

/**
 * 知识星球历史回填（每天 08:00）。
 *
 * <p>从已有游标连续翻到最早页，并回填专栏、历史图片与专栏文章元数据；
 * 不受单轮请求预算限制，风控中止后保留游标，次日从断点继续。</p>
 */
@Component
@DisallowConcurrentExecution
@JobDescription(
        key = "jt.zsxqBackfill",
        label = "知识星球历史回填",
        defaultCron = "0 0 8 * * ?",
        defaultEnabled = true
)
public class ZsxqBackfillJob extends BaseJob {

    static final String JOB_KEY = "jt.zsxqBackfill";
    static final String DEFAULT_CRON = "0 0 8 * * ?";

    @Resource
    private ZsxqSyncService service;

    @Override
    public JobResult execute(JobDataMap data, Logger logger) {
        return service.backfillAll(logger, this::progress);
    }

    /** 兼容当前框架版本缺失 BaseJob#progress(String) 的情况。 */
    protected void progress(String msg) {
        // no-op
    }
}
