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
 * 知识星球增量同步（每 30 分钟）。
 *
 * <p>只同步最新话题与到期专栏的增量；历史话题、专栏游标、图片及专栏文章完整正文回填
 * 由 {@link ZsxqBackfillJob} 独立执行。每次执行前先校验 Cookie，失效时本轮直接跳过。</p>
 */
@Component
@DisallowConcurrentExecution
@JobDescription(
        key = "jt.zsxqSync",
        label = "知识星球同步",
        defaultCron = "0 0/30 * * * ?",
        defaultEnabled = true
)
public class ZsxqSyncJob extends BaseJob {

    static final String JOB_KEY = "jt.zsxqSync";
    static final String DEFAULT_CRON = "0 0/30 * * * ?";
    static final String LEGACY_CRON = "0 0 0/3 * * ?";

    @Resource
    private ZsxqSyncService service;

    @Override
    public JobResult execute(JobDataMap data, Logger logger) {
        return service.syncAll(logger, this::progress);
    }
    /** 兼容当前框架版本缺失 BaseJob#progress(String) 的情况。 */
    protected void progress(String msg) {
        // no-op
    }
}
