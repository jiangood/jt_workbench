/**
 * zsxq_sync：知识星球全量采集（issue #7）
 *
 * 一轮 = 领到任务后，按星球串行做三件事：
 *   1) 帖子分页回溯（从 Worker 注入的 cursors[gid].cursor 继续往老翻，最多 15 页）
 *   2) 对本轮新增/更新的帖子逐帖拉评论（每帖最多 5 页 / 30 条一页，整轮共用 40 次请求预算）
 *   3) 回传一条 kind='sync_state' 的进度行（cursor = 本轮处理到最老一条的 create_time）
 *
 * 关键不变量：
 *   - 游标只推进到「评论也处理完」的最后一条帖子，没处理的帖子仍在更老的一侧，下一轮重抓（入库幂等，不丢数据）
 *   - 评论预算/耗时用尽就提前收尾，回头还传 sync_state，绝不空转到 lease 超时
 *   - 星主拿不到不致命：isOwner 一律 0，并在 sync_state.note + summary 里注明
 *   - 全程尊重 ctx.signal（被回收/易主立即中止，已抓到的 items 照常回传，靠 Worker 侧幂等吸收）
 */

import { z } from 'zod'
import { describeError } from '../describe-error.js'
import {
  ZsxqClient,
  ZsxqApiError,
  type ZsxqComment,
  type ZsxqFileRef,
  type ZsxqGroupDetail,
  type ZsxqImage,
  type ZsxqTopic,
  type ZsxqTopicInfo,
  type ZsxqUser,
} from '../zsxq-client.js'
import type { JobHandler } from '../types.js'

/** lease 10min：留 2min 给心跳与 items 回传（回传按 100 条/批，几十条也就几秒） */
const LEASE_BUDGET_MS = 8 * 60_000
/** 回溯模式每轮最多翻页数（每页 count 条，默认 20） */
const BACKFILL_MAX_PAGES = 15
/** done 星球只扫最近 2 页找新帖（第 2 页兜底：刚好跨页时上一页的尾巴也能补上） */
const INCREMENTAL_MAX_PAGES = 2
const COMMENT_PAGE_SIZE = 30
const COMMENT_MAX_PAGES = 5
/**
 * 整轮评论请求上限：超出就提前收尾，下一轮继续（评论比帖子慢，单独限流）。
 * 其中 REFRESH_RESERVE 预留给「老帖评论对账」——列表页只看得到最近两页，
 * 更老的帖子靠 Worker 下发的 refresh 队列按最久未对账轮转补拉。
 */
const COMMENT_REQUEST_BUDGET = 75
const REFRESH_RESERVE = 30
/** 删除探测上限：每个帖子一次详情请求，按 Worker 下发的轮转队列最久未探测优先 */
const CHECK_REQUEST_BUDGET = 30

const tokenSchema = z.string().min(1, '缺少知识星球 token：请到「知识星球」页的「同步配置」填写')

const cursorSchema = z.object({
  cursor: z.string().nullish(),
  done: z.union([z.boolean(), z.number()]).nullish(),
})

/** Worker 下发的对账目标：评论补拉（refresh）/ 删除探测（check）共用 */
const targetSchema = z.object({
  topicId: z.string().min(1),
  groupId: z.string().min(1),
})

const syncPayloadSchema = z
  .object({
    groupId: z.string().min(1).optional(), // 旧版 payload（单星球），滚动升级期间兼容
    groupIds: z.array(z.string().min(1)).max(50).optional(),
    count: z.number().int().min(1).max(30).default(20),
    endTime: z.string().optional(), // 旧版游标（YYYY-MM-DDTHH:mm:ss.SSS+0800）
    /** Worker 从 zsxq_sync_state 注入：{ [groupId]: { cursor, done } }；缺省 = 从头回溯 */
    cursors: z.record(z.string(), cursorSchema).optional(),
    /** 老帖评论对账队列（最久没对账的优先）；列表页之外的帖子靠它保证评论不漏 */
    refresh: z.array(targetSchema).max(100).optional(),
    /** 删除探测队列（最久没探测的优先）；详情接口查不到 = 已删除 */
    check: z.array(targetSchema).max(100).optional(),
    token: tokenSchema,
  })
  .refine((v) => (v.groupIds?.length ?? 0) > 0 || !!v.groupId, { message: '缺少 groupId' })

const groupsPayloadSchema = z.object({ token: tokenSchema })

interface CommentBatch {
  items: Record<string, unknown>[]
  /** 实际发出的请求数（调用方据此扣全局预算） */
  requests: number
}

export const zsxqHandler: JobHandler = async (payload, ctx) => {
  const { groupId, groupIds: rawIds, count, endTime, cursors, refresh, check, token } =
    syncPayloadSchema.parse(payload)
  const groupIds = [...new Set(rawIds?.length ? rawIds : [groupId!])]
  const client = new ZsxqClient(token)
  const startedAt = Date.now()
  const outOfTime = () => Date.now() - startedAt > LEASE_BUDGET_MS

  // 沿用旧系统的克制节奏：开跑前先随机停顿，避免触发风控
  if (!(await pause(ctx.signal, 1000 + Math.random() * 2000))) return { items: [], summary: 'aborted' }

  // 顺带刷新星球名称（失败不影响同步结果；名称随 items 回传，Worker 落库给页面勾选用）
  const groupNames = new Map<string, string>()
  try {
    const groups = await client.listGroups(ctx.signal)
    for (const g of groups.groups ?? []) groupNames.set(String(g.group_id), g.name)
  } catch (e) {
    logWarn('groups.list', e)
  }

  const items: Record<string, unknown>[] = []
  const failures: string[] = []
  /** 拿不到星主身份的星球：summary 里统一说明，避免用户以为 is_owner 判定全坏了 */
  let noOwnerGroups = 0
  /** 评论预算用尽、整轮跳过的星球（游标不动，下一轮优先接着跑） */
  let skippedGroups = 0
  let topicCount = 0
  let commentCount = 0
  let commentFailures = 0
  /** 本轮帖子列表扫描可用的评论预算（预留一部分给老帖对账） */
  let commentBudget = Math.max(0, COMMENT_REQUEST_BUDGET - REFRESH_RESERVE)
  let aborted = false
  /** 本轮至少成功调通过接口的星球：这些星球的「详情查不到」才可信，避免把整组权限故障当成帖子被删 */
  const groupOk = new Set<string>()
  /** 星主 ID 按星球缓存，老帖评论对账时继续用同一套 is_owner 标记 */
  const ownerByGroup = new Map<string, string | null>()
  let checkedTopics = 0
  let goneTopics = 0
  let refreshedTopics = 0
  let refreshRequests = 0

  const emitState = (
    gid: string,
    cursor: string | null,
    done: boolean,
    remarks: string[],
    scanFrom: number | null,
    scanTo: number | null,
  ) => {
    items.push({
      kind: 'sync_state',
      groupId: gid,
      cursor: cursor ?? null,
      done: done ? 1 : 0,
      note: remarks.length ? remarks.join('；') : null,
      // 本轮完整覆盖的帖子时间窗口（毫秒）：Worker 用它发现「库里还在、列表里没了」的帖子
      scanFrom,
      scanTo,
    })
  }

  for (const [index, gid] of groupIds.entries()) {
    if (ctx.signal.aborted) {
      aborted = true
      break
    }
    // 预算已见底：整轮不碰这个星球（不抓帖子 = 游标不动 = 数据不丢，下一轮接着来）
    if (commentBudget <= 0) {
      skippedGroups++
      continue
    }

    const state = cursors?.[gid]
    const alreadyDone = state?.done === true || state?.done === 1
    // 旧 payload 的 endTime 只在没存过游标时用一次（单星球时代的断点）
    const startCursor = state?.cursor ?? (state ? null : endTime) ?? null
    const remarks: string[] = []

    // ① 星主：每个星球每轮最多查一次；失败就置空，isOwner 全按 0 走
    let ownerId: string | null = null
    try {
      ownerId = pickOwnerId(await client.groupDetail(gid, ctx.signal))
    } catch (e) {
      if (ctx.signal.aborted) {
        aborted = true
        break
      }
      logWarn(`groups.detail ${gid}`, e)
    }
    ownerByGroup.set(gid, ownerId)
    if (!ownerId) {
      noOwnerGroups++
      remarks.push('未能确认星主身份')
    }

    // ② 帖子分页（done 星球只扫首页，回溯模式一路往老翻）
    const groupName = groupNames.get(gid) ?? null
    const maxPages = alreadyDone ? INCREMENTAL_MAX_PAGES : BACKFILL_MAX_PAGES
    // 评论预算按「剩余星球数」均分，避免第一个星球把预算用光、后面的星球永远轮不到
    const groupsLeft = groupIds.length - index
    let groupCommentBudget = Math.max(1, Math.floor(commentBudget / groupsLeft))
    // scanCursor 只管本轮翻页（end_time）；nextCursor 才是回传给 Worker 的断点
    // done 星球不回写 nextCursor：它的 cursor 已经是历史尽头，每轮从「不带到 end_time 的首页」开始找新帖
    let scanCursor = startCursor
    // done 星球不从历史游标起翻（否则永远返回空页），所以比较基准也从空开始
    let scanCursorMs = alreadyDone || !scanCursor ? null : Date.parse(scanCursor)
    let groupDone = alreadyDone
    let nextCursor = startCursor
    let pageEnd: string | undefined = alreadyDone ? undefined : startCursor ?? undefined
    let stopped = false
    /** stopped 的原因是「评论预算/耗时」而不是抓取失败（summary 与 note 用词不同） */
    let budgetStop = false
    /** 本轮完整覆盖的帖子时间窗口：scanFrom = 最新一条，scanTo = 完整翻完的最老一条 */
    let scanFromMs: number | null = null
    let coveredToMs: number | null = null
    /**
     * 列表是否严格按时间倒序。置顶帖可能被接口提到最前（时间跳回很老），
     * 这时区间不再连续，不能拿它做「列表里消失 = 已删除」的对账，直接放弃本轮的窗口。
     */
    let monotonic = true
    let lastSeenMs: number | null = null

    for (let page = 0; page < maxPages; page++) {
      if (ctx.signal.aborted) {
        aborted = true
        stopped = true
        break
      }
      if (outOfTime()) {
        stopped = true
        budgetStop = true
        break
      }
      if (groupCommentBudget <= 0) {
        stopped = true
        budgetStop = true
        break
      }
      if (page > 0 && !(await pause(ctx.signal))) {
        aborted = true
        stopped = true
        break
      }

      let data: { topics?: ZsxqTopic[] }
      try {
        data = await client.listTopics(gid, count, pageEnd, ctx.signal)
      } catch (e) {
        // 单页失败：已抓到的照常回传，游标停在上一页，下一轮从同一位置重试
        failures.push(`${gid}: ${describeError(e)}`)
        if (ctx.signal.aborted) aborted = true
        stopped = true
        break
      }

      groupOk.add(gid)
      const topics = (data.topics ?? []) as ZsxqTopic[]
      if (!topics.length) {
        // 空页 = 已回溯到历史尽头
        groupDone = true
        break
      }

      let processed = 0
      let pageNewestMs: number | null = null
      let pageOldestMs: number | null = null
      let pageBreak = false
      /** 整页都处理完（没有因预算 / 中止在半路停下）→ 这页的时间区间才算「已完整扫描」 */
      let pageComplete = true

      for (const t of topics) {
        if (!t || t.topic_id == null) continue
        // comments_count 明确为 0 就不打接口（省预算）；字段缺失时保守地拉一次
        const wantsComments = typeof t.comments_count !== 'number' || t.comments_count > 0
        // 评论预算用尽：连这条帖子都不收（否则游标越过它、评论永远补不上）→ 留给下一轮
        if (wantsComments && groupCommentBudget <= 0) {
          stopped = true
          budgetStop = true
          pageBreak = true
          pageComplete = false
          break
        }

        const topicId = String(t.topic_id)
        const createdRaw = typeof t.create_time === 'string' && t.create_time ? t.create_time : null
        const createdMs = createdRaw ? Date.parse(createdRaw) : NaN
        const ownerUser = t.talk?.owner ?? t.owner
        const authorId = userId(ownerUser)
        const isOwner = isOwnerFlag(authorId, ownerId)
        const files = fileList(t.talk?.files, isOwner)

        items.push({
          // 无 kind = 帖子（旧 agent 的写法，Worker 侧按同一分支处理）
          kind: 'topic',
          topicId,
          groupId: gid,
          groupName,
          title: t.title ?? null,
          talkText: t.talk?.text ?? null,
          images: imageList(t.talk?.images),
          files,
          authorId,
          authorName: ownerUser?.name ?? null,
          isOwner,
          commentsCount: typeof t.comments_count === 'number' ? t.comments_count : 0,
          likesCount: typeof t.likes_count === 'number' ? t.likes_count : 0,
          createTime: Number.isFinite(createdMs) ? createdMs : null,
        })
        topicCount++
        processed++
        if (Number.isFinite(createdMs)) {
          if (lastSeenMs !== null && createdMs > lastSeenMs) monotonic = false
          lastSeenMs = createdMs
          if (pageNewestMs === null || createdMs > pageNewestMs) pageNewestMs = createdMs
          pageOldestMs = createdMs
        }
        // 游标只认「评论也抓完」的最后一条：后面的帖子还在更老一侧，下一轮重抓（入库幂等）
        if (createdRaw) scanCursor = createdRaw

        // ③ 评论：本轮新增/更新的帖子逐帖拉；请求预算用尽就收尾（剩下的留到下一轮）
        if (!wantsComments) continue
        try {
          const got = await collectComments(
            client,
            gid,
            topicId,
            ownerId,
            ctx.signal,
            groupCommentBudget,
            outOfTime,
          )
          groupCommentBudget -= got.requests
          commentBudget -= got.requests
          commentCount += got.items.length
          items.push(...got.items)
          // 对账时间戳：0 条评论也算「刚核对过」，Worker 落 comments_checked_at 后排队尾
          items.push({ kind: 'comment_state', topicId, groupId: gid })
        } catch (e) {
          // 评论失败只记账，不中断整轮（帖子已经入库，评论下一轮随帖子重抓再补）
          if (ctx.signal.aborted) {
            aborted = true
            stopped = true
            pageBreak = true
            pageComplete = false
            break
          }
          logWarn(`topics.comments ${topicId}`, e)
          commentFailures++
          // note 只留前几条，避免 sync_state 被长串失败列表撑爆
          if (commentFailures <= 3) remarks.push(`评论抓取失败 ${topicId}`)
        }
      }

      if (processed > 0 && pageOldestMs !== null) {
        // 往回翻时游标必须变老；没变老说明这已经是历史尽头（或接口不认 end_time）→ 收尾防死循环
        if (scanCursorMs !== null && pageOldestMs >= scanCursorMs) {
          groupDone = true
          pageBreak = true
        }
        scanCursorMs = pageOldestMs
      }
      // 记录完整覆盖的下界：半路停下的页不算，否则没入库的帖子会被误判成「已删除」
      if (pageComplete && monotonic && pageOldestMs !== null) {
        if (scanFromMs === null && pageNewestMs !== null) scanFromMs = pageNewestMs
        coveredToMs = pageOldestMs
      }
      if (!alreadyDone) nextCursor = scanCursor
      if (pageBreak || stopped) break
      if (scanCursor) pageEnd = scanCursor
    }

    if (budgetStop && !aborted) remarks.push('本轮提前收尾（评论预算/耗时），下一轮继续')
    emitState(gid, nextCursor ?? null, groupDone, remarks, scanFromMs, coveredToMs)

    if (index < groupIds.length - 1 && !(await pause(ctx.signal))) {
      aborted = true
      break
    }
  }

  if (aborted) return { items, summary: 'aborted' }

  // ④ 老帖评论对账：列表页只看得到最近两页，更老的帖子靠 Worker 的轮转队列定期补拉。
  //    预算 = 预留的 REFRESH_RESERVE + 本轮列表扫描没用完的部分。
  let refreshBudget = REFRESH_RESERVE + Math.max(0, commentBudget)
  for (const target of refresh ?? []) {
    if (ctx.signal.aborted) {
      aborted = true
      break
    }
    if (refreshBudget <= 0 || outOfTime()) break
    if (!groupOk.has(target.groupId)) continue // 本轮没成功访问过这个星球：留到下一轮
    if (!(await pause(ctx.signal, 600 + Math.random() * 600))) {
      aborted = true
      break
    }
    try {
      const got = await collectComments(
        client,
        target.groupId,
        target.topicId,
        ownerByGroup.get(target.groupId) ?? null,
        ctx.signal,
        refreshBudget,
        outOfTime,
      )
      if (!got.requests) break // 时间刚好用尽：这条不算对账过，下一轮还排在最前
      refreshBudget -= got.requests
      refreshRequests += got.requests
      commentCount += got.items.length
      refreshedTopics++
      items.push(...got.items)
      items.push({ kind: 'comment_state', topicId: target.topicId, groupId: target.groupId })
    } catch (e) {
      if (ctx.signal.aborted) {
        aborted = true
        break
      }
      logWarn(`refresh.comments ${target.topicId}`, e)
      commentFailures++
    }
  }

  // ⑤ 删除探测：详情 / 评论接口都读不到 → 回传 alive=0，Worker 连续两轮确认后软删标记。
  //    只探测「本轮成功访问过」的星球，避免整组权限故障（退出星球 / token 失效）被误判成帖子被删。
  let checkBudget = CHECK_REQUEST_BUDGET
  /** 本轮每个星球认定的存活数：一组里一条活的都没有 = 接口/权限异常，宁可不标也不误标 */
  const probeAlive = new Map<string, number>()
  const gone: Array<{
    topicId: string
    groupId: string
    code: number | null
    message: string
  }> = []

  for (const target of check ?? []) {
    if (ctx.signal.aborted) {
      aborted = true
      break
    }
    if (checkBudget <= 0 || outOfTime()) break
    if (!groupOk.has(target.groupId)) continue
    checkBudget--
    try {
      const probe = await probeTopic(client, target.topicId, ctx.signal)
      checkedTopics++
      if (probe.alive) {
        probeAlive.set(target.groupId, (probeAlive.get(target.groupId) ?? 0) + 1)
        items.push({
          kind: 'topic_check',
          topicId: target.topicId,
          groupId: target.groupId,
          status: 'alive',
          commentsCount: infoCount(probe.info, 'comments'),
          likesCount: infoCount(probe.info, 'likes'),
        })
      } else {
        gone.push({
          topicId: target.topicId,
          groupId: target.groupId,
          code: probe.error instanceof ZsxqApiError ? probe.error.code : null,
          message: describeError(probe.error).slice(0, 200),
        })
      }
    } catch (e) {
      if (ctx.signal.aborted) {
        aborted = true
        break
      }
      logWarn(`topics.probe ${target.topicId}`, e)
    }
    if (!(await pause(ctx.signal, 700 + Math.random() * 600))) {
      aborted = true
      break
    }
  }

  // 只回传「同组至少一条存活」的删除结果；整组都读不到 = 接口/权限异常，
  // 回 unknown 让 Worker 只推进 checked_at（排队尾），不累计删除计数，下一轮换一批再试。
  for (const g of gone) {
    const trusted = (probeAlive.get(g.groupId) ?? 0) > 0
    if (trusted) goneTopics++
    items.push({
      kind: 'topic_check',
      topicId: g.topicId,
      groupId: g.groupId,
      status: trusted ? 'gone' : 'unknown',
      code: g.code,
      message: g.message,
    })
  }

  if (aborted) return { items, summary: 'aborted' }

  // 只有「所有星球一条帖都没抓到」才算整轮失败（Worker 会按退避重试）；
  // 中途某页失败但已有进度时照常回传 + 写游标，下一轮从断点续跑，不白费已抓的数据
  if (topicCount === 0 && failures.length >= groupIds.length) {
    throw new Error(`知识星球同步失败：${failures.join('；')}`)
  }

  return {
    items,
    summary:
      `zsxq ${groupIds.length} 个星球：${topicCount} topics，${commentCount} comments` +
      (noOwnerGroups ? `，${noOwnerGroups} 个星球未能确认星主身份` : '') +
      (skippedGroups ? `，${skippedGroups} 个星球因评论预算用尽留到下一轮` : '') +
      (commentFailures ? `，${commentFailures} 帖评论抓取失败（随帖子下一轮重抓）` : '') +
      (refreshedTopics
        ? `，老帖评论对账 ${refreshedTopics} 帖 / ${refreshRequests} 次请求`
        : '') +
      (checkedTopics ? `，存活探测 ${checkedTopics} 帖` : '') +
      (goneTopics ? `，本轮确认已删除 ${goneTopics} 帖` : '') +
      (commentBudget <= 0 ? '，评论请求预算已用尽' : '') +
      (failures.length ? `，失败 ${failures.length} 个（${failures.join('；')}）` : ''),
  }
}

/**
 * 拉单个帖子的评论（最多 COMMENT_MAX_PAGES 页 / maxRequests 次请求）。
 * sort=asc + end_time 逐页往后翻；接口不认 end_time 会返回同一页，用「没有新 id」兜底停住。
 * 抛错交给调用方记账（不中断整轮）。
 */
async function collectComments(
  client: ZsxqClient,
  gid: string,
  topicId: string,
  ownerId: string | null,
  signal: AbortSignal,
  maxRequests: number,
  outOfTime: () => boolean,
): Promise<CommentBatch> {
  const items: Record<string, unknown>[] = []
  const seen = new Set<string>()
  const pages = Math.min(COMMENT_MAX_PAGES, Math.max(0, maxRequests))
  let requests = 0
  let endTime: string | undefined

  for (let page = 0; page < pages; page++) {
    if (signal.aborted || outOfTime()) break
    if (page > 0 && !(await pause(signal))) break

    const data = await client.listComments(topicId, COMMENT_PAGE_SIZE, endTime, signal)
    requests++
    const list = (data.comments ?? []) as ZsxqComment[]
    if (!list.length) break

    let fresh = 0
    let lastRaw: string | null = null
    for (const c of list) {
      if (!c || c.comment_id == null) continue
      if (typeof c.create_time === 'string' && c.create_time) lastRaw = c.create_time
      const id = String(c.comment_id)
      if (seen.has(id)) continue
      seen.add(id)
      fresh++
      const authorId = userId(c.owner)
      const isOwner = isOwnerFlag(authorId, ownerId)
      items.push({
        kind: 'comment',
        commentId: id,
        topicId,
        groupId: gid,
        authorId,
        authorName: c.owner?.name ?? null,
        isOwner,
        text: c.text ?? null,
        images: imageList(c.images),
        // 评论附件归属帖子 + 评论（Worker 侧 zsxq_file.comment_id）
        files: fileList(c.files, isOwner),
        createTime: parseTime(c.create_time),
      })
    }
    if (!fresh) break // 接口把 end_time 当包含边界返回同一页：停
    if (list.length < COMMENT_PAGE_SIZE) break // 最后一页
    if (lastRaw) endTime = lastRaw
  }

  return { items, requests }
}

/**
 * 主题存活探测：先走详情（顺带拿最新互动计数），详情不可用时退回评论接口。
 * 两个接口都给出「非瞬时错误」才判定不存在——单个接口的兼容性问题不至于把正常帖子标成删除。
 */
async function probeTopic(
  client: ZsxqClient,
  topicId: string,
  signal: AbortSignal,
): Promise<
  | { alive: true; info: { topic?: ZsxqTopicInfo } | null }
  | { alive: false; error: unknown }
> {
  try {
    return { alive: true, info: await client.topicInfo(topicId, signal) }
  } catch (e) {
    if (!isGoneError(e)) throw e
    try {
      await client.listComments(topicId, 1, undefined, signal)
      return { alive: true, info: null }
    } catch (e2) {
      if (!isGoneError(e2)) throw e2
      return { alive: false, error: e }
    }
  }
}

/**
 * 详情接口失败是否可判定为「帖子不存在」。
 * 只认非瞬时错误；token 失效 / 未登录（1001 / 401）是凭据问题，不能拿来标删除。
 */
function isGoneError(e: unknown): boolean {
  if (!(e instanceof ZsxqApiError)) return false
  if (e.retryable) return false
  return e.code !== 1001 && e.code !== 401
}

/** 详情里的互动计数：counts.comments / counts.likes，兼容顶层 comments_count / likes_count */
function infoCount(info: { topic?: ZsxqTopicInfo } | null | undefined, key: 'comments' | 'likes'): number | null {
  const t = info?.topic
  const n = t?.counts?.[key] ?? (key === 'comments' ? t?.comments_count : t?.likes_count)
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : null
}

/** 星主 user_id：兼容 {group:{owner}} / {owner} / {owner_id} 三种返回形态 */
function pickOwnerId(detail: ZsxqGroupDetail | null | undefined): string | null {
  const g = detail?.group ?? detail
  const uid = g?.owner?.user_id ?? g?.owner_id
  return uid === undefined || uid === null ? null : String(uid)
}

function userId(u: ZsxqUser | undefined | null): string | null {
  return u?.user_id === undefined || u?.user_id === null ? null : String(u.user_id)
}

/** 星主标记：ownerId 未知时一律 0（宁可漏标，不误标） */
function isOwnerFlag(uid: string | null, ownerId: string | null): number {
  return uid !== null && ownerId !== null && uid === ownerId ? 1 : 0
}

function imageList(images?: ZsxqImage[]): Array<{ u: string; w: number | null; h: number | null }> {
  const out: Array<{ u: string; w: number | null; h: number | null }> = []
  for (const im of images ?? []) {
    const best = im?.original ?? im?.large ?? im?.middle
    if (!best?.url) continue
    out.push({ u: best.url, w: im.original?.width ?? null, h: im.original?.height ?? null })
  }
  return out
}

/** 附件：fileId 必需（没有 file_id 的老数据只留在帖子的 files JSON 里，不落 zsxq_file） */
function fileList(files: ZsxqFileRef[] | undefined, isOwner: number) {
  return (files ?? [])
    .filter((f) => f && f.file_id !== undefined && f.file_id !== null)
    .map((f) => ({
      fileId: f.file_id,
      name: f.name ?? null,
      size: typeof f.size === 'number' ? f.size : null,
      isOwner,
    }))
}

function parseTime(raw?: string | null): number | null {
  if (!raw) return null
  const ms = Date.parse(raw)
  return Number.isFinite(ms) ? ms : null
}

function logWarn(what: string, e: unknown): void {
  if (e instanceof ZsxqApiError) console.warn(`${what} failed: ${e.code} ${e.message}`)
  else console.warn(`${what} failed: ${describeError(e)}`)
}

/**
 * 停顿（默认 1~2s 随机抖动，降低风控概率）。
 * 返回 false = 任务被回收/易主，调用方立刻收尾（不拖着 lease 不放）。
 */
function pause(signal: AbortSignal, ms = 1000 + Math.random() * 1000): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(false)
    const onAbort = () => {
      clearTimeout(timer)
      resolve(false)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(true)
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** zsxq_groups：一次性任务，用 token 拉取账号下的星球列表（页面勾选同步目标用） */
export const zsxqGroupsHandler: JobHandler = async (payload, ctx) => {
  const { token } = groupsPayloadSchema.parse(payload)
  const client = new ZsxqClient(token)
  // 页面保存 token 后会自动触发一次，先随机停顿再打接口，降低撞上 1059 限流的概率
  await pause(ctx.signal, 500 + Math.random() * 1500)
  const data = await client.listGroups(ctx.signal)
  const items = (data.groups ?? []).map((g) => ({ groupId: String(g.group_id), name: g.name ?? null }))
  return { items, summary: `zsxq groups: ${items.length}` }
}
