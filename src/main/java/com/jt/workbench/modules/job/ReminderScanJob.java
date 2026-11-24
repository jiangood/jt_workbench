package com.jt.workbench.modules.job;

import com.jt.workbench.modules.reminder.service.ReminderScanService;
import io.github.jiangood.openadmin.modules.job.BaseJob;
import io.github.jiangood.openadmin.modules.job.JobDescription;
import io.github.jiangood.openadmin.modules.job.JobResult;
import jakarta.annotation.Resource;
import org.quartz.JobDataMap;
import org.springframework.stereotype.Component;
import org.slf4j.Logger;

/** 提醒扫描（每 10 分钟）。 */
@Component
@JobDescription(
        key = "jt.reminderScan",
        label = "提醒扫描",
        defaultCron = "0 0/10 * * * ?",
        defaultEnabled = true
)
public class ReminderScanJob extends BaseJob {

    @Resource
    private ReminderScanService service;

    @Override
    public JobResult execute(JobDataMap data, Logger logger) {
        return service.scan(logger, this::progress);
    }
    /** 兼容当前框架版本缺失 BaseJob#progress(String) 的情况。 */
    protected void progress(String msg) {
        // no-op
    }
}
