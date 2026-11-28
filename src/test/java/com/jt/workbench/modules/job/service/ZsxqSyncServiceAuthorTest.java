package com.jt.workbench.modules.job.service;

import com.jt.workbench.modules.zsxq.client.ZsxqModels.TalkContent;
import com.jt.workbench.modules.zsxq.client.ZsxqModels.Topic;
import com.jt.workbench.modules.zsxq.client.ZsxqModels.User;
import com.jt.workbench.modules.zsxq.entity.ZsxqTopic;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.PreparedStatementSetter;
import org.springframework.jdbc.core.ResultSetExtractor;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/** 历史脏数据：作者为空时仍要尝试从话题详情补齐作者名和作者 ID。 */
class ZsxqSyncServiceAuthorTest {

    @Test
    void topicAuthorFallsBackToTopLevelOwnerWhenTalkOwnerNameIsBlank() {
        Topic topic = new Topic();
        topic.talk = new TalkContent();
        User talkOwner = new User();
        talkOwner.name = "";
        talkOwner.userId = "111";
        topic.talk.owner = talkOwner;
        User topOwner = new User();
        topOwner.name = "作者A";
        topOwner.userId = "222";
        topic.owner = topOwner;

        assertEquals("作者A", ZsxqSyncService.topicAuthor(topic));
        assertEquals("111", ZsxqSyncService.topicAuthorId(topic));
    }

    @Test
    @SuppressWarnings({"unchecked", "rawtypes"})
    void fillAuthorIfMissingDoesNotSkipAnonymousRowsAndBackfillsAuthorId() {
        JdbcTemplate jdbc = mock(JdbcTemplate.class);
        // 附件清单已确认：fillFilesIfMissing 直接返回，不触发附件写入
        when(jdbc.query(anyString(), any(PreparedStatementSetter.class), any(ResultSetExtractor.class)))
                .thenReturn(1L);
        ZsxqSyncService service = new ZsxqSyncService(null, null, null, null, null, jdbc);

        Topic topic = new Topic();
        topic.talk = new TalkContent();
        User owner = new User();
        owner.name = ""; // 只有 user_id，没有作者名
        owner.userId = "582214118155584";
        topic.talk.owner = owner;

        ZsxqTopic local = new ZsxqTopic();
        local.setTopicId("topic-1");
        local.setGroupId("group-1");
        local.setAuthor("");
        local.setAuthorId("");

        service.fillAuthorIfMissing("topic-1", topic, local);

        verify(jdbc).update(anyString(),
                eq(""), eq(""),
                eq("582214118155584"), eq("582214118155584"),
                eq("topic-1"));
    }

    @Test
    @SuppressWarnings({"unchecked", "rawtypes"})
    void fillAuthorIfMissingPreservesExistingValuesAndDoesNotOverwriteWithEmpty() {
        JdbcTemplate jdbc = mock(JdbcTemplate.class);
        when(jdbc.query(anyString(), any(PreparedStatementSetter.class), any(ResultSetExtractor.class)))
                .thenReturn(1L);
        ZsxqSyncService service = new ZsxqSyncService(null, null, null, null, null, jdbc);

        Topic topic = new Topic();
        // 来源无 owner：不能用空值覆盖已有 author/author_id
        ZsxqTopic local = new ZsxqTopic();
        local.setTopicId("topic-1");
        local.setGroupId("group-1");
        local.setAuthor("");
        local.setAuthorId("existing-author-id");

        service.fillAuthorIfMissing("topic-1", topic, local);

        // author_id 已存在、来源无新信息：不再写库
        verify(jdbc, org.mockito.Mockito.never()).update(anyString(), any(), any(), any(), any(), any());
    }
}
