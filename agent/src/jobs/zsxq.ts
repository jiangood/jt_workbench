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
/** 整轮评论请求上限：超出就提前收尾，下一轮继续（评论比帖子慢，单独限流） */
const COMMENT_REQUEST_BUDGET = 40

const tokenSchema = z.string().min(1, '缺少知识星球 token：请到「知识星球」页的「同步配置」填写')

const cursorSchema = z.object({
  cursor: z.string().nullish(),
  done: z.union([z.boolean(), z.number()]).nullish(),
})

const syncPayloadSchema = z
  .object({
    groupId: z.string().min(1).optional(), // 旧版 payload（单星球），滚动升级期间兼容
    groupIds: z.array(z.string().min(1)).max(50).optional(),
    count: z.number().int().min(1).max(30).default(20),
    endTime: z.string().optional(), // 旧版游标（YYYY-MM-DDTHH:mm:ss.SSS+0800）
    /** Worker 从 zsxq_sync_state 注入：{ [groupId]: { cursor, done } }；缺省 = 从头回溯 */
    cursors: z.record(z.string(), cursorSchema).optional(),
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
  const { groupId, groupIds: rawIds, count, endTime, cursors, token } = syncPayloadSchema.parse(payload)
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
  let commentBudget = COMMENT_REQUEST_BUDGET
  let aborted = false

  const emitState = (
    gid: string,
    cursor: string | null,
    done: boolean,
    remarks: string[],
  ) => {
    items.push({
      kind: 'sync_state',
      groupId: gid,
      cursor: cursor ?? null,
      done: done ? 1 : 0,
      note: remarks.length ? remarks.join('；') : null,
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
    if (!ownerId) {
      noOwnerGroups++
      remarks.push('未能确认星主身份')
    }

    // ② 帖子分页（done 星球只扫首页，回溯模式一路往老翻）
    const groupName = groupNames.get(gid) ?? null
    const maxPages = alreadyDone ? INCREMENTAL_MAX_PAGES : BACKFILL_MAX_PAGES
    // 评论预算按「剩余星球数」均分，避免第一个星球把 40 次用光、后面的星球永远轮不到
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

      const topics = (data.topics ?? []) as ZsxqTopic[]
      if (!topics.length) {
        // 空页 = 已回溯到历史尽头
        groupDone = true
        break
      }

      let processed = 0
      let pageOldestMs: number | null = null
      let pageBreak = false

      for (const t of topics) {
        if (!t || t.topic_id == null) continue
        // comments_count 明确为 0 就不打接口（省预算）；字段缺失时保守地拉一次
        const wantsComments = typeof t.comments_count !== 'number' || t.comments_count > 0
        // 评论预算用尽：连这条帖子都不收（否则游标越过它、评论永远补不上）→ 留给下一轮
        if (wantsComments && groupCommentBudget <= 0) {
          stopped = true
          budgetStop = true
          pageBreak = true
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
        if (Number.isFinite(createdMs)) pageOldestMs = createdMs
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
        } catch (e) {
          // 评论失败只记账，不中断整轮（帖子已经入库，评论下一轮随帖子重抓再补）
          if (ctx.signal.aborted) {
            aborted = true
            stopped = true
            pageBreak = true
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
      if (!alreadyDone) nextCursor = scanCursor
      if (pageBreak || stopped) break
      if (scanCursor) pageEnd = scanCursor
    }

    if (budgetStop && !aborted) remarks.push('本轮提前收尾（评论预算/耗时），下一轮继续')
    emitState(gid, nextCursor ?? null, groupDone, remarks)

    if (index < groupIds.length - 1 && !(await pause(ctx.signal))) {
      aborted = true
      break
    }
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
