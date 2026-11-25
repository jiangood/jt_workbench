package com.jt.workbench.modules.job.service;

import com.jt.workbench.modules.zsxq.entity.ZsxqColumn;
import com.jt.workbench.modules.zsxq.entity.ZsxqTopic;
import com.jt.workbench.modules.zsxq.repo.ZsxqColumnRepository;
import com.jt.workbench.modules.zsxq.repo.ZsxqTopicRepository;
import com.jt.workbench.modules.zsxq.client.ZsxqApiClient;
import com.jt.workbench.modules.zsxq.client.ZsxqApiException;
import com.jt.workbench.modules.zsxq.client.ZsxqModels.*;
import com.jt.workbench.modules.zsxq.service.ZsxqImageService;
import io.github.jiangood.openadmin.modules.config.service.SysConfigService;
import io.github.jiangood.openadmin.modules.job.JobResult;
import io.github.jiangood.openadmin.modules.job.JobStatus;
import io.github.jiangood.openadmin.modules.logviewer.util.TaskLog;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.slf4j.Logger;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.locks.ReentrantLock;

/**
 * 知识星球同步与历史回填。
 *
 * <p>{@link #syncAll} 负责每 30 分钟的头部增量；{@link #backfillAll} 负责每天 08:00 的历史回填，
 * 从游标连续翻到最早页，并补齐专栏、图片与专栏文章完整正文。两个入口共享风控状态与同步游标，
 * 通过进程内锁互斥，避免并发执行时覆盖本轮状态。</p>
 *
 * <p>Cookie 失效或校验异常时本轮直接结束并返回提示，不再发起后续抓取，避免过期 Cookie 持续刷失败日志。</p>
 *
 * <p>评论接口报「主题已被删除」（15403 或删除类文案）时，把该帖标记为软删除（visible=false），
 * 后续同步不再为其请求评论。</p>
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class ZsxqSyncService {

    private static final int MAX_GROUPS = 20;
    private static final int TOPICS_PER_PAGE = 20;
    private static final int COMMENTS_PER_TOPIC = 30;
    private static final int COLUMN_NAME_MAX_LENGTH = 512;
    private static final int COLUMN_TEXT_MAX_LENGTH = 2048;

    /** 头部增量默认 2 页（40 条/星球），碰到已同步帖子即提前停止。 */
    private static final int HEAD_PAGES_DEFAULT = 2;
    private static final int IMAGE_BACKFILL_DEFAULT_BATCH = 10;
    private static final int IMAGE_BACKFILL_MAX_FAILS = 3;
    /** 专栏文章完整正文回填：默认每轮 50 条，连续失败 3 次后不再重试。 */
    private static final int ARTICLE_BACKFILL_DEFAULT_BATCH = 50;
    private static final int ARTICLE_BACKFILL_MAX_FAILS = 3;

    /** 抓取间隔（反爬）：分页 8 秒、话题/评论 3 秒，再叠加 0~2 秒随机抖动。 */
    private static final int PAGE_PAUSE_DEFAULT_SECONDS = 8;
    private static final int TOPIC_PAUSE_DEFAULT_SECONDS = 3;
    /** 在固定间隔上叠加的随机抖动，避免请求节奏过于规律（0~2 秒）。 */
    private static final long PAUSE_JITTER_MS = 2000;

    /** 评论接口业务码：主题已经被删除 */
    private static final int CODE_TOPIC_GONE = 15403;
    /** 知识星球风控/非官方工具拦截 */
    private static final int CODE_RISK_CONTROL = 1059;
    /** 知识星球限流 */
    private static final int CODE_RATE_LIMIT = 40001;
    /** HTTP 429：网关限流（与 40001 同等处理） */
    private static final int CODE_TOO_MANY_REQUESTS = 429;
    /**
     * 1059 是逐请求随机命中的（同一请求重试通常就过），客户端默认原地重试 3 次，
     * 仍失败才视为本轮被拦、进入冷却。
     */
    private static final int RISK_RETRY_DEFAULT = 3;
    private static final int RISK_RETRY_PAUSE_DEFAULT_SECONDS = 3;
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
    /** 凭据（Cookie）哈希；状态键沿用旧值，兼容已有库数据。 */
    private static final String STATE_RISK_CREDENTIAL_HASH = "risk_token_hash";
    private static final String STATE_COLUMNS_LAST_OK = "columns_last_ok";

    private final SysConfigService configService;
    private final ZsxqTopicRepository topicRepository;
    private final ZsxqColumnRepository columnRepository;
    private final ZsxqImageService imageService;
    private final JdbcTemplate jdbc;

    // ---------- 本轮运行状态（两个 Quartz 作业通过共享锁互斥） ----------

    private final ReentrantLock runLock = new ReentrantLock();
    private int headPages = HEAD_PAGES_DEFAULT;
    private long pagePauseMs = PAGE_PAUSE_DEFAULT_SECONDS * 1000L;
    private long topicPauseMs = TOPIC_PAUSE_DEFAULT_SECONDS * 1000L;
    private boolean refreshOldComments;
    private int requestsUsed;
    /** 最近一次星球接口调用描述，风控/异常时写入任务结果，便于定位是哪个请求被拦。 */
    private String lastApiDesc = "";

    /**
     * 增量同步入口（每 30 分钟）。
     *
     * <p>认证只使用系统参数里粘贴的浏览器 Cookie。</p>
     */
    public JobResult syncAll(Logger logger, java.util.function.Consumer<String> progress) {
        try {
            return execute("同步", false, logger, progress);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return new JobResult(JobStatus.CANCELLED, "已取消");
        }
    }

    /** 历史回填入口（每天 08:00）：连续翻页直到追平，不受单轮请求预算限制。 */
    public JobResult backfillAll(Logger logger, java.util.function.Consumer<String> progress) {
        try {
            return execute("历史回填", true, logger, progress);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return new JobResult(JobStatus.CANCELLED, "已取消");
        }
    }

    private JobResult execute(String taskName, boolean backfill, Logger logger,
                              java.util.function.Consumer<String> progress) throws InterruptedException {
        if (backfill) {
            // 08:00 与增量作业可能同时触发：回填等待增量结束，避免抢锁导致当天回填被跳过
            runLock.lockInterruptibly();
        } else if (!runLock.tryLock()) {
            return JobResult.skip("知识星球同步跳过（历史回填正在执行）");
        }
        try {
            String cookie = safe(configService.getString("zsxq.cookie")).trim();
            if (cookie.isEmpty()) return JobResult.skip("未配置知识星球 Cookie，跳过");
            ensureTables();
            resetCooldownOnCookieChange(cookie);

            String cooling = cooldownMessage();
            if (cooling != null) return JobResult.skip(cooling);

            beginRun();
            ZsxqApiClient client = buildClient(cookie);
            progress.accept("校验 Cookie");
            List<String> parts = new ArrayList<>();
            try {
                List<Group> remoteGroups;
                try {
                    remoteGroups = listGroups(client);
                } catch (Exception e) {
                    if (isRiskControl(e)) throw new RiskControlException(e);
                    logger.warn("知识星球 Cookie 校验失败：{}", e.getMessage());
                    return JobResult.fail(cookieErrorText(e));
                }

                List<String> groupIds = resolveGroupIds(remoteGroups);
                log.info("[知识星球] 本轮{}开始：{} 个星球", taskName, groupIds.size());
                if (backfill) {
                    parts.add(backfillTopics(client, groupIds, logger, progress));
                    parts.add(syncColumns(client, groupIds, logger, progress, true));
                    setState(STATE_COLUMNS_LAST_OK, System.currentTimeMillis());
                    parts.add(backfillColumnArticles(client, logger, progress));
                    parts.add(backfillImages(client, logger, progress));
                } else {
                    parts.add(syncTopics(client, groupIds, logger, progress));
                    parts.add(syncColumnsIfDue(client, groupIds, logger, progress));
                }

                // 本轮完整跑通（未触发风控）：清除连续风控计数
                setState(STATE_RISK_STRIKES, 0);
                String overview = String.join("；", parts) + "（本轮接口 " + requestsUsed + " 次）";
                log.info("[知识星球] 本轮{}概览：{}", taskName, overview);
                TaskLog.info("[知识星球] 本轮{}概览：{}", taskName, overview);
                return JobResult.ok(overview);
            } catch (RiskControlException e) {
                return JobResult.fail(enterRiskCooldown(logger, e));
            }
        } finally {
            runLock.unlock();
        }
    }

    /** 读取本轮参数（每轮重新读取，调整系统参数后下一轮立即生效）。 */
    private void beginRun() {
        headPages = intConfig("zsxq.head-pages", HEAD_PAGES_DEFAULT, 1, 10);
        pagePauseMs = intConfig("zsxq.page-pause-seconds", PAGE_PAUSE_DEFAULT_SECONDS, 1, 120) * 1000L;
        topicPauseMs = intConfig("zsxq.topic-pause-seconds", TOPIC_PAUSE_DEFAULT_SECONDS, 1, 60) * 1000L;
        refreshOldComments = configService.getBool("zsxq.refresh-old-comments");
        requestsUsed = 0;
        lastApiDesc = "";
    }

    private int intConfig(String key, int def, int min, int max) {
        int value = configService.getInt(key);
        return value < min || value > max ? def : value;
    }

    /** 专栏按配置间隔执行（默认 24 小时）；没到间隔时不发任何星球请求。 */
    private String syncColumnsIfDue(ZsxqApiClient client, List<String> groupIds, Logger logger,
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
        String result = syncColumns(client, groupIds, logger, progress, false);
        setState(STATE_COLUMNS_LAST_OK, System.currentTimeMillis());
        return result;
    }

    /** 更换 Cookie 后说明用户已重新登录/修复配置：清空风控冷却，立即允许重试。 */
    private void resetCooldownOnCookieChange(String cookie) {
        long hash = Integer.toUnsignedLong(cookie.hashCode());
        Long lastHash = getState(STATE_RISK_CREDENTIAL_HASH);
        if (lastHash != null && lastHash != hash) {
            setState(STATE_RISK_UNTIL, 0);
            setState(STATE_RISK_STRIKES, 0);
        }
        if (lastHash == null || lastHash != hash) {
            setState(STATE_RISK_CREDENTIAL_HASH, hash);
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

        // 诊断信息：业务码 + 最近一次接口 + 平台返回文案，任务结果与任务日志都能直接看到
        StringBuilder detail = new StringBuilder("code=").append(e.code());
        if (!lastApiDesc.isBlank()) detail.append("，接口=").append(lastApiDesc);
        if (e.getMessage() != null && !e.getMessage().isBlank()) detail.append("，返回=").append(e.getMessage());
        logger.warn("知识星球触发风控（{}），本轮中止，冷却 {} 分钟（连续第 {} 次）",
                detail, minutes, strikes);
        TaskLog.warn("知识星球触发风控（{}），本轮中止，冷却 {} 分钟（连续第 {} 次）",
                detail, minutes, strikes);
        return "触发知识星球风控（" + detail + "），本轮中止；冷却 " + minutes + " 分钟后再试（连续第 "
                + strikes + " 次）";
    }

    /** 风控/限流：重试耗尽后本轮立即中止，不计入单帖失败次数。 */
    private static boolean isRiskControl(Exception e) {
        if (!(e instanceof ZsxqApiException api)) return false;
        int code = api.getCode();
        return code == CODE_RISK_CONTROL || code == CODE_RATE_LIMIT || code == CODE_TOO_MANY_REQUESTS;
    }

    /** 内部信号：把风控异常从各阶段抛出到 {@link #syncAll} 统一处理。 */
    private static class RiskControlException extends RuntimeException {
        private final int code;

        RiskControlException(Exception cause) {
            super(cause.getMessage(), cause);
            this.code = cause instanceof ZsxqApiException api ? api.getCode() : 0;
        }

        int code() {
            return code;
        }
    }

    /**
     * Cookie 校验失败时的任务结果提示。
     *
     * <p>校验用 {@code /v2/groups} 而不是 {@code /v3/users/self}：后者对网页端 Cookie 常返回
     * 「设备状态异常」（1059，绑定浏览器设备），且 SDK 因响应字段是 {@code succeed} 而不会抛错，
     * 不能用于判断有效性。</p>
     */
    private static String cookieErrorText(Exception e) {
        if (e instanceof ZsxqApiException api) {
            int code = api.getCode();
            if (code == 1009) {
                return "知识星球账号已在其它设备登录（code=1009），当前 Cookie 已失效；请重新登录后填写最新 Cookie";
            }
            if (code == 401 || code == 10001 || code == 10002 || code == 10003) {
                return "知识星球 Cookie 已失效或鉴权失败（code=" + code + "），请更新系统参数 zsxq.cookie";
            }
            if (code == CODE_RISK_CONTROL) {
                return "知识星球拒绝了本次访问（code=1059）：" + api.getMessage();
            }
            return "知识星球 Cookie 校验失败（code=" + code + "）：" + api.getMessage();
        }
        return "知识星球 Cookie 校验失败：" + e.getMessage();
    }

    /** 头部增量：从最新往回抓，直到碰到上一轮已同步过的帖子（覆盖停机期间的新帖）。 */
    private String syncTopics(ZsxqApiClient client, List<String> groupIds, Logger logger,
                              java.util.function.Consumer<String> progress) {
        if (groupIds.isEmpty()) return "话题同步跳过（没有可用星球）";

        int topics = 0, comments = 0, skipped = 0, groupsDone = 0;
        for (int gi = 0; gi < groupIds.size(); gi++) {
            String gid = groupIds.get(gi);
            progress.accept("同步星球 " + (gi + 1) + "/" + groupIds.size());

            String headOldest = "";
            String headEnd = "";
            java.util.Set<String> insertedInHead = new java.util.HashSet<>();
            for (int page = 0; page < headPages; page++) {
                pause(pagePauseMs);
                List<Topic> list;
                try {
                    list = listTopics(client, gid, headEnd);
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
                        if (refreshOldComments) {
                            comments += refreshCommentsIfGrown(client, gid, t, existing.get(), logger);
                        }
                        continue;
                    }
                    pause(topicPauseMs);
                    upsertTopic(gid, tid, t, null);
                    topics++;
                    insertedInHead.add(tid);
                    if (safeInt(t.getCommentsCount()) > 0) comments += fetchComments(client, gid, tid, logger);
                }
                // 碰到已存在的帖子说明已接上上一轮位置；否则继续向更早翻，补抓停机期间的新帖
                if (existingOnPage > 0 || list.size() < TOPICS_PER_PAGE) break;
            }

            // 首次增量同步只负责初始化历史游标，实际回填交给每日独立作业
            if (cursor(gid).isEmpty() && !headOldest.isEmpty()) saveCursor(gid, headOldest);
            groupsDone++;
        }
        return "话题同步：" + groupsDone + " 个星球，新话题 " + topics + " 条，评论 "
                + comments + " 条，跳过已存在 " + skipped + " 条";
    }

    /**
     * 历史话题回填：从游标连续向更早翻页，直到空页、末页或游标无法前进。
     * 每页处理完立即保存游标；风控中止后次日从断点继续，不受单轮请求预算限制。
     */
    private String backfillTopics(ZsxqApiClient client, List<String> groupIds, Logger logger,
                                  java.util.function.Consumer<String> progress) {
        if (groupIds.isEmpty()) return "历史话题回填跳过（没有可用星球）";

        int topics = 0, comments = 0, skipped = 0, pages = 0, groupsDone = 0;
        for (int gi = 0; gi < groupIds.size(); gi++) {
            String gid = groupIds.get(gi);
            String end = cursor(gid);
            progress.accept("回填星球历史话题 " + (gi + 1) + "/" + groupIds.size());

            while (true) {
                pause(pagePauseMs);
                List<Topic> list;
                try {
                    list = listTopics(client, gid, end);
                } catch (Exception e) {
                    if (isRiskControl(e)) throw new RiskControlException(e);
                    logger.warn("星球 {} 历史话题拉取失败：{}", gid, e.getMessage());
                    break;
                }
                if (list == null || list.isEmpty()) break;

                String before = end;
                pages++;
                for (Topic t : list) {
                    String tid = toStr(t.getTopicId());
                    if (tid.isEmpty()) continue;
                    String createTime = safe(t.getCreateTime());
                    if (!createTime.isEmpty()) end = createTime;

                    java.util.Optional<ZsxqTopic> existing = topicRepository.findByTopicId(tid);
                    if (existing.isPresent()) {
                        skipped++;
                        fillAuthorIfMissing(tid, t, existing.get());
                        continue;
                    }
                    pause(topicPauseMs);
                    upsertTopic(gid, tid, t, null);
                    topics++;
                    if (safeInt(t.getCommentsCount()) > 0) comments += fetchComments(client, gid, tid, logger);
                }
                saveCursor(gid, end);
                // 末页直接结束；同一时间戳导致游标原地打转时也要停止，避免无限重复请求
                if (list.size() < TOPICS_PER_PAGE || end.isEmpty() || end.equals(before)) break;
            }
            groupsDone++;
        }
        return "历史话题回填：" + groupsDone + " 个星球，" + pages + " 页，新话题 " + topics
                + " 条，评论 " + comments + " 条，跳过已存在 " + skipped + " 条";
    }

    /**
     * 老数据补齐作者信息：列表接口本身带 owner，历史帖子（作者名/ID 缺失）在回填翻页时顺带补齐，
     * 保证“只看星主”能覆盖存量数据。长文章的 owner 可能在话题顶层。
     */
    private void fillAuthorIfMissing(String tid, Topic t, ZsxqTopic local) {
        if (local == null) return;
        boolean missingName = safe(local.getAuthor()).isEmpty();
        boolean missingId = safe(local.getAuthorId()).isEmpty();
        if (!missingName && !missingId) return;
        String author = topicAuthor(t);
        if (author.isEmpty()) return;
        String authorId = topicAuthorId(t);
        jdbc.update("UPDATE zsxq_topic SET author = ?, author_id = ? WHERE topic_id = ?", author, authorId, tid);
    }

    /** 已存在但正文为空的专栏条目：用列表/详情里拿到的标题、摘要、正文与原文链接补齐。 */
    private void refreshTopicContentIfEmpty(String topicId, Topic t) {
        String digest = topicDigest(t);
        String title = articleTitle(t);
        String articleUrl = articleUrlOf(t);
        String content = articleContentOf(t);
        if (digest.isBlank() && title.isBlank() && articleUrl.isBlank() && content.isBlank()) return;
        long now = System.currentTimeMillis();
        jdbc.update("UPDATE zsxq_topic SET "
                        + "digest = CASE WHEN (digest IS NULL OR digest = '') AND ? <> '' THEN ? ELSE digest END, "
                        + "article_title = CASE WHEN (article_title IS NULL OR article_title = '') AND ? <> '' THEN ? ELSE article_title END, "
                        + "article_url = CASE WHEN (article_url IS NULL OR article_url = '') AND ? <> '' THEN ? ELSE article_url END, "
                        + "article_content = CASE WHEN (article_content IS NULL OR article_content = '') AND ? <> '' THEN ? ELSE article_content END, "
                        + "article_synced_at = CASE WHEN (article_content IS NULL OR article_content = '') AND ? <> '' "
                        + "THEN ? ELSE article_synced_at END, update_time = ? WHERE topic_id = ?",
                digest, digest, title, title, articleUrl, articleUrl, content, content,
                content, now, LocalDateTime.now(), topicId);
    }

    /**
     * 头部页里已存在的话题，如果接口返回的评论数比本地多，补抓一次评论并更新计数。
     * 这样星主/成员在旧帖下的新回复也能持续同步（评论按 comment_id 幂等去重）。
     */
    private int refreshCommentsIfGrown(ZsxqApiClient client, String gid, Topic remote, ZsxqTopic local, Logger logger) {
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
    private String syncColumns(ZsxqApiClient client, List<String> groupIds, Logger logger,
                               java.util.function.Consumer<String> progress, boolean fullBackfill) {
        if (groupIds.isEmpty()) return "专栏同步跳过（没有可用星球）";

        int columnsDone = 0, topics = 0, comments = 0, skipped = 0, groupsDone = 0;
        for (int gi = 0; gi < groupIds.size(); gi++) {
            String gid = groupIds.get(gi);
            progress.accept((fullBackfill ? "回填" : "同步") + "星球专栏 " + (gi + 1) + "/" + groupIds.size());
            pause(pagePauseMs);
            List<Column> columns;
            try {
                columns = listColumns(client, gid);
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
                int[] result = syncColumnTopics(client, column, logger, fullBackfill);
                topics += result[0];
                comments += result[1];
                skipped += result[2];
                columnsDone++;
                pause(topicPauseMs);
            }
            markMissingColumns(gid, seenColumnIds);
            groupsDone++;
        }
        return (fullBackfill ? "专栏历史回填：" : "专栏同步：") + groupsDone + " 个星球的 "
                + columnsDone + " 个专栏，新话题 " + topics + " 条，评论 " + comments
                + " 条，跳过已存在 " + skipped + " 条";
    }

    /**
     * 回填历史帖子的图片：按发帖时间从新到旧逐帖调用话题详情，下载图片到对象存储，
     * 并写入 {@code images}/{@code cover}。每轮条数由系统参数 {@code zsxq.image-backfill-batch} 控制。
     *
     * <p>Cookie 失效等致命错误会立即中止本轮，避免把后续帖子误记成失败；帖子已删除则标记为
     * 空图片列表并结束该帖，不再重试。</p>
     */
    private String backfillImages(ZsxqApiClient client, Logger logger,
                                  java.util.function.Consumer<String> progress) {
        int batch = intConfig("zsxq.image-backfill-batch", IMAGE_BACKFILL_DEFAULT_BATCH, 0, 500);
        if (batch == 0) return "图片回填跳过（已关闭）";
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
            pause(topicPauseMs);
            try {
                Topic topic = getTopic(client, tid);
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

    /**
     * 回填专栏文章完整正文：专栏话题列表接口只返回文章索引（无 talk 正文），
     * 先调用话题详情拿标题、摘要、作者与原文地址，再读取 articles.zsxq.com 正文页。
     *
     * <p>每轮条数由 {@code zsxq.column-article-backfill-batch} 控制；正文为空时
     * 累计失败次数，连续 {@value #ARTICLE_BACKFILL_MAX_FAILS} 次后不再自动重试。</p>
     */
    private String backfillColumnArticles(ZsxqApiClient client, Logger logger,
                                          java.util.function.Consumer<String> progress) {
        int batch = intConfig("zsxq.column-article-backfill-batch", ARTICLE_BACKFILL_DEFAULT_BATCH, 0, 200);
        if (batch == 0) return "专栏正文回填跳过（已关闭）";
        List<Map<String, Object>> rows = jdbc.queryForList(
                "SELECT topic_id FROM zsxq_topic WHERE column_id IS NOT NULL "
                        + "AND (article_content IS NULL OR article_content = '') "
                        + "AND COALESCE(article_fail_count, 0) < " + ARTICLE_BACKFILL_MAX_FAILS
                        + " ORDER BY COALESCE(source_create_time, '') DESC LIMIT " + batch);
        if (rows.isEmpty()) return "专栏正文回填跳过（没有待回填条目）";

        int done = 0, failed = 0;
        for (int i = 0; i < rows.size(); i++) {
            Map<String, Object> row = rows.get(i);
            String tid = rowCell(row, "topic_id");
            if (tid.isBlank()) continue;
            progress.accept("回填专栏正文 " + (i + 1) + "/" + rows.size());
            pause(topicPauseMs);
            try {
                Topic topic = getTopic(client, tid);
                String title = articleTitle(topic);
                String digest = topicDigest(topic);
                String articleUrl = articleUrlOf(topic);
                String author = topicAuthor(topic);
                String authorId = topicAuthorId(topic);
                String content = articleContentOf(topic);
                String contentUrl = articleContentUrlOf(topic);
                if (content.isBlank() && !contentUrl.isBlank()) {
                    pause(topicPauseMs);
                    content = client.getArticleContent(contentUrl);
                }
                updateArticleContent(tid, title, digest, articleUrl, content, author, authorId);
                if (content.isBlank()) {
                    markArticleFailed(tid);
                    failed++;
                    logger.debug("专栏文章暂无可解析正文 topicId={}", tid);
                    continue;
                }
                markArticleSynced(tid);
                done++;
            } catch (Exception e) {
                if (isRiskControl(e)) throw new RiskControlException(e);
                markArticleFailed(tid);
                failed++;
                logger.warn("专栏正文回填失败 topicId={} error={}", tid, e.getMessage());
                if (isAuthOrFatal(e)) {
                    logger.warn("知识星球授权/请求异常，中止本轮专栏正文回填");
                    break;
                }
            }
        }
        return "专栏正文回填 " + done + " 条，失败 " + failed + " 条";
    }

    /** 写入专栏文章标题、摘要、原文链接与完整正文，并补齐作者；空值不覆盖已有数据。 */
    private void updateArticleContent(String topicId, String title, String digest, String articleUrl,
                                      String content, String author, String authorId) {
        jdbc.update("UPDATE zsxq_topic SET "
                        + "article_title = CASE WHEN (article_title IS NULL OR article_title = '') AND ? <> '' THEN ? ELSE article_title END, "
                        + "digest = CASE WHEN (digest IS NULL OR digest = '') AND ? <> '' THEN ? ELSE digest END, "
                        + "article_url = CASE WHEN (article_url IS NULL OR article_url = '') AND ? <> '' THEN ? ELSE article_url END, "
                        + "article_content = CASE WHEN (article_content IS NULL OR article_content = '') AND ? <> '' THEN ? ELSE article_content END, "
                        + "author = CASE WHEN (author IS NULL OR author = '') AND ? <> '' THEN ? ELSE author END, "
                        + "author_id = CASE WHEN (author_id IS NULL OR author_id = '') AND ? <> '' THEN ? ELSE author_id END, "
                        + "update_time = ? WHERE topic_id = ?",
                title, title, digest, digest, articleUrl, articleUrl, content, content,
                author, author, authorId, authorId, LocalDateTime.now(), topicId);
    }

    private void markArticleSynced(String topicId) {
        jdbc.update("UPDATE zsxq_topic SET article_synced_at = ?, article_fail_count = 0, update_time = ? "
                + "WHERE topic_id = ?", System.currentTimeMillis(), LocalDateTime.now(), topicId);
    }

    private void markArticleFailed(String topicId) {
        jdbc.update("UPDATE zsxq_topic SET article_fail_count = COALESCE(article_fail_count, 0) + 1, "
                + "update_time = ? WHERE topic_id = ?", LocalDateTime.now(), topicId);
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

    /** 专栏话题同步：头部增量 + 可选历史回填；返回 [新话题数, 新评论数, 跳过数]。 */
    private int[] syncColumnTopics(ZsxqApiClient client, ZsxqColumn column, Logger logger, boolean fullBackfill) {
        int topics = 0, comments = 0, skipped = 0;
        String gid = safe(column.getGroupId());
        String cid = safe(column.getColumnId());

        // 1) 头部增量：从最新往回抓，直到碰到已同步过的帖子
        String headOldest = "";
        String headEnd = "";
        java.util.Set<String> insertedInHead = new java.util.HashSet<>();
        for (int page = 0; page < headPages; page++) {
            pause(pagePauseMs);
            List<Topic> list;
            try {
                list = listColumnTopics(client, gid, cid, headEnd);
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
                    refreshTopicContentIfEmpty(tid, t);
                    if (refreshOldComments) {
                        comments += refreshCommentsIfGrown(client, gid, t, existing.get(), logger);
                    }
                } else {
                    pause(topicPauseMs);
                    upsertTopic(gid, tid, t, cid);
                    topics++;
                    insertedInHead.add(tid);
                    if (safeInt(t.getCommentsCount()) > 0) comments += fetchComments(client, gid, tid, logger);
                }
            }
            if (existingOnPage > 0 || list.size() < TOPICS_PER_PAGE) break;
        }

        // 2) 历史回填：增量作业只初始化游标；每日回填作业连续翻到最早页
        String end = safe(column.getSyncCursor()).trim();
        if (end.isEmpty() && !headOldest.isEmpty()) end = headOldest;
        if (fullBackfill) {
            column.setSyncCursor(end);
            column.setLastSyncAt(System.currentTimeMillis());
            columnRepository.save(column);
        }
        for (int page = 0; fullBackfill && !end.isEmpty(); page++) {
            pause(pagePauseMs);
            List<Topic> list;
            try {
                list = listColumnTopics(client, gid, cid, end);
            } catch (Exception e) {
                if (isRiskControl(e)) throw new RiskControlException(e);
                logger.warn("专栏 {} 历史话题拉取失败：{}", cid, e.getMessage());
                break;
            }
            if (list == null || list.isEmpty()) break;
            String before = end;
            for (Topic t : list) {
                String tid = toStr(t.getTopicId());
                if (tid.isEmpty()) continue;
                String createTime = safe(t.getCreateTime());
                if (!createTime.isEmpty()) end = createTime;
                java.util.Optional<ZsxqTopic> existing = topicRepository.findByTopicId(tid);
                if (existing.isPresent()) {
                    if (!cid.equals(safe(existing.get().getColumnId()))) assignColumn(tid, cid);
                    skipped++;
                    fillAuthorIfMissing(tid, t, existing.get());
                    refreshTopicContentIfEmpty(tid, t);
                    continue;
                }
                pause(topicPauseMs);
                upsertTopic(gid, tid, t, cid);
                topics++;
                if (safeInt(t.getCommentsCount()) > 0) comments += fetchComments(client, gid, tid, logger);
            }
            column.setSyncCursor(end);
            column.setLastSyncAt(System.currentTimeMillis());
            columnRepository.save(column);
            if (list.size() < TOPICS_PER_PAGE || end.isEmpty() || end.equals(before)) break;
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
        column.setTopicsCount(c.topicsCount());
        column.setVisible(true);
        column.setLastSyncAt(System.currentTimeMillis());
        return columnRepository.save(column);
    }

    private ZsxqApiClient buildClient(String cookie) {
        int riskRetry = intConfig("zsxq.risk-retry-count", RISK_RETRY_DEFAULT, 1, 6);
        long riskRetryPause = intConfig("zsxq.risk-retry-pause-seconds", RISK_RETRY_PAUSE_DEFAULT_SECONDS, 1, 60) * 1000L;
        return new ZsxqApiClient(cookie, riskRetry, riskRetryPause)
                .onRetry(message -> {
                    log.info("[知识星球] {}", message);
                    TaskLog.info("[知识星球] {}", message);
                });
    }

    // ---------- 星球接口：强类型直连，避免 SDK 的 Map/Double 中转导致 64 位 ID 精度丢失 ----------

    private List<Group> listGroups(ZsxqApiClient client) {
        String path = "/v2/groups";
        GroupPage page = api("GET " + path, () -> client.get(path, GroupPage.class));
        return page == null || page.groups == null ? List.of() : page.groups;
    }

    private List<Topic> listTopics(ZsxqApiClient client, String gid, String endTime) {
        Map<String, Object> query = new LinkedHashMap<>();
        query.put("count", TOPICS_PER_PAGE);
        query.put("scope", "all");
        if (endTime != null && !endTime.isEmpty()) query.put("end_time", endTime);
        String path = "/v2/groups/" + gid + "/topics";
        String desc = "GET " + path + (endTime == null || endTime.isEmpty() ? "" : "?end_time=" + endTime);
        TopicPage page = api(desc, () -> client.get(path, query, TopicPage.class));
        return page == null || page.topics == null ? List.of() : page.topics;
    }

    private List<Topic> listColumnTopics(ZsxqApiClient client, String gid, String cid, String endTime) {
        Map<String, Object> query = new LinkedHashMap<>();
        query.put("count", TOPICS_PER_PAGE);
        query.put("scope", "all");
        if (endTime != null && !endTime.isEmpty()) query.put("end_time", endTime);
        String path = "/v2/groups/" + gid + "/columns/" + cid + "/topics";
        String desc = "GET " + path + (endTime == null || endTime.isEmpty() ? "" : "?end_time=" + endTime);
        TopicPage page = api(desc, () -> client.get(path, query, TopicPage.class));
        return page == null || page.topics == null ? List.of() : page.topics;
    }

    private Topic getTopic(ZsxqApiClient client, String tid) {
        String path = "/v2/topics/" + tid + "/info";
        TopicDetail detail = api("GET " + path, () -> client.get(path, TopicDetail.class));
        return detail == null ? null : detail.topic;
    }

    private List<Comment> listComments(ZsxqApiClient client, String tid) {
        Map<String, Object> query = new LinkedHashMap<>();
        query.put("sort", "asc");
        query.put("count", COMMENTS_PER_TOPIC);
        String path = "/v2/topics/" + tid + "/comments";
        CommentPage page = api("GET " + path, () -> client.get(path, query, CommentPage.class));
        return page == null || page.comments == null ? List.of() : page.comments;
    }

    private List<Column> listColumns(ZsxqApiClient client, String gid) {
        String path = "/v2/groups/" + gid + "/columns";
        ColumnPage page = api("GET " + path, () -> client.get(path, ColumnPage.class));
        return page == null || page.columns == null ? List.of() : page.columns;
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

    private int fetchComments(ZsxqApiClient client, String groupId, String topicId, Logger logger) {
        try {
            List<Comment> list = listComments(client, topicId);
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
            pause(topicPauseMs);
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
        if (!(e instanceof ZsxqApiException api)) return false;
        int code = api.getCode();
        // Token 失效/权限/限流不是删除，避免误标
        if (code == 10001 || code == 10002 || code == 10003 || code == 40001) return false;
        if (code == CODE_TOPIC_GONE) return true;
        String msg = api.getMessage();
        return msg != null && GONE_MESSAGE.matcher(msg).find();
    }

    /** Cookie 失效、权限不足、限流等与单帖无关的错误：本轮直接中止。 */
    private static boolean isAuthOrFatal(Exception e) {
        if (!(e instanceof ZsxqApiException api)) return false;
        int code = api.getCode();
        return code == 401 || code == 403 || code == 10001 || code == 10002 || code == 10003 || code == 40001;
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

    // ---------- 管理：清空抓取数据 ----------

    /**
     * 清空抓取数据（管理页调用）：删除指定星球（groupId 为空时全部星球）的话题、评论、专栏、
     * 同步游标与已入库正文图片，保留星球列表与启用设置。
     *
     * <p>清空后同时重置专栏同步节流时间，下一轮同步会重新抓取专栏；图片按剩余引用过滤后删除，
     * 多个星球共用的对象不会被误删。风控冷却与 Cookie 状态保持不变。</p>
     *
     * @return 各表删除数量（topics/comments/columns/images）
     */
    public Map<String, Object> clearScrapedData(String groupId) {
        ensureTables();
        String group = groupId == null || groupId.isBlank() ? null : groupId.trim();
        String where = group == null ? "" : " WHERE group_id = ?";
        Object[] args = group == null ? new Object[0] : new Object[]{group};

        List<String> imageKeys = new ArrayList<>();
        for (Map<String, Object> row : jdbc.queryForList("SELECT images, cover FROM zsxq_topic" + where, args)) {
            imageKeys.addAll(imageService.parseKeys(rowCell(row, "images")));
            String cover = rowCell(row, "cover");
            if (cover.startsWith(ZsxqImageService.KEY_PREFIX)) imageKeys.add(cover);
        }

        int comments = jdbc.update("DELETE FROM zsxq_comment" + where, args);
        int columns = jdbc.update("DELETE FROM zsxq_column" + where, args);
        int topics = jdbc.update("DELETE FROM zsxq_topic" + where, args);
        jdbc.update("DELETE FROM zsxq_sync_state" + where, args);
        // 清空专栏后解除全局节流，避免专栏要等 24 小时才重新入库
        jdbc.update("DELETE FROM zsxq_job_state WHERE state_key = ?", STATE_COLUMNS_LAST_OK);

        // 正文图片按剩余引用过滤：多个星球共用同一张图时不能误删
        java.util.Set<String> retained = new java.util.HashSet<>();
        for (Map<String, Object> row : jdbc.queryForList("SELECT images, cover FROM zsxq_topic")) {
            retained.addAll(imageService.parseKeys(rowCell(row, "images")));
            String cover = rowCell(row, "cover");
            if (cover.startsWith(ZsxqImageService.KEY_PREFIX)) retained.add(cover);
        }
        List<String> deletable = new ArrayList<>();
        for (String key : new java.util.LinkedHashSet<>(imageKeys)) {
            if (!retained.contains(key)) deletable.add(key);
        }
        imageService.deleteKeys(deletable);

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("topics", topics);
        result.put("comments", comments);
        result.put("columns", columns);
        result.put("images", deletable.size());
        return result;
    }

    /** 读取查询行的字符串值，兼容 H2（大写列名）与 MySQL（小写列名）。 */
    private static String rowCell(Map<String, Object> row, String name) {
        Object value = row.containsKey(name) ? row.get(name) : row.get(name.toUpperCase(java.util.Locale.ROOT));
        return value == null ? "" : String.valueOf(value).trim();
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

    /** 取话题里的长文章元数据：部分接口放在顶层，部分放在 talk.article。 */
    private static Article articleOf(Topic t) {
        if (t == null) return null;
        if (t.getArticle() != null) return t.getArticle();
        TalkContent talk = t.getTalk();
        return talk == null ? null : talk.getArticle();
    }

    /** 长文章原文地址（没有则返回空串）。 */
    private static String articleUrlOf(Topic t) {
        Article article = articleOf(t);
        return article == null ? "" : safe(article.url()).trim();
    }

    /** 长文章完整正文页地址（优先 inline_article_url）。 */
    static String articleContentUrlOf(Topic t) {
        Article article = articleOf(t);
        return article == null ? "" : safe(article.contentUrl()).trim();
    }

    /** 长文章内嵌正文 HTML；没有时回退到话题顶层 content。 */
    static String articleContentOf(Topic t) {
        if (t == null) return "";
        Article article = articleOf(t);
        if (article == null) return "";
        String content = safe(article.getContent()).trim();
        return content.isEmpty() ? safe(t.getContent()).trim() : content;
    }

    private static String articleTitle(Topic t) {
        Article article = articleOf(t);
        String title = article == null ? "" : safe(article.getTitle()).trim();
        return title.isEmpty() ? safe(t.getTitle()).trim() : title;
    }

    /**
     * 话题摘要：普通话题取 talk.text；长文章取标题 + 摘要/正文；
     * 都没有时返回空串（由专栏文章回填任务后续处理）。
     */
    private static String topicDigest(Topic t) {
        if (t == null) return "";
        TalkContent talk = t.getTalk();
        String text = talk == null ? "" : safe(talk.getText());
        if (!text.isBlank()) return truncate(text, ZsxqTopic.DIGEST_MAX_LENGTH);

        Article article = articleOf(t);
        String title = articleTitle(t);
        String body = article == null ? "" : safe(article.getSummary()).trim();
        if (body.isEmpty() && article != null) body = stripHtml(article.getContent());
        if (body.isEmpty()) body = stripHtml(t.getContent());
        if (title.isEmpty() && body.isEmpty()) return "";
        if (title.isEmpty()) return truncate(body, ZsxqTopic.DIGEST_MAX_LENGTH);
        if (body.isEmpty()) return truncate(title, ZsxqTopic.DIGEST_MAX_LENGTH);
        return truncate(title + "\n" + body, ZsxqTopic.DIGEST_MAX_LENGTH);
    }

    /** 作者优先取 talk.owner，其次取话题顶层 owner（专栏文章列表）。 */
    private static String topicAuthor(Topic t) {
        if (t == null) return "";
        User owner = t.getTalk() != null && t.getTalk().getOwner() != null
                ? t.getTalk().getOwner() : t.getOwner();
        return owner == null ? "" : safe(owner.getName()).trim();
    }

    private static String topicAuthorId(Topic t) {
        if (t == null) return "";
        User owner = t.getTalk() != null && t.getTalk().getOwner() != null
                ? t.getTalk().getOwner() : t.getOwner();
        return owner == null ? "" : normalizeId(owner.getUserId());
    }

    /** 长文章正文是 HTML：粗转纯文本并压缩空白，避免摘要里出现标签。 */
    private static String stripHtml(String html) {
        String s = safe(html).replaceAll("<[^>]*>", " ");
        s = s.replace("&nbsp;", " ").replace("&amp;", "&").replace("&lt;", "<")
                .replace("&gt;", ">").replace("&quot;", "\"").replace("&#39;", "'");
        return s.replaceAll("\\s+", " ").trim();
    }

    private void upsertTopic(String gid, String tid, Topic t, String columnId) {
        String digest = topicDigest(t);
        String title = articleTitle(t);
        String articleUrl = articleUrlOf(t);
        String articleContent = articleContentOf(t);
        Long articleSyncedAt = articleContent.isBlank() ? null : System.currentTimeMillis();
        TalkContent talk = t.getTalk();

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
                        + "source_create_time, cover, images, image_synced_at, image_fail_count, article_title, "
                        + "article_url, article_content, article_synced_at, article_fail_count, visible, create_time, update_time) "
                        + "SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, TRUE, ?, ? WHERE NOT EXISTS "
                        + "(SELECT 1 FROM zsxq_topic WHERE topic_id = ?)",
                UUID.randomUUID().toString().replace("-", ""), tid, gid, column, digest, comments, likes,
                sourceTime, cover, imagesJson, imageSyncedAt, imageFailCount, title, articleUrl, articleContent,
                articleSyncedAt, LocalDateTime.now(), LocalDateTime.now(), tid);

        // 话题作者：来自话题内容的 owner（长文章可能只在话题顶层）；已有帖子也由此逐步补齐
        String author = topicAuthor(t);
        String authorId = topicAuthorId(t);
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
     * 知识星球 API 交互的统一包装：记录请求描述（方法 + 关键参数）、结果规模与耗时；
     * 错误同时写入应用日志与任务日志，便于在「定时任务 → 执行记录」里直接定位。
     */
    private <T> T api(String desc, java.util.function.Supplier<T> call) {
        lastApiDesc = desc;
        requestsUsed++;

        long start = System.currentTimeMillis();
        log.info("[知识星球] 请求：{}", desc);
        TaskLog.info("[知识星球] 请求：{}", desc);
        T result;
        try {
            result = call.get();
        } catch (RuntimeException e) {
            long elapsed = System.currentTimeMillis() - start;
            log.error("[知识星球] 请求失败：{}（{} ms）error={}", desc, elapsed, e.getMessage());
            TaskLog.error("[知识星球] 请求失败：{}（{} ms）error={}", desc, elapsed, e.getMessage());
            throw e;
        }
        long elapsed = System.currentTimeMillis() - start;
        log.info("[知识星球] 响应：{}（{} ms）-> {}", desc, elapsed, summary(result));
        TaskLog.info("[知识星球] 响应：{}（{} ms）-> {}", desc, elapsed, summary(result));
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
