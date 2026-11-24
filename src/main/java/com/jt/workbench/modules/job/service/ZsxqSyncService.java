package com.jt.workbench.modules.job.service;

import com.jt.workbench.modules.zsxq.entity.ZsxqColumn;
import com.jt.workbench.modules.zsxq.entity.ZsxqTopic;
import com.jt.workbench.modules.zsxq.repo.ZsxqColumnRepository;
import com.jt.workbench.modules.zsxq.repo.ZsxqTopicRepository;
import com.jt.workbench.modules.zsxq.service.ZsxqImageService;
import com.zsxq.sdk.client.ZsxqClient;
import com.zsxq.sdk.client.ZsxqClientBuilder;
import com.zsxq.sdk.exception.AuthException;
import com.zsxq.sdk.exception.TokenExpiredException;
import com.zsxq.sdk.exception.TokenInvalidException;
import com.zsxq.sdk.exception.ZsxqException;
import com.zsxq.sdk.model.Column;
import com.zsxq.sdk.model.Comment;
import com.zsxq.sdk.model.Group;
import com.zsxq.sdk.model.Image;
import com.zsxq.sdk.model.TalkContent;
import com.zsxq.sdk.model.Topic;
import com.zsxq.sdk.request.TopicsRequest.ListCommentsOptions;
import com.zsxq.sdk.request.TopicsRequest.ListTopicsOptions;
import io.github.jiangood.openadmin.modules.config.service.SysConfigService;
import io.github.jiangood.openadmin.modules.job.JobResult;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.slf4j.Logger;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.ThreadLocalRandom;

/**
 * 知识星球同步。
 *
 * <p>单一作业入口 {@link #syncAll}：每次执行先用星球列表接口校验 token，再依次完成
 * 话题增量回溯（end_time 翻页 + topic_id 去重）→ 评论抓取 → 专栏增量 → 历史图片回填，落
 * zsxq_group / zsxq_topic / zsxq_comment / zsxq_sync_state。保留旧库的幂等键与游标语义，
 * 不做完整请求预算/删除探测（旧版高级对账逻辑可在后续迭代补齐）。</p>
 *
 * <p>token 失效或校验异常时本轮直接结束并返回提示，不再发起后续抓取，避免过期 token 持续刷失败日志。</p>
 *
 * <p>评论接口报「主题已被删除」（15403 或删除类文案）时，把该帖标记为软删除（visible=false），
 * 后续同步不再为其请求评论。</p>
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class ZsxqSyncService {

    private static final int MAX_GROUPS = 20;
    /** 头部增量最多翻页数（从最新往回，遇到已存在帖子即停；用于补抓停机期间的新帖）。 */
    private static final int MAX_HEAD_PAGES_PER_GROUP = 10;
    /** 每轮历史回填最多翻页数（从游标继续向更早翻）。 */
    private static final int MAX_PAGES_PER_GROUP = 5;
    private static final int MAX_HEAD_PAGES_PER_COLUMN = 5;
    private static final int MAX_PAGES_PER_COLUMN = 5;
    private static final int TOPICS_PER_PAGE = 20;
    private static final int COMMENTS_PER_TOPIC = 30;
    private static final int COLUMN_NAME_MAX_LENGTH = 512;
    private static final int COLUMN_TEXT_MAX_LENGTH = 2048;
    private static final int IMAGE_BACKFILL_DEFAULT_BATCH = 100;
    private static final int IMAGE_BACKFILL_MAX_FAILS = 3;

    /** 抓取间隔（反爬）：每次分页抓取请求前等待几秒。 */
    private static final long PAUSE_BEFORE_PAGE_FETCH_MS = 4000;
    /** 抓取间隔（反爬）：每个话题处理、每次评论抓取后等待几秒。 */
    private static final long PAUSE_BETWEEN_TOPIC_FETCHES_MS = 2000;
    /** 在固定间隔上叠加的随机抖动，避免请求节奏过于规律（0~2 秒）。 */
    private static final long PAUSE_JITTER_MS = 2000;

    /** 评论接口业务码：主题已经被删除 */
    private static final int CODE_TOPIC_GONE = 15403;
    /** 知识星球风控/非官方工具拦截 */
    private static final int CODE_RISK_CONTROL = 1059;
    /** 知识星球限流 */
    private static final int CODE_RATE_LIMIT = 40001;
    private static final java.util.regex.Pattern GONE_MESSAGE = java.util.regex.Pattern.compile(
            "已被删除|已删除|被删除|不存在|not\\s*found|not\\s*exist|deleted",
            java.util.regex.Pattern.CASE_INSENSITIVE);

    /** 风控冷却：第 1 次触发冷却 4 小时，连续触发翻倍，最长 12 小时。 */
    private static final int RISK_COOLDOWN_DEFAULT_MINUTES = 240;
    private static final int RISK_COOLDOWN_MAX_MINUTES = 720;
    private static final int RISK_STRIKE_MAX = 3;

    /** 专栏同步默认间隔（小时）：专栏结构变化慢，降低频率可显著减少请求量。 */
    private static final int COLUMN_SYNC_DEFAULT_HOURS = 24;

    private static final String STATE_RISK_UNTIL = "risk_until";
    private static final String STATE_RISK_STRIKES = "risk_strikes";
    private static final String STATE_RISK_TOKEN_HASH = "risk_token_hash";
    private static final String STATE_COLUMNS_LAST_OK = "columns_last_ok";

    private final SysConfigService configService;
    private final ZsxqTopicRepository topicRepository;
    private final ZsxqColumnRepository columnRepository;
    private final ZsxqImageService imageService;
    private final JdbcTemplate jdbc;

    /**
     * 同步入口（定时任务唯一调用点）。
     *
     * <p>先用星球列表接口校验 token，再依次执行话题、专栏（按间隔）、历史图片回填。
     * 任一步触发风控（1059）或限流（40001）会立即中止本轮并进入冷却，避免持续请求加重风控。</p>
     */
    public JobResult syncAll(Logger logger, java.util.function.Consumer<String> progress) {
        String token = configService.getString("zsxq.token");
        if (token == null || token.isBlank()) return JobResult.skip("未配置知识星球 token，跳过");
        ensureTables();
        resetCooldownOnTokenChange(token);

        String cooling = cooldownMessage();
        if (cooling != null) return JobResult.skip(cooling);

        ZsxqClient client = buildClient(token);
        progress.accept("校验 token");
        try {
            List<Group> remoteGroups;
            try {
                remoteGroups = api("client.groups().list()", () -> client.groups().list());
            } catch (Exception e) {
                if (isRiskControl(e)) throw new RiskControlException(e);
                logger.warn("知识星球 token 校验失败：{}", e.getMessage());
                return JobResult.fail(tokenErrorText(e));
            }

            List<String> groupIds = resolveGroupIds(remoteGroups);
            log.info("[知识星球] 本轮同步开始：{} 个星球", groupIds.size());
            List<String> parts = new ArrayList<>();
            parts.add(syncTopics(client, groupIds, logger, progress));
            parts.add(syncColumnsIfDue(client, groupIds, logger, progress));
            parts.add(backfillImages(client, logger, progress));

            // 本轮完整跑通（未触发风控）：清除连续风控计数
            setState(STATE_RISK_STRIKES, 0);
            String overview = String.join("；", parts);
            log.info("[知识星球] 本轮概览：{}", overview);
            return JobResult.ok(overview);
        } catch (RiskControlException e) {
            return JobResult.fail(enterRiskCooldown(logger, e));
        }
    }

    /** 专栏按配置间隔执行（默认 24 小时）；没到间隔时不发任何星球请求。 */
    private String syncColumnsIfDue(ZsxqClient client, List<String> groupIds, Logger logger,
                                    java.util.function.Consumer<String> progress) {
        int hours = configService.getInt("zsxq.column-sync-interval-hours");
        if (hours <= 0) hours = COLUMN_SYNC_DEFAULT_HOURS;
        long intervalMs = hours * 3_600_000L;
        Long lastOk = getState(STATE_COLUMNS_LAST_OK);
        long now = System.currentTimeMillis();
        if (lastOk != null && now - lastOk < intervalMs) {
            long remainHours = Math.max(1, (intervalMs - (now - lastOk) + 3_599_999) / 3_600_000);
            return "专栏同步跳过（约 " + remainHours + " 小时后到期）";
        }
        String result = syncColumns(client, groupIds, logger, progress);
        setState(STATE_COLUMNS_LAST_OK, System.currentTimeMillis());
        return result;
    }

    /** token 更换后说明用户已重新登录/修复配置：清空风控冷却，立即允许重试。 */
    private void resetCooldownOnTokenChange(String token) {
        long hash = Integer.toUnsignedLong(token.hashCode());
        Long lastHash = getState(STATE_RISK_TOKEN_HASH);
        if (lastHash != null && lastHash != hash) {
            setState(STATE_RISK_UNTIL, 0);
            setState(STATE_RISK_STRIKES, 0);
        }
        if (lastHash == null || lastHash != hash) {
            setState(STATE_RISK_TOKEN_HASH, hash);
        }
    }

    /** 当前是否处于风控冷却期；是则返回任务结果提示。 */
    private String cooldownMessage() {
        Long until = getState(STATE_RISK_UNTIL);
        long now = System.currentTimeMillis();
        if (until == null || until <= now) return null;
        long minutes = Math.max(1, (until - now + 59_999) / 60_000);
        return "知识星球风控冷却中，本轮跳过（约 " + minutes + " 分钟后重试）";
    }

    /** 触发风控：按连续次数指数退避，写冷却截止时间，并返回任务结果。 */
    private String enterRiskCooldown(Logger logger, RiskControlException e) {
        int base = configService.getInt("zsxq.risk-cooldown-minutes");
        if (base <= 0) base = RISK_COOLDOWN_DEFAULT_MINUTES;
        Long strikesRaw = getState(STATE_RISK_STRIKES);
        int strikes = Math.min((strikesRaw == null ? 0 : strikesRaw.intValue()) + 1, RISK_STRIKE_MAX);
        long minutes = Math.min((long) base << (strikes - 1), RISK_COOLDOWN_MAX_MINUTES);
        setState(STATE_RISK_STRIKES, strikes);
        setState(STATE_RISK_UNTIL, System.currentTimeMillis() + minutes * 60_000L);
        logger.warn("知识星球触发风控（{}），本轮中止，冷却 {} 分钟（连续第 {} 次）",
                e.getMessage(), minutes, strikes);
        return "触发知识星球风控，本轮中止；冷却 " + minutes + " 分钟后再试（连续第 " + strikes + " 次）";
    }

    /** 风控/限流：本轮立即中止，不重试、不计入单帖失败次数。 */
    private static boolean isRiskControl(Exception e) {
        if (!(e instanceof ZsxqException zsxq)) return false;
        int code = zsxq.getCode();
        return code == CODE_RISK_CONTROL || code == CODE_RATE_LIMIT;
    }

    /** 内部信号：把风控异常从各阶段抛出到 {@link #syncAll} 统一处理。 */
    private static class RiskControlException extends RuntimeException {
        RiskControlException(Exception cause) {
            super(cause.getMessage(), cause);
        }
    }

    /**
     * token 校验失败时的任务结果提示。
     *
     * <p>校验用 {@code /v2/groups} 而不是 {@code /v3/users/self}：后者对网页端 token 常返回
     * 「设备状态异常」（1059，绑定浏览器设备），且 SDK 因响应字段是 {@code succeed} 而不会抛错，
     * 不能用于判断有效性。</p>
     */
    private static String tokenErrorText(Exception e) {
        if (e instanceof TokenInvalidException || e instanceof TokenExpiredException) {
            return "知识星球 token 已失效，请更新系统参数 zsxq.token";
        }
        if (e instanceof AuthException auth) {
            return "知识星球 token 鉴权失败（code=" + auth.getCode() + "），请检查账号权限";
        }
        if (e instanceof ZsxqException zsxq) {
            int code = zsxq.getCode();
            if (code == 401) return "知识星球 token 已失效（401 Unauthorized），请更新系统参数 zsxq.token";
            if (code == CODE_RISK_CONTROL) return "知识星球拒绝了本次访问（code=1059），可能触发非官方工具风控，请稍后重试";
            return "知识星球 token 校验失败（code=" + code + "）：" + zsxq.getMessage();
        }
        return "知识星球 token 校验失败：" + e.getMessage();
    }

    private String syncTopics(ZsxqClient client, List<String> groupIds, Logger logger,
                              java.util.function.Consumer<String> progress) {
        if (groupIds.isEmpty()) return "话题同步跳过（没有可用星球）";

        int topics = 0, comments = 0, skipped = 0, groupsDone = 0;
        for (int gi = 0; gi < groupIds.size(); gi++) {
            String gid = groupIds.get(gi);
            progress.accept("同步星球 " + (gi + 1) + "/" + groupIds.size());

            // 1) 头部增量：从最新往回抓，直到碰到上一轮已同步过的帖子（覆盖停机期间的新帖）
            String headOldest = "";
            String headEnd = "";
            java.util.Set<String> insertedInHead = new java.util.HashSet<>();
            for (int page = 0; page < MAX_HEAD_PAGES_PER_GROUP; page++) {
                pause(PAUSE_BEFORE_PAGE_FETCH_MS);
                List<Topic> list;
                try {
                    ListTopicsOptions options = new ListTopicsOptions()
                            .count(TOPICS_PER_PAGE)
                            .scope("all");
                    if (!headEnd.isEmpty()) options.endTime(headEnd);
                    list = api("client.topics().list(groupId=" + gid + ", endTime=" + headEnd + ")",
                            () -> client.topics().list(gid, options));
                } catch (Exception e) {
                    if (isRiskControl(e)) throw new RiskControlException(e);
                    logger.warn("星球 {} 最新话题拉取失败：{}", gid, e.getMessage());
                    break;
                }
                if (list == null || list.isEmpty()) break;
                int existingOnPage = 0;
                for (Topic t : list) {
                    String tid = toStr(t.getTopicId());
                    if (tid.isEmpty()) continue;
                    String createTime = safe(t.getCreateTime());
                    if (!createTime.isEmpty()) {
                        headOldest = createTime;
                        headEnd = createTime;
                    }

                    java.util.Optional<ZsxqTopic> existing = topicRepository.findByTopicId(tid);
                    if (existing.isPresent()) {
                        skipped++;
                        // end_time 边界会重复返回上一页最后一条；本轮刚插入的不算“已追平”
                        if (!insertedInHead.contains(tid)) existingOnPage++;
                        fillAuthorIfMissing(tid, t, existing.get());
                        comments += refreshCommentsIfGrown(client, gid, t, existing.get(), logger);
                        continue;
                    }
                    pause(PAUSE_BETWEEN_TOPIC_FETCHES_MS);
                    upsertTopic(gid, tid, t, null);
                    topics++;
                    insertedInHead.add(tid);
                    if (safeInt(t.getCommentsCount()) > 0) comments += fetchComments(client, gid, tid, logger);
                }
                // 碰到已存在的帖子说明已接上上一轮位置；否则继续向更早翻，补抓停机期间的新帖
                if (existingOnPage > 0 || list.size() < TOPICS_PER_PAGE) break;
            }

            // 2) 历史回填：从游标继续向更早翻页；首次同步用头部最旧时间初始化游标，避免重复抓最新页
            String end = cursor(gid);
            if (end.isEmpty() && !headOldest.isEmpty()) {
                end = headOldest;
                saveCursor(gid, end);
            }
            for (int page = 0; page < MAX_PAGES_PER_GROUP; page++) {
                if (end.isEmpty()) break;
                pause(PAUSE_BEFORE_PAGE_FETCH_MS);
                List<Topic> list;
                try {
                    final String endTime = end;
                    list = api("client.topics().list(groupId=" + gid + ", endTime=" + endTime + ")",
                            () -> client.topics().list(gid, new ListTopicsOptions()
                                    .count(TOPICS_PER_PAGE)
                                    .scope("all")
                                    .endTime(endTime)));
                } catch (Exception e) {
                    if (isRiskControl(e)) throw new RiskControlException(e);
                    logger.warn("星球 {} 历史话题拉取失败：{}", gid, e.getMessage());
                    break;
                }
                if (list == null || list.isEmpty()) break;
                String before = end;
                int newOnPage = 0;
                for (Topic t : list) {
                    String tid = toStr(t.getTopicId());
                    if (tid.isEmpty()) continue;
                    java.util.Optional<ZsxqTopic> existing = topicRepository.findByTopicId(tid);
                    if (existing.isPresent()) {
                        skipped++;
                        fillAuthorIfMissing(tid, t, existing.get());
                        String createTime = safe(t.getCreateTime());
                        if (!createTime.isEmpty()) end = createTime;
                        continue;
                    }
                    pause(PAUSE_BETWEEN_TOPIC_FETCHES_MS);
                    upsertTopic(gid, tid, t, null);
                    topics++;
                    newOnPage++;
                    if (safeInt(t.getCommentsCount()) > 0) comments += fetchComments(client, gid, tid, logger);
                    String createTime = safe(t.getCreateTime());
                    if (!createTime.isEmpty()) end = createTime;
                }
                saveCursor(gid, end);
                // 同一时间戳导致游标没有前进且整页重复时，避免下轮原地打转
                if (newOnPage == 0 && end.equals(before)) break;
            }
            groupsDone++;
        }
        return "话题同步：" + groupsDone + " 个星球，新话题 " + topics + " 条，评论 "
                + comments + " 条，跳过已存在 " + skipped + " 条";
    }

    /**
     * 老数据补齐作者信息：列表接口本身带 owner，历史帖子（作者名/ID 缺失）在回填翻页时顺带补齐，
     * 保证“只看星主”能覆盖存量数据。
     */
    private void fillAuthorIfMissing(String tid, Topic t, ZsxqTopic local) {
        if (local == null) return;
        boolean missingName = safe(local.getAuthor()).isEmpty();
        boolean missingId = safe(local.getAuthorId()).isEmpty();
        if (!missingName && !missingId) return;
        TalkContent talk = t.getTalk();
        if (talk == null || talk.getOwner() == null) return;
        String author = safe(talk.getOwner().getName());
        if (author.isEmpty()) return;
        String authorId = normalizeId(talk.getOwner().getUserId());
        jdbc.update("UPDATE zsxq_topic SET author = ?, author_id = ? WHERE topic_id = ?", author, authorId, tid);
    }

    /**
     * 头部页里已存在的话题，如果接口返回的评论数比本地多，补抓一次评论并更新计数。
     * 这样星主/成员在旧帖下的新回复也能持续同步（评论按 comment_id 幂等去重）。
     */
    private int refreshCommentsIfGrown(ZsxqClient client, String gid, Topic remote, ZsxqTopic local, Logger logger) {
        int remoteCount = safeInt(remote.getCommentsCount());
        int localCount = safeInt(local.getCommentCount());
        if (remoteCount <= localCount) return 0;
        String tid = toStr(remote.getTopicId());
        int added = fetchComments(client, gid, tid, logger);
        jdbc.update("UPDATE zsxq_topic SET comment_count = ?, update_time = ? WHERE topic_id = ?",
                remoteCount, LocalDateTime.now(), tid);
        return added;
    }

    /**
     * 同步知识星球专栏及其话题。
     *
     * <p>逐个星球拉取专栏列表，再按专栏游标增量拉取话题；已存在的普通话题只补写 column_id，
     * 不重复插入。专栏被删除时标记 visible=false，保留历史内容。</p>
     */
    private String syncColumns(ZsxqClient client, List<String> groupIds, Logger logger,
                               java.util.function.Consumer<String> progress) {
        if (groupIds.isEmpty()) return "专栏同步跳过（没有可用星球）";

        int columnsDone = 0, topics = 0, comments = 0, skipped = 0, groupsDone = 0;
        for (int gi = 0; gi < groupIds.size(); gi++) {
            String gid = groupIds.get(gi);
            progress.accept("同步星球专栏 " + (gi + 1) + "/" + groupIds.size());
            pause(PAUSE_BEFORE_PAGE_FETCH_MS);
            List<Column> columns;
            try {
                columns = api("client.groups().getColumns(groupId=" + gid + ")", () -> client.groups().getColumns(gid));
            } catch (Exception e) {
                if (isRiskControl(e)) throw new RiskControlException(e);
                logger.warn("星球 {} 专栏列表拉取失败：{}", gid, e.getMessage());
                continue;
            }
            if (columns == null || columns.isEmpty()) {
                groupsDone++;
                continue;
            }
            List<String> seenColumnIds = new ArrayList<>();
            for (Column c : columns) {
                String cid = toStr(c.getColumnId());
                if (cid.isEmpty()) continue;
                seenColumnIds.add(cid);
                ZsxqColumn column = upsertColumn(gid, cid, c);
                int[] result = syncColumnTopics(client, column, logger);
                topics += result[0];
                comments += result[1];
                skipped += result[2];
                columnsDone++;
                pause(PAUSE_BETWEEN_TOPIC_FETCHES_MS);
            }
            markMissingColumns(gid, seenColumnIds);
            groupsDone++;
        }
        return "专栏同步：" + groupsDone + " 个星球的 " + columnsDone + " 个专栏，新话题 " + topics
                + " 条，评论 " + comments + " 条，跳过已存在 " + skipped + " 条";
    }

    /**
     * 回填历史帖子的图片：按发帖时间从新到旧逐帖调用话题详情，下载图片到对象存储，
     * 并写入 {@code images}/{@code cover}。每轮条数由系统参数 {@code zsxq.image-backfill-batch} 控制。
     *
     * <p>token 失效等致命错误会立即中止本轮，避免把后续帖子误记成失败；帖子已删除则标记为
     * 空图片列表并结束该帖，不再重试。</p>
     */
    private String backfillImages(ZsxqClient client, Logger logger,
                                  java.util.function.Consumer<String> progress) {
        int batch = configService.getInt("zsxq.image-backfill-batch");
        if (batch <= 0) batch = IMAGE_BACKFILL_DEFAULT_BATCH;
        List<java.util.Map<String, Object>> rows = jdbc.queryForList(
                "SELECT topic_id FROM zsxq_topic WHERE (visible IS NULL OR visible = TRUE) AND image_synced_at IS NULL "
                        + "AND COALESCE(image_fail_count, 0) < " + IMAGE_BACKFILL_MAX_FAILS
                        + " ORDER BY COALESCE(source_create_time, '') DESC LIMIT " + batch);
        if (rows.isEmpty()) return "图片回填跳过（没有待回填图片的帖子）";

        int done = 0, failed = 0, stored = 0;
        for (int i = 0; i < rows.size(); i++) {
            java.util.Map<String, Object> row = rows.get(i);
            // H2 返回大写列名，MySQL 可能返回小写，两种都兼容
            String tid = toStr(row.containsKey("TOPIC_ID") ? row.get("TOPIC_ID") : row.get("topic_id"));
            if (tid.isBlank()) continue;
            progress.accept("回填图片 " + (i + 1) + "/" + rows.size());
            pause(PAUSE_BETWEEN_TOPIC_FETCHES_MS);
            try {
                Topic topic = api("client.topics().get(topicId=" + tid + ")", () -> client.topics().get(tid));
                TalkContent talk = topic == null ? null : topic.getTalk();
                List<String> keys = imageService.storeAll(tid, talk);
                boolean complete = keys.size() >= imageService.sourceImageCount(talk);
                saveTopicImages(tid, keys, complete);
                stored += keys.size();
                if (complete) done++; else failed++;
            } catch (Exception e) {
                // 风控/限流不是单帖问题：立即中止本轮，且不累计图片失败次数
                if (isRiskControl(e)) throw new RiskControlException(e);
                if (isTopicGone(e)) {
                    saveTopicImages(tid, List.of(), true);
                    done++;
                    logger.info("帖子已删除，图片回填跳过 topicId={}", tid);
                    continue;
                }
                failed++;
                markImageFailed(tid);
                logger.warn("图片回填失败 topicId={} error={}", tid, e.getMessage());
                if (isAuthOrFatal(e)) {
                    logger.warn("知识星球授权/请求异常，中止本轮图片回填");
                    break;
                }
            }
        }
        return "图片回填 " + done + " 条，失败 " + failed + " 条，入库图片 " + stored + " 张";
    }

    /** 写回帖子图片列表；complete=false 时保留待回填状态并累计失败次数，下轮重试。 */
    private void saveTopicImages(String topicId, List<String> keys, boolean complete) {
        String json = imageService.toJson(keys);
        String cover = keys.isEmpty() ? null : keys.get(0);
        if (complete) {
            if (cover == null) {
                jdbc.update("UPDATE zsxq_topic SET images = ?, image_synced_at = ?, image_fail_count = 0, "
                                + "update_time = ? WHERE topic_id = ?",
                        json, System.currentTimeMillis(), LocalDateTime.now(), topicId);
            } else {
                jdbc.update("UPDATE zsxq_topic SET images = ?, cover = ?, image_synced_at = ?, image_fail_count = 0, "
                                + "update_time = ? WHERE topic_id = ?",
                        json, cover, System.currentTimeMillis(), LocalDateTime.now(), topicId);
            }
        } else if (cover == null) {
            jdbc.update("UPDATE zsxq_topic SET images = ?, image_fail_count = COALESCE(image_fail_count, 0) + 1, "
                    + "update_time = ? WHERE topic_id = ?", json, LocalDateTime.now(), topicId);
        } else {
            jdbc.update("UPDATE zsxq_topic SET images = ?, cover = ?, "
                            + "image_fail_count = COALESCE(image_fail_count, 0) + 1, update_time = ? WHERE topic_id = ?",
                    json, cover, LocalDateTime.now(), topicId);
        }
    }

    private void markImageFailed(String topicId) {
        jdbc.update("UPDATE zsxq_topic SET image_fail_count = COALESCE(image_fail_count, 0) + 1, "
                + "update_time = ? WHERE topic_id = ?", LocalDateTime.now(), topicId);
    }

    /** 星球侧已不存在的专栏软删除，保留历史话题。 */
    private void markMissingColumns(String groupId, List<String> seenColumnIds) {
        try {
            List<ZsxqColumn> local = columnRepository.findByGroupIdOrderByName(groupId);
            for (ZsxqColumn column : local) {
                if (!seenColumnIds.contains(column.getColumnId()) && Boolean.TRUE.equals(column.getVisible())) {
                    column.setVisible(false);
                    columnRepository.save(column);
                }
            }
        } catch (Exception e) {
            log.debug("专栏软删除标记跳过 groupId={} error={}", groupId, e.getMessage());
        }
    }

    /** 专栏话题同步：头部增量 + 历史回填；返回 [新话题数, 新评论数, 跳过数]。 */
    private int[] syncColumnTopics(ZsxqClient client, ZsxqColumn column, Logger logger) {
        int topics = 0, comments = 0, skipped = 0;
        String gid = safe(column.getGroupId());
        String cid = safe(column.getColumnId());

        // 1) 头部增量：从最新往回抓，直到碰到已同步过的帖子
        String headOldest = "";
        String headEnd = "";
        java.util.Set<String> insertedInHead = new java.util.HashSet<>();
        for (int page = 0; page < MAX_HEAD_PAGES_PER_COLUMN; page++) {
            pause(PAUSE_BEFORE_PAGE_FETCH_MS);
            List<Topic> list;
            try {
                ListTopicsOptions options = new ListTopicsOptions().count(TOPICS_PER_PAGE).scope("all");
                if (!headEnd.isEmpty()) options.endTime(headEnd);
                list = api("client.topics().listByColumn(groupId=" + gid + ", columnId=" + cid + ", endTime=" + headEnd + ")",
                        () -> client.topics().listByColumn(gid, cid, options));
            } catch (Exception e) {
                if (isRiskControl(e)) throw new RiskControlException(e);
                logger.warn("专栏 {} 最新话题拉取失败：{}", cid, e.getMessage());
                break;
            }
            if (list == null || list.isEmpty()) break;
            int existingOnPage = 0;
            for (Topic t : list) {
                String tid = toStr(t.getTopicId());
                if (tid.isEmpty()) continue;
                String createTime = safe(t.getCreateTime());
                if (!createTime.isEmpty()) {
                    headOldest = createTime;
                    headEnd = createTime;
                }
                java.util.Optional<ZsxqTopic> existing = topicRepository.findByTopicId(tid);
                if (existing.isPresent()) {
                    if (!cid.equals(safe(existing.get().getColumnId()))) assignColumn(tid, cid);
                    skipped++;
                    if (!insertedInHead.contains(tid)) existingOnPage++;
                    fillAuthorIfMissing(tid, t, existing.get());
                    comments += refreshCommentsIfGrown(client, gid, t, existing.get(), logger);
                } else {
                    pause(PAUSE_BETWEEN_TOPIC_FETCHES_MS);
                    upsertTopic(gid, tid, t, cid);
                    topics++;
                    insertedInHead.add(tid);
                    if (safeInt(t.getCommentsCount()) > 0) comments += fetchComments(client, gid, tid, logger);
                }
            }
            if (existingOnPage > 0 || list.size() < TOPICS_PER_PAGE) break;
        }

        // 2) 历史回填：从专栏游标继续向更早翻页
        String end = safe(column.getSyncCursor()).trim();
        if (end.isEmpty() && !headOldest.isEmpty()) end = headOldest;
        for (int page = 0; page < MAX_PAGES_PER_COLUMN; page++) {
            if (end.isEmpty()) break;
            pause(PAUSE_BEFORE_PAGE_FETCH_MS);
            List<Topic> list;
            try {
                final String endTime = end;
                list = api("client.topics().listByColumn(groupId=" + gid + ", columnId=" + cid + ", endTime=" + endTime + ")",
                        () -> client.topics().listByColumn(gid, cid, new ListTopicsOptions()
                                .count(TOPICS_PER_PAGE)
                                .scope("all")
                                .endTime(endTime)));
            } catch (Exception e) {
                if (isRiskControl(e)) throw new RiskControlException(e);
                logger.warn("专栏 {} 历史话题拉取失败：{}", cid, e.getMessage());
                break;
            }
            if (list == null || list.isEmpty()) break;
            String before = end;
            int newOnPage = 0;
            for (Topic t : list) {
                String tid = toStr(t.getTopicId());
                if (tid.isEmpty()) continue;
                java.util.Optional<ZsxqTopic> existing = topicRepository.findByTopicId(tid);
                if (existing.isPresent()) {
                    if (!cid.equals(safe(existing.get().getColumnId()))) assignColumn(tid, cid);
                    skipped++;
                    fillAuthorIfMissing(tid, t, existing.get());
                    String createTime = safe(t.getCreateTime());
                    if (!createTime.isEmpty()) end = createTime;
                    continue;
                }
                pause(PAUSE_BETWEEN_TOPIC_FETCHES_MS);
                upsertTopic(gid, tid, t, cid);
                topics++;
                newOnPage++;
                if (safeInt(t.getCommentsCount()) > 0) comments += fetchComments(client, gid, tid, logger);
                String createTime = safe(t.getCreateTime());
                if (!createTime.isEmpty()) end = createTime;
            }
            if (newOnPage == 0 && end.equals(before)) break;
        }
        column.setSyncCursor(end);
        column.setLastSyncAt(System.currentTimeMillis());
        columnRepository.save(column);
        return new int[]{topics, comments, skipped};
    }

    /** 已存在的话题补齐专栏归属（不覆盖其他专栏）。 */
    private void assignColumn(String topicId, String columnId) {
        jdbc.update("UPDATE zsxq_topic SET column_id = ?, update_time = ? "
                        + "WHERE topic_id = ? AND (column_id IS NULL OR column_id = '')",
                columnId, LocalDateTime.now(), topicId);
    }

    private ZsxqColumn upsertColumn(String groupId, String columnId, Column c) {
        ZsxqColumn column = columnRepository.findByColumnId(columnId).orElseGet(ZsxqColumn::new);
        String name = safe(c.getName());
        column.setColumnId(columnId);
        column.setGroupId(groupId);
        column.setName(truncate(name.isEmpty() ? columnId : name, COLUMN_NAME_MAX_LENGTH));
        column.setDescription(truncate(safe(c.getDescription()), COLUMN_TEXT_MAX_LENGTH));
        column.setCoverUrl(truncate(safe(c.getCoverUrl()), COLUMN_TEXT_MAX_LENGTH));
        column.setTopicsCount(safeInt(c.getTopicsCount()));
        column.setVisible(true);
        column.setLastSyncAt(System.currentTimeMillis());
        return columnRepository.save(column);
    }

    private ZsxqClient buildClient(String token) {
        ZsxqClientBuilder builder = new ZsxqClientBuilder()
                .token(token)
                .timeout(20000)
                .retry(3);
        // 知识星球 token 形如 <deviceId>_<accessToken>：沿用登录设备号，避免每次请求都被当成新设备
        int split = token.indexOf('_');
        if (split > 0) builder.deviceId(token.substring(0, split));
        return builder.build();
    }

    /**
     * 把本次校验时拉到的远端星球写入本地，返回本轮要同步的星球 ID。
     *
     * <p>远端列表为空（例如接口返回空数组）时回退到本地已发现的星球；数量上限 {@value #MAX_GROUPS}。</p>
     */
    private List<String> resolveGroupIds(List<Group> remoteGroups) {
        List<String> groupIds = new ArrayList<>();
        if (remoteGroups != null) {
            for (Group g : remoteGroups) {
                String gid = toStr(g.getGroupId());
                if (gid.isEmpty()) continue;
                groupIds.add(gid);
                String ownerId = g.getOwner() == null ? "" : normalizeId(g.getOwner().getUserId());
                String ownerName = g.getOwner() == null ? "" : safe(g.getOwner().getName());
                upsertGroup(gid, safe(g.getName()), ownerId, ownerName);
            }
        }
        if (groupIds.isEmpty()) {
            for (java.util.Map<String, Object> row : jdbc.queryForList("SELECT id FROM zsxq_group ORDER BY id")) {
                String id = String.valueOf(row.get("ID"));
                if (!id.isBlank()) groupIds.add(id);
            }
        }
        if (groupIds.size() > MAX_GROUPS) groupIds = new java.util.ArrayList<>(groupIds.subList(0, MAX_GROUPS));
        return groupIds;
    }

    private int fetchComments(ZsxqClient client, String groupId, String topicId, Logger logger) {
        try {
            List<Comment> list = api("client.topics().getComments(topicId=" + topicId + ")",
                    () -> client.topics().getComments(topicId,
                            new ListCommentsOptions().sort("asc").count(COMMENTS_PER_TOPIC)));
            int n = 0;
            if (list != null) {
                for (Comment c : list) {
                    String cid = toStr(c.getCommentId());
                    if (cid.isEmpty()) continue;
                    String author = c.getOwner() != null ? safe(c.getOwner().getName()) : "";
                    jdbc.update("INSERT INTO zsxq_comment (id, topic_id, comment_id, group_id, author, text, source_create_time, create_time, update_time) "
                                    + "SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS "
                                    + "(SELECT 1 FROM zsxq_comment WHERE comment_id = ?)",
                            UUID.randomUUID().toString().replace("-", ""), topicId, cid, groupId,
                            author, safe(c.getText()), safe(c.getCreateTime()),
                            LocalDateTime.now(), LocalDateTime.now(), cid);
                    n++;
                }
            }
            pause(PAUSE_BETWEEN_TOPIC_FETCHES_MS);
            return n;
        } catch (Exception e) {
            if (isRiskControl(e)) throw new RiskControlException(e);
            if (isTopicGone(e)) {
                // 帖子已在星球侧删除：软删除标记，后续同步不再为其请求评论
                markTopicDeleted(topicId);
                logger.info("帖子已删除，跳过评论抓取 topicId={}", topicId);
                return 0;
            }
            logger.warn("评论抓取失败 topicId={} error={}", topicId, e.getMessage());
            return 0;
        }
    }

    /** 评论接口报「主题已被删除」（15403 或删除类文案）时视为已删除，不计为评论抓取失败。 */
    private static boolean isTopicGone(Exception e) {
        if (!(e instanceof ZsxqException zsxq)) return false;
        int code = zsxq.getCode();
        // Token 失效/权限/限流不是删除，避免误标
        if (code == 10001 || code == 10002 || code == 10003 || code == 40001) return false;
        if (code == CODE_TOPIC_GONE) return true;
        String msg = zsxq.getMessage();
        return msg != null && GONE_MESSAGE.matcher(msg).find();
    }

    /** token 失效、权限不足、限流等与单帖无关的错误：本轮直接中止。 */
    private static boolean isAuthOrFatal(Exception e) {
        if (!(e instanceof ZsxqException zsxq)) return false;
        int code = zsxq.getCode();
        return code == 10001 || code == 10002 || code == 10003 || code == 40001;
    }

    /** 软删除：visible=false，保留正文与评论，只用于后续同步跳过该帖评论。 */
    private void markTopicDeleted(String topicId) {
        jdbc.update("UPDATE zsxq_topic SET visible = FALSE, update_time = ? WHERE topic_id = ?",
                LocalDateTime.now(), topicId);
    }

    // ---------- 本地库 ----------

    private void ensureTables() {
        jdbc.execute("CREATE TABLE IF NOT EXISTS zsxq_comment ("
                + "id VARCHAR(32) PRIMARY KEY, topic_id VARCHAR(64), comment_id VARCHAR(64) NOT NULL, "
                + "group_id VARCHAR(64), author VARCHAR(200), text CLOB, source_create_time VARCHAR(40), "
                + "create_time TIMESTAMP, update_time TIMESTAMP)");
        jdbc.execute("CREATE INDEX IF NOT EXISTS idx_zsxq_comment_topic ON zsxq_comment (topic_id)");
        jdbc.execute("CREATE TABLE IF NOT EXISTS zsxq_sync_state ("
                + "group_id VARCHAR(64) PRIMARY KEY, cursor_value VARCHAR(100), last_sync_at BIGINT)");
        jdbc.execute("CREATE TABLE IF NOT EXISTS zsxq_job_state ("
                + "state_key VARCHAR(64) PRIMARY KEY, long_value BIGINT)");
    }

    private Long getState(String key) {
        return jdbc.query("SELECT long_value FROM zsxq_job_state WHERE state_key = ?",
                ps -> ps.setString(1, key),
                rs -> rs.next() ? rs.getLong(1) : null);
    }

    private void setState(String key, long value) {
        jdbc.update("MERGE INTO zsxq_job_state (state_key, long_value) KEY(state_key) VALUES (?, ?)", key, value);
    }

    private void upsertGroup(String gid, String name, String ownerId, String ownerName) {
        jdbc.update("MERGE INTO zsxq_group (id, name, owner_id, owner, enabled, create_time, update_time) "
                        + "KEY(id) VALUES (?, ?, ?, ?, TRUE, ?, ?)",
                gid, name.isEmpty() ? gid : name, ownerId, ownerName,
                LocalDateTime.now(), LocalDateTime.now());
    }

    private void upsertTopic(String gid, String tid, Topic t, String columnId) {
        TalkContent talk = t.getTalk();
        String digest = talk != null ? safe(talk.getText()) : "";
        if (digest.length() > ZsxqTopic.DIGEST_MAX_LENGTH) digest = digest.substring(0, ZsxqTopic.DIGEST_MAX_LENGTH);

        // 正文图片直接落对象存储，正文/封面不再依赖会过期的星球临时链接
        List<String> imageKeys = imageService.storeAll(tid, talk);
        boolean imagesComplete = imageKeys.size() >= imageService.sourceImageCount(talk);
        String imagesJson = imageService.toJson(imageKeys);
        String cover = imageKeys.isEmpty() ? firstImage(talk) : imageKeys.get(0);
        Long imageSyncedAt = imagesComplete ? System.currentTimeMillis() : null;
        int imageFailCount = imagesComplete ? 0 : 1;

        String sourceTime = safe(t.getCreateTime());
        int comments = safeInt(t.getCommentsCount());
        int likes = safeInt(t.getLikesCount());
        String column = columnId == null || columnId.isBlank() ? null : columnId;

        jdbc.update("INSERT INTO zsxq_topic (id, topic_id, group_id, column_id, digest, comment_count, likes_count, "
                        + "source_create_time, cover, images, image_synced_at, image_fail_count, visible, "
                        + "create_time, update_time) "
                        + "SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, TRUE, ?, ? WHERE NOT EXISTS "
                        + "(SELECT 1 FROM zsxq_topic WHERE topic_id = ?)",
                UUID.randomUUID().toString().replace("-", ""), tid, gid, column, digest, comments, likes,
                sourceTime, cover, imagesJson, imageSyncedAt, imageFailCount,
                LocalDateTime.now(), LocalDateTime.now(), tid);

        // 话题作者：来自话题内容的 owner；已有帖子也由此逐步补齐（作者 ID 用于“只看星主”）
        String author = talk != null && talk.getOwner() != null ? safe(talk.getOwner().getName()) : "";
        String authorId = talk != null && talk.getOwner() != null ? normalizeId(talk.getOwner().getUserId()) : "";
        if (!author.isEmpty()) {
            jdbc.update("UPDATE zsxq_topic SET author = ?, author_id = ? WHERE topic_id = ?", author, authorId, tid);
        }
    }

    private String cursor(String gid) {
        String value = jdbc.query("SELECT cursor_value FROM zsxq_sync_state WHERE group_id = ?",
                ps -> ps.setString(1, gid), rs -> rs.next() ? rs.getString(1) : null);
        return value == null ? "" : value;
    }

    private void saveCursor(String gid, String value) {
        jdbc.update("MERGE INTO zsxq_sync_state (group_id, cursor_value, last_sync_at) KEY(group_id) VALUES (?, ?, ?)",
                gid, value, System.currentTimeMillis());
    }

    // ---------- 工具 ----------

    private static String toStr(Object id) {
        return id == null ? "" : String.valueOf(id);
    }

    private static String safe(String v) {
        return v == null ? "" : v;
    }

    /** SDK 把大数字 ID 经 Map 转换后可能变成科学计数法（如 8.44E14），统一还原为纯数字。 */
    private static String normalizeId(String v) {
        String s = safe(v).trim();
        if (s.matches("[0-9]+(\\.[0-9]+)?[eE]\\+?[0-9]+")) {
            try {
                return new java.math.BigDecimal(s).toPlainString();
            } catch (NumberFormatException ignored) {
                return s;
            }
        }
        return s;
    }

    private static int safeInt(Integer v) {
        return v == null ? 0 : v;
    }

    private static String truncate(String v, int max) {
        return v.length() > max ? v.substring(0, max) : v;
    }

    private static String firstImage(TalkContent talk) {
        if (talk == null || talk.getImages() == null || talk.getImages().isEmpty()) return "";
        Image image = talk.getImages().get(0);
        if (image == null) return "";
        if (image.getLarge() != null && !safe(image.getLarge().getUrl()).isEmpty()) return image.getLarge().getUrl();
        if (image.getOriginal() != null && !safe(image.getOriginal().getUrl()).isEmpty()) return image.getOriginal().getUrl();
        if (image.getThumbnail() != null && !safe(image.getThumbnail().getUrl()).isEmpty()) return image.getThumbnail().getUrl();
        return "";
    }

    /** 反爬等待：在固定间隔上叠加随机抖动，避免请求节奏规律化。 */
    private static void pause(long ms) {
        long wait = ms + ThreadLocalRandom.current().nextLong(PAUSE_JITTER_MS + 1);
        try {
            Thread.sleep(wait);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    // ---------- 知识星球交互日志 ----------

    /**
     * 知识星球 API 交互的统一包装：每次请求前打印请求描述（方法 + 关键参数），
     * 请求后打印结果规模与耗时，错误立即以 error 级别记录，便于定位采集问题。
     */
    private static <T> T api(String desc, java.util.function.Supplier<T> call) {
        long start = System.currentTimeMillis();
        log.info("[知识星球] 请求：{}", desc);
        T result;
        try {
            result = call.get();
        } catch (RuntimeException e) {
            log.error("[知识星球] 请求失败：{}（{} ms）error={}", desc, System.currentTimeMillis() - start, e.getMessage());
            throw e;
        }
        log.info("[知识星球] 响应：{}（{} ms）-> {}", desc, System.currentTimeMillis() - start, summary(result));
        return result;
    }

    /** 用于 API 响应日志的摘要：列表类返回条数，单个对象返回关键 ID。 */
    private static Object summary(Object result) {
        if (result instanceof List<?> list) return list.size();
        if (result instanceof Topic t) return toStr(t.getTopicId());
        if (result instanceof Column c) return toStr(c.getColumnId());
        if (result == null) return 0;
        return result;
    }
}
