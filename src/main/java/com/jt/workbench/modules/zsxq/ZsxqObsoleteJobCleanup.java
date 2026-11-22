package com.jt.workbench.modules.zsxq;

import io.github.jiangood.openadmin.modules.job.entity.SysJob;
import io.github.jiangood.openadmin.modules.job.entity.SysJobLog;
import io.github.jiangood.openadmin.modules.job.repository.SysJobLogRepository;
import io.github.jiangood.openadmin.modules.job.repository.SysJobRepository;
import io.github.jiangood.openadmin.modules.logviewer.service.FileLogService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.CommandLineRunner;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;

/**
 * 清理合并前遗留的知识星球定时任务记录。
 *
 * <p>「知识星球专栏同步」「知识星球图片回填」已并入「知识星球同步」，执行类已删除，
 * 但生产库的 {@code sys_job} 仍保留这两条记录（框架只告警不自动删除）。这里在 Quartz
 * 调度（{@code QuartzInitializer}，Order 1）之前按 key / 执行类删除记录及执行日志，
 * 避免任务页出现死条目、启动时反复报「执行类不存在」。</p>
 */
@Slf4j
@Component
@Order(-1)
@RequiredArgsConstructor
public class ZsxqObsoleteJobCleanup implements CommandLineRunner {

    private static final List<String> OBSOLETE_KEYS = List.of(
            "jt.zsxqColumnSync",
            "jt.zsxqImageBackfill");

    private static final List<String> OBSOLETE_CLASSES = List.of(
            "com.jt.workbench.modules.job.ZsxqColumnSyncJob",
            "com.jt.workbench.modules.job.ZsxqImageBackfillJob");

    private final SysJobRepository jobRepository;
    private final SysJobLogRepository jobLogRepository;
    private final FileLogService fileLogService;

    @Override
    @Transactional
    public void run(String... args) {
        try {
            for (String key : OBSOLETE_KEYS) {
                SysJob job = jobRepository.findByJobKey(key);
                if (job != null) remove(job);
            }
            for (String className : OBSOLETE_CLASSES) {
                for (SysJob job : jobRepository.findByJobClass(className)) {
                    remove(job);
                }
            }
        } catch (Exception e) {
            log.warn("知识星球旧定时任务清理跳过：{}", e.getMessage());
        }
    }

    private void remove(SysJob job) {
        String id = job.getId();
        for (SysJobLog jobLog : jobLogRepository.findBySysJobId(id)) {
            try {
                fileLogService.deleteLog("job/" + jobLog.getId());
            } catch (Exception e) {
                log.debug("删除旧任务日志文件失败 logId={}：{}", jobLog.getId(), e.getMessage());
            }
        }
        jobLogRepository.deleteBySysJobId(id);
        jobRepository.delete(job);
        log.info("已删除合并前的知识星球定时任务：{} [{}]", job.getName(), job.getJobClass());
    }
}
