package com.jt.workbench.modules.job;

import io.github.jiangood.openadmin.modules.job.entity.SysJob;
import io.github.jiangood.openadmin.modules.job.repository.SysJobRepository;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/** 只迁移旧默认 cron，不覆盖用户手工调整过的调度。 */
class ZsxqBackfillScheduleMigratorTest {

    private final SysJobRepository repository = mock(SysJobRepository.class);
    private final ZsxqBackfillScheduleMigrator migrator = new ZsxqBackfillScheduleMigrator(repository);

    @Test
    void migratesLegacyDefaultCron() {
        SysJob job = job(ZsxqBackfillJob.LEGACY_CRON);
        when(repository.findByJobKey(ZsxqBackfillJob.JOB_KEY)).thenReturn(job);

        migrator.run();

        assertEquals(ZsxqBackfillJob.DEFAULT_CRON, job.getCron());
        verify(repository).save(job);
    }

    @Test
    void keepsCustomizedCron() {
        SysJob job = job("0 15 8 * * ?");
        when(repository.findByJobKey(ZsxqBackfillJob.JOB_KEY)).thenReturn(job);

        migrator.run();

        assertEquals("0 15 8 * * ?", job.getCron());
        verify(repository, never()).save(job);
    }

    private static SysJob job(String cron) {
        SysJob job = new SysJob();
        job.setId("backfill");
        job.setName("知识星球历史回填");
        job.setJobKey(ZsxqBackfillJob.JOB_KEY);
        job.setJobClass(ZsxqBackfillJob.class.getName());
        job.setCron(cron);
        job.setEnabled(true);
        return job;
    }
}
