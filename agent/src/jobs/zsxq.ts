/**
 * 知识星球采集（方案 2+3 拆分）：
 * - zsxq_backfill: 按星球分片的帖子增量/历史回溯（时间窗口切片），推进 sync_state 游标
 * - zsxq_comments: 老帖评论对账（refresh 队列），按最久未对账轮转
 * - zsxq_probe: 删除探测（check 队列），按最久未探测轮转
 * - zsxq_groups: 拉取账号下星球列表
 * - zsxq_sync: 兼容旧单体任务（保留）
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

const LEASE_BUDGET_MS = 8 * 60_000
const BACKFILL_MAX_PAGES = 15
const INCREMENTAL_MAX_PAGES = 2
const COMMENT_PAGE_SIZE = 30
const COMMENT_MAX_PAGES = 5
const COMMENT_REQUEST_BUDGET = 40
const REFRESH_REQUEST_BUDGET = 40
const CHECK_REQUEST_BUDGET = 30

const tokenSchema = z.string().min(1, '缺少知识星球 token：请到「知识星球」页的「同步配置」填写')

const cursorSchema = z.object({
  cursor: z.string().nullish(),
  done: z.union([z.boolean(), z.number()]).nullish(),
})

const targetSchema = z.object({
  topicId: z.string().min(1),
  groupId: z.string().min(1),
})

const syncPayloadSchema = z
  .object({
    groupId: z.string().min(1).optional(),
    groupIds: z.array(z.string().min(1)).max(50).optional(),
    count: z.number().int().min(1).max(30).default(20),
    endTime: z.string().optional(),
    cursors: z.record(z.string(), cursorSchema).optional(),
    refresh: z.array(targetSchema).max(100).optional(),
    check: z.array(targetSchema).max(100).optional(),
    token: tokenSchema,
  })
  .refine((v) => (v.groupIds?.length ?? 0) > 0 || !!v.groupId, { message: '缺少 groupId' })

const backfillPayloadSchema = z.object({
  groupId: z.string().min(1).optional(),
  groupIds: z.array(z.string().min(1)).max(50).optional(),
  count: z.number().int().min(1).max(30).default(20),
  endTime: z.string().optional(),
  cursors: z.record(z.string(), cursorSchema).optional(),
  token: tokenSchema,
})

const commentsPayloadSchema = z.object({
  groupId: z.string().min(1).optional(),
  groupIds: z.array(z.string().min(1)).max(50).optional(),
  refresh: z.array(targetSchema).max(100).optional(),
  token: tokenSchema,
})

const probePayloadSchema = z.object({
  groupId: z.string().min(1).optional(),
  groupIds: z.array(z.string().min(1)).max(50).optional(),
  check: z.array(targetSchema).max(100).optional(),
  token: tokenSchema,
})

const groupsPayloadSchema = z.object({ token: tokenSchema })

interface CommentBatch {
  items: Record<string, unknown>[]
  requests: number
}

function firstGroupId(groupId?: string, groupIds?: string[]): string {
  const ids = [...new Set(groupIds?.length ? groupIds : groupId ? [groupId] : [])]
  if (!ids.length) throw new Error('缺少 groupId')
  return ids[0]
}

async function fetchGroupName(client: ZsxqClient, gid: string, signal: AbortSignal): Promise<string | null> {
  try {
    const groups = await client.listGroups(signal)
    const hit = (groups.groups ?? []).find((g) => String(g.group_id) === gid)
    return hit?.name ?? null
  } catch (e) {
    logWarn('groups.list', e)
    return null
  }
}

async function fetchOwnerId(client: ZsxqClient, gid: string, signal: AbortSignal): Promise<string | null> {
  try {
    return pickOwnerId(await client.groupDetail(gid, signal))
  } catch (e) {
    logWarn(`groups.detail ${gid}`, e)
    return null
  }
}

export const zsxqBackfillHandler: JobHandler = async (payload, ctx) => {
  const p = backfillPayloadSchema.parse(payload)
  const gid = firstGroupId(p.groupId, p.groupIds)
  const client = new ZsxqClient(p.token)
  const startedAt = Date.now()
  const outOfTime = () => Date.now() - startedAt > LEASE_BUDGET_MS
  if (!(await pause(ctx.signal, 800 + Math.random() * 1200))) return { items: [], summary: 'aborted' }

  const items: Record<string, unknown>[] = []
  const failures: string[] = []
  const remarks: string[] = []
  let topicCount = 0
  let commentCount = 0
  let commentFailures = 0
  let commentBudget = COMMENT_REQUEST_BUDGET
  let aborted = false

  const state = p.cursors?.[gid]
  const alreadyDone = state?.done === true || state?.done === 1
  const startCursor = state?.cursor ?? (state ? null : p.endTime) ?? null
  const groupName = await fetchGroupName(client, gid, ctx.signal)
  const ownerId = await fetchOwnerId(client, gid, ctx.signal)
  if (!ownerId) remarks.push('未能确认星主身份')

  const maxPages = alreadyDone ? INCREMENTAL_MAX_PAGES : BACKFILL_MAX_PAGES
  let scanCursor = startCursor
  let scanCursorMs = alreadyDone || !scanCursor ? null : Date.parse(scanCursor)
  let groupDone = alreadyDone
  let nextCursor = startCursor
  let pageEnd: string | undefined = alreadyDone ? undefined : startCursor ?? undefined
  let stopped = false
  let budgetStop = false
  let scanFromMs: number | null = null
  let coveredToMs: number | null = null
  let monotonic = true
  let lastSeenMs: number | null = null

  for (let page = 0; page < maxPages; page++) {
    if (ctx.signal.aborted) {
      aborted = true
      stopped = true
      break
    }
    if (outOfTime() || commentBudget <= 0) {
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
      data = await client.listTopics(gid, p.count, pageEnd, ctx.signal)
    } catch (e) {
      failures.push(`${gid}: ${describeError(e)}`)
      if (ctx.signal.aborted) aborted = true
      stopped = true
      break
    }

    const topics = (data.topics ?? []) as ZsxqTopic[]
    if (!topics.length) {
      groupDone = true
      break
    }

    let processed = 0
    let pageNewestMs: number | null = null
    let pageOldestMs: number | null = null
    let pageBreak = false
    let pageComplete = true

    for (const t of topics) {
      if (!t || t.topic_id == null) continue
      const wantsComments = typeof t.comments_count !== 'number' || t.comments_count > 0
      if (wantsComments && commentBudget <= 0) {
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

      items.push({
        kind: 'topic',
        topicId,
        groupId: gid,
        groupName,
        title: t.title ?? null,
        talkText: t.talk?.text ?? null,
        images: imageList(t.talk?.images),
        files: fileList(t.talk?.files, isOwner),
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
      if (createdRaw) scanCursor = createdRaw

      if (wantsComments) {
        try {
          const got = await collectComments(client, gid, topicId, ownerId, ctx.signal, commentBudget, outOfTime)
          commentBudget -= got.requests
          commentCount += got.items.length
          items.push(...got.items)
          items.push({ kind: 'comment_state', topicId, groupId: gid })
        } catch (e) {
          if (ctx.signal.aborted) {
            aborted = true
            stopped = true
            pageBreak = true
            pageComplete = false
            break
          }
          logWarn(`topics.comments ${topicId}`, e)
          commentFailures++
          if (commentFailures <= 3) remarks.push(`评论抓取失败 ${topicId}`)
        }
      }
    }

    if (processed > 0 && pageOldestMs !== null) {
      if (scanCursorMs !== null && pageOldestMs >= scanCursorMs) {
        groupDone = true
        pageBreak = true
      }
      scanCursorMs = pageOldestMs
    }
    if (pageComplete && monotonic && pageOldestMs !== null) {
      if (scanFromMs === null && pageNewestMs !== null) scanFromMs = pageNewestMs
      coveredToMs = pageOldestMs
    }
    if (!alreadyDone) nextCursor = scanCursor
    if (pageBreak || stopped) break
    if (scanCursor) pageEnd = scanCursor
  }

  if (budgetStop && !aborted) remarks.push('本轮提前收尾（评论预算/耗时），下一轮继续')
  items.push({
    kind: 'sync_state',
    groupId: gid,
    cursor: nextCursor ?? null,
    done: groupDone ? 1 : 0,
    note: remarks.length ? remarks.join('；') : null,
    scanFrom: scanFromMs,
    scanTo: coveredToMs,
  })

  if (aborted) return { items, summary: 'aborted' }
  if (topicCount === 0 && failures.length) throw new Error(`知识星球回溯失败：${failures.join('；')}`)

  return {
    items,
    summary:
      `zsxq_backfill ${gid}：${topicCount} topics，${commentCount} comments` +
      (!ownerId ? '，未能确认星主身份' : '') +
      (commentFailures ? `，${commentFailures} 帖评论失败` : '') +
      (groupDone ? '，已完成历史回溯' : '，继续切片'),
  }
}

export const zsxqCommentsHandler: JobHandler = async (payload, ctx) => {
  const p = commentsPayloadSchema.parse(payload)
  const gid = firstGroupId(p.groupId, p.groupIds)
  const refresh = (p.refresh ?? []).filter((t) => t.groupId === gid)
  if (!refresh.length) return { items: [], summary: `zsxq_comments ${gid}：无待对账评论` }

  const client = new ZsxqClient(p.token)
  const startedAt = Date.now()
  const outOfTime = () => Date.now() - startedAt > LEASE_BUDGET_MS
  if (!(await pause(ctx.signal, 500 + Math.random() * 800))) return { items: [], summary: 'aborted' }

  const ownerId = await fetchOwnerId(client, gid, ctx.signal)
  const items: Record<string, unknown>[] = []
  let budget = REFRESH_REQUEST_BUDGET
  let refreshed = 0
  let commentCount = 0
  let requests = 0
  let failures = 0

  for (const target of refresh) {
    if (ctx.signal.aborted) return { items, summary: 'aborted' }
    if (budget <= 0 || outOfTime()) break
    if (!(await pause(ctx.signal, 500 + Math.random() * 600))) return { items, summary: 'aborted' }
    try {
      const got = await collectComments(client, gid, target.topicId, ownerId, ctx.signal, budget, outOfTime)
      if (!got.requests) break
      budget -= got.requests
      requests += got.requests
      refreshed++
      commentCount += got.items.length
      items.push(...got.items)
      items.push({ kind: 'comment_state', topicId: target.topicId, groupId: gid })
    } catch (e) {
      if (ctx.signal.aborted) return { items, summary: 'aborted' }
      logWarn(`refresh.comments ${target.topicId}`, e)
      failures++
    }
  }

  return {
    items,
    summary: `zsxq_comments ${gid}：对账 ${refreshed} 帖，${commentCount} comments，${requests} 次请求${failures ? `，失败 ${failures}` : ''}`,
  }
}

export const zsxqProbeHandler: JobHandler = async (payload, ctx) => {
  const p = probePayloadSchema.parse(payload)
  const gid = firstGroupId(p.groupId, p.groupIds)
  const check = (p.check ?? []).filter((t) => t.groupId === gid)
  if (!check.length) return { items: [], summary: `zsxq_probe ${gid}：无待探测帖子` }

  const client = new ZsxqClient(p.token)
  const startedAt = Date.now()
  const outOfTime = () => Date.now() - startedAt > LEASE_BUDGET_MS
  const items: Record<string, unknown>[] = []
  if (!(await pause(ctx.signal, 400 + Math.random() * 600))) return { items, summary: 'aborted' }
  let budget = CHECK_REQUEST_BUDGET
  let checked = 0
  let gone = 0
  let aliveCount = 0
  const goneItems: Array<{ topicId: string; code: number | null; message: string }> = []

  for (const target of check) {
    if (ctx.signal.aborted) return { items, summary: 'aborted' }
    if (budget <= 0 || outOfTime()) break
    budget--
    try {
      const probe = await probeTopic(client, target.topicId, ctx.signal)
      checked++
      if (probe.alive) {
        aliveCount++
        items.push({
          kind: 'topic_check',
          topicId: target.topicId,
          groupId: gid,
          status: 'alive',
          commentsCount: infoCount(probe.info, 'comments'),
          likesCount: infoCount(probe.info, 'likes'),
        })
      } else {
        goneItems.push({
          topicId: target.topicId,
          code: probe.error instanceof ZsxqApiError ? probe.error.code : null,
          message: describeError(probe.error).slice(0, 200),
        })
      }
    } catch (e) {
      if (ctx.signal.aborted) return { items, summary: 'aborted' }
      logWarn(`topics.probe ${target.topicId}`, e)
    }
    if (!(await pause(ctx.signal, 600 + Math.random() * 600))) return { items, summary: 'aborted' }
  }

  for (const g of goneItems) {
    const trusted = aliveCount > 0
    if (trusted) gone++
    items.push({
      kind: 'topic_check',
      topicId: g.topicId,
      groupId: gid,
      status: trusted ? 'gone' : 'unknown',
      code: g.code,
      message: g.message,
    })
  }

  return {
    items,
    summary: `zsxq_probe ${gid}：探测 ${checked} 帖${gone ? `，确认删除 ${gone}` : ''}${!aliveCount && goneItems.length ? '，本轮无存活样本，未判删' : ''}`,
  }
}

// 兼容旧单体任务：按星球串行执行 backfill（不再单独处理 refresh/check，拆分任务接管）
export const zsxqHandler: JobHandler = async (payload, ctx) => {
  const { groupId, groupIds: rawIds, count, endTime, cursors, token } = syncPayloadSchema.parse(payload)
  const groupIds = [...new Set(rawIds?.length ? rawIds : [groupId!])]
  const items: unknown[] = []
  const summaries: string[] = []
  for (const gid of groupIds) {
    if (ctx.signal.aborted) return { items, summary: 'aborted' }
    const r = await zsxqBackfillHandler(
      { groupId: gid, groupIds: [gid], count, endTime, cursors: cursors ? { [gid]: cursors[gid] } : undefined, token },
      ctx,
    )
    items.push(...r.items)
    summaries.push(r.summary)
  }
  return { items, summary: summaries.join('；') || 'zsxq done' }
}

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
        files: fileList(c.files, isOwner),
        createTime: parseTime(c.create_time),
      })
    }
    if (!fresh) break
    if (list.length < COMMENT_PAGE_SIZE) break
    if (lastRaw) endTime = lastRaw
  }

  return { items, requests }
}

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

function isGoneError(e: unknown): boolean {
  if (!(e instanceof ZsxqApiError)) return false
  if (e.retryable) return false
  if (e.code === 1001 || e.code === 401 || e.code === 403 || e.httpStatus === 401 || e.httpStatus === 403) {
    return false
  }
  if (e.code === 404 || e.httpStatus === 404) return true
  const msg = `${e.message ?? ''}`
  return /不存在|已删除|被删除|找不到|not\s*found|not\s*exist|deleted/i.test(msg)
}

function infoCount(info: { topic?: ZsxqTopicInfo } | null | undefined, key: 'comments' | 'likes'): number | null {
  const t = info?.topic
  const n = t?.counts?.[key] ?? (key === 'comments' ? t?.comments_count : t?.likes_count)
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : null
}

function pickOwnerId(detail: ZsxqGroupDetail | null | undefined): string | null {
  const g = detail?.group ?? detail
  const uid = g?.owner?.user_id ?? g?.owner_id
  return uid === undefined || uid === null ? null : String(uid)
}

function userId(u: ZsxqUser | undefined | null): string | null {
  return u?.user_id === undefined || u?.user_id === null ? null : String(u.user_id)
}

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

export const zsxqGroupsHandler: JobHandler = async (payload, ctx) => {
  const { token } = groupsPayloadSchema.parse(payload)
  const client = new ZsxqClient(token)
  await pause(ctx.signal, 500 + Math.random() * 1500)
  const data = await client.listGroups(ctx.signal)
  const items = (data.groups ?? []).map((g) => ({ groupId: String(g.group_id), name: g.name ?? null }))
  return { items, summary: `zsxq groups: ${items.length}` }
}
