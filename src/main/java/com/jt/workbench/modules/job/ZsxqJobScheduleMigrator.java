package com.jt.workbench.modules.job;

import io.github.jiangood.openadmin.modules.job.entity.SysJob;
import io.github.jiangood.openadmin.modules.job.repository.SysJobRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.CommandLineRunner;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;

/**
 * 把旧版知识星球同步任务的默认调度从每 3 小时迁移到每 30 分钟。
 *
 * <p>框架自动注册只补建任务、不覆盖已有配置，因此只修改仍使用旧默认 cron 的记录；
 * 用户手工调整过的 cron 保持不动。Quartz 会在随后的初始化中按新 cron 重新装载。</p>
 */
@Component
@Order(-1)
public class ZsxqJobScheduleMigrator implements CommandLineRunner {

    private static final Logger log = LoggerFactory.getLogger(ZsxqJobScheduleMigrator.class);

    private final SysJobRepository jobRepository;

    public ZsxqJobScheduleMigrator(SysJobRepository jobRepository) {
        this.jobRepository = jobRepository;
    }

    @Override
    @Transactional
    public void run(String... args) {
        SysJob job = jobRepository.findByJobKey(ZsxqSyncJob.JOB_KEY);
        if (job == null) {
            List<SysJob> legacy = jobRepository.findByJobClass(ZsxqSyncJob.class.getName()).stream()
                    .filter(item -> item.getJobKey() == null || item.getJobKey().isBlank())
                    .toList();
            if (legacy.size() == 1) job = legacy.getFirst();
        }
        if (job == null || !ZsxqSyncJob.class.getName().equals(job.getJobClass())) return;
        if (!ZsxqSyncJob.LEGACY_CRON.equals(job.getCron())) return;

        job.setCron(ZsxqSyncJob.DEFAULT_CRON);
        jobRepository.save(job);
        log.info("知识星球同步调度已迁移：{} -> {}（{}）",
                ZsxqSyncJob.LEGACY_CRON, ZsxqSyncJob.DEFAULT_CRON, job.getName());
    }
}
