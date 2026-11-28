package com.jt.workbench.modules.job;

import com.jt.workbench.modules.job.service.NewsAiSummaryService;
import io.github.jiangood.openadmin.modules.job.BaseJob;
import io.github.jiangood.openadmin.modules.job.JobDescription;
import io.github.jiangood.openadmin.modules.job.JobResult;
import jakarta.annotation.Resource;
import org.quartz.JobDataMap;
import org.slf4j.Logger;
import org.springframework.stereotype.Component;

/** 资讯 AI 摘要（每 5 分钟，小批量；可在系统参数 news.ai-summary.* 关闭或配置接口）。 */
@Component
@JobDescription(
        key = "jt.newsAiSummary",
        label = "资讯AI摘要",
        defaultCron = "0 0/5 * * * ?",
        defaultEnabled = true
)
public class NewsSummaryJob extends BaseJob {

    @Resource
    private NewsAiSummaryService service;

    @Override
    public JobResult execute(JobDataMap data, Logger logger) {
        return service.run(logger, this::progress);
    }

    /** 兼容当前框架版本缺失 BaseJob#progress(String) 的情况。 */
    protected void progress(String msg) {
        // no-op
    }
}
