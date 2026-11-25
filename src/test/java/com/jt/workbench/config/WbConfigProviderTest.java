package com.jt.workbench.config;

import io.github.jiangood.openadmin.framework.config.dynamic.ConfigSpec;
import org.junit.jupiter.api.Test;

import java.util.Set;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** 知识星球参数精简后不再暴露已废弃的预算与回填页数。 */
class WbConfigProviderTest {

    @Test
    void zsxqConfigRemovesObsoleteRunLimits() {
        Set<String> keys = new WbConfigProvider().define().getFirst().items().stream()
                .map(ConfigSpec::key)
                .collect(Collectors.toSet());

        assertFalse(keys.contains("zsxq.request-budget"));
        assertFalse(keys.contains("zsxq.backfill-pages"));
        assertTrue(keys.contains("zsxq.cookie"));
        assertTrue(keys.contains("zsxq.head-pages"));
        assertTrue(keys.contains("zsxq.page-pause-seconds"));
        assertTrue(keys.contains("zsxq.topic-pause-seconds"));
    }
}
