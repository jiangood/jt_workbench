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
class ZsxqJobScheduleMigratorTest {

    private final SysJobRepository repository = mock(SysJobRepository.class);
    private final ZsxqJobScheduleMigrator migrator = new ZsxqJobScheduleMigrator(repository);

    @Test
    void migratesLegacyDefaultCron() {
        SysJob job = job(ZsxqSyncJob.LEGACY_CRON);
        when(repository.findByJobKey(ZsxqSyncJob.JOB_KEY)).thenReturn(job);

        migrator.run();

        assertEquals(ZsxqSyncJob.DEFAULT_CRON, job.getCron());
        verify(repository).save(job);
    }

    @Test
    void keepsCustomizedCron() {
        SysJob job = job("0 15 8 * * ?");
        when(repository.findByJobKey(ZsxqSyncJob.JOB_KEY)).thenReturn(job);

        migrator.run();

        assertEquals("0 15 8 * * ?", job.getCron());
        verify(repository, never()).save(job);
    }

    private static SysJob job(String cron) {
        SysJob job = new SysJob();
        job.setId("sync");
        job.setName("知识星球同步");
        job.setJobKey(ZsxqSyncJob.JOB_KEY);
        job.setJobClass(ZsxqSyncJob.class.getName());
        job.setCron(cron);
        job.setEnabled(true);
        return job;
    }
}
