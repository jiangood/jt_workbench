package com.jt.workbench.modules.job;

import com.jt.workbench.modules.job.service.ZsxqSyncService;
import io.github.jiangood.openadmin.modules.job.BaseJob;
import io.github.jiangood.openadmin.modules.job.JobDescription;
import io.github.jiangood.openadmin.modules.job.JobResult;
import jakarta.annotation.Resource;
import org.quartz.JobDataMap;
import org.springframework.stereotype.Component;
import org.slf4j.Logger;

/**
 * 知识星球同步（每 3 小时）。
 *
 * <p>话题、专栏、历史图片回填已合并到同一作业；每次执行前先校验 token，token 失效时本轮直接跳过。</p>
 */
@Component
@JobDescription(
        key = "jt.zsxqSync",
        label = "知识星球同步",
        defaultCron = "0 0 0/3 * * ?",
        defaultEnabled = true
)
public class ZsxqSyncJob extends BaseJob {

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
