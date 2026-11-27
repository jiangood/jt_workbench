package com.jt.workbench.modules.job;

import com.jt.workbench.modules.job.service.ZsxqTokenProbeService;
import io.github.jiangood.openadmin.modules.job.BaseJob;
import io.github.jiangood.openadmin.modules.job.JobDescription;
import io.github.jiangood.openadmin.modules.job.JobResult;
import jakarta.annotation.Resource;
import org.quartz.DisallowConcurrentExecution;
import org.quartz.JobDataMap;
import org.slf4j.Logger;
import org.springframework.stereotype.Component;

/**
 * 知识星球附件 token 模式探测（默认禁用，仅手动触发一次）。
 *
 * <p>验证用 zsxq_access_token 作为 App 端 authorization 能否换取附件下载地址；
 * 探测通过后把实现并入 ZsxqFileService 并删除本任务。</p>
 */
@Component
@DisallowConcurrentExecution
@JobDescription(
        key = "jt.zsxqTokenProbe",
        label = "知识星球附件Token探测",
        defaultCron = "0 0 4 * * ?",
        defaultEnabled = false
)
public class ZsxqTokenProbeJob extends BaseJob {

    @Resource
    private ZsxqTokenProbeService service;

    @Override
    public JobResult execute(JobDataMap data, Logger logger) {
        return service.probe(logger);
    }

    /** 兼容当前框架版本缺失 BaseJob#progress(String) 的情况。 */
    protected void progress(String msg) {
        // no-op
    }
}
