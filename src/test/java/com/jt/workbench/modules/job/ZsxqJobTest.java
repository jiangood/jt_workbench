package com.jt.workbench.modules.job;

import io.github.jiangood.openadmin.modules.job.JobDescription;
import org.junit.jupiter.api.Test;
import org.quartz.CronExpression;
import org.quartz.DisallowConcurrentExecution;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** 知识星球两个作业的调度与稳定性回归。 */
class ZsxqJobTest {

    @Test
    void incrementalSyncRunsEveryThirtyMinutes() {
        JobDescription description = ZsxqSyncJob.class.getAnnotation(JobDescription.class);
        assertNotNull(description);
        assertEquals("jt.zsxqSync", description.key());
        assertEquals("0 0/30 * * * ?", description.defaultCron());
        assertTrue(description.defaultEnabled());
        assertTrue(CronExpression.isValidExpression(description.defaultCron()));
        assertTrue(ZsxqSyncJob.class.isAnnotationPresent(DisallowConcurrentExecution.class));
    }

    @Test
    void historicalBackfillRunsDailyAtEight() {
        JobDescription description = ZsxqBackfillJob.class.getAnnotation(JobDescription.class);
        assertNotNull(description);
        assertEquals("jt.zsxqBackfill", description.key());
        assertEquals("0 0 8 * * ?", description.defaultCron());
        assertTrue(description.defaultEnabled());
        assertTrue(CronExpression.isValidExpression(description.defaultCron()));
        assertTrue(ZsxqBackfillJob.class.isAnnotationPresent(DisallowConcurrentExecution.class));
    }
}
