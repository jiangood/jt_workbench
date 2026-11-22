package com.jt.workbench.modules.job;

import com.jt.workbench.modules.job.service.DbBackupService;
import io.github.jiangood.openadmin.modules.job.BaseJob;
import io.github.jiangood.openadmin.modules.job.JobDescription;
import io.github.jiangood.openadmin.modules.job.entity.JobLogAggregation;
import jakarta.annotation.Resource;
import org.quartz.JobDataMap;
import org.slf4j.Logger;
import org.springframework.stereotype.Component;

/** 数据库备份（每天 03:00，备份文件写入对象存储）。 */
@Component
@JobDescription(
        key = "jt.dbBackup",
        label = "数据库备份",
        defaultCron = "0 0 3 * * ?",
        defaultEnabled = true,
        logAggregation = JobLogAggregation.PER_RUN
)
public class DbBackupJob extends BaseJob {

    @Resource
    private DbBackupService service;

    @Override
    public String execute(JobDataMap data, Logger logger) {
        return service.backup(logger, this::progress);
    }
    /** 兼容当前框架版本缺失 BaseJob#progress(String) 的情况。 */
    protected void progress(String msg) {
        // no-op
    }
}
