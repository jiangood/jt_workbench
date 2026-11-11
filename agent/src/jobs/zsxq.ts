/** zsxq_sync：知识星球话题同步（token 由 Worker 从 D1 注入 payload，agent 不读环境变量） */

import { z } from 'zod'
import { describeError } from '../describe-error.js'
import { ZsxqClient, ZsxqApiError, type ZsxqTopic } from '../zsxq-client.js'
import type { JobHandler } from '../types.js'

const syncPayloadSchema = z
  .object({
    groupId: z.string().min(1).optional(), // 旧版 payload（单星球），滚动升级期间兼容
    groupIds: z.array(z.string().min(1)).max(50).optional(),
    count: z.number().int().min(1).max(30).default(20),
    endTime: z.string().optional(), // 分页游标（YYYY-MM-DDTHH:mm:ss.SSS+0800）
    token: z.string().min(1, '缺少知识星球 token：请到后台「参数与密钥」填写'),
  })
  .refine((v) => (v.groupIds?.length ?? 0) > 0 || !!v.groupId, { message: '缺少 groupId' })

const groupsPayloadSchema = z.object({
  token: z.string().min(1, '缺少知识星球 token：请到后台「参数与密钥」填写'),
})

export const zsxqHandler: JobHandler = async (payload, ctx) => {
  const { groupId, groupIds: rawIds, count, endTime, token } = syncPayloadSchema.parse(payload)
  const groupIds = [...new Set(rawIds?.length ? rawIds : [groupId!])]

  const client = new ZsxqClient(token)

  // 沿用旧系统的克制节奏：两次请求之间随机停顿，避免触发风控
  await sleep(1000 + Math.random() * 2000)

  // 顺带刷新星球名称（失败不影响同步结果；名称随 items 回传，Worker 落库给页面勾选用）
  const groupNames = new Map<string, string>()
  try {
    const groups = await client.listGroups(ctx.signal)
    for (const g of groups.groups ?? []) groupNames.set(String(g.group_id), g.name)
  } catch (e) {
    if (e instanceof ZsxqApiError) console.warn(`groups.list failed: ${e.code} ${e.message}`)
    else console.warn(`groups.list failed: ${describeError(e)}`)
  }

  const items: Record<string, unknown>[] = []
  const failures: string[] = []

  // 多星球串行同步：单个星球失败只记一笔，不影响其余星球入库
  for (const [index, gid] of groupIds.entries()) {
    if (ctx.signal.aborted) return { items, summary: 'aborted' }
    try {
      const data = await client.listTopics(gid, count, endTime, ctx.signal)
      const groupName = groupNames.get(gid) ?? null
      for (const t of data.topics ?? []) {
        const topic = t as ZsxqTopic
        items.push({
          topicId: String(topic.topic_id),
          groupId: gid,
          groupName,
          title: topic.title ?? null,
          talkText: topic.talk?.text ?? null,
          images: (topic.talk?.images ?? [])
            .map((im) => {
              const best = im.original ?? im.large ?? im.middle
              return best ? { u: best.url, w: im.original?.width ?? null, h: im.original?.height ?? null } : null
            })
            .filter(Boolean),
          files: (topic.talk?.files ?? []).map((f) => ({ name: f.name, size: f.size })),
          createTime: topic.create_time ? Date.parse(topic.create_time) || null : null,
        })
      }
    } catch (e) {
      failures.push(`${gid}: ${describeError(e)}`)
    }
    if (index < groupIds.length - 1) await sleep(1000 + Math.random() * 2000)
  }

  if (failures.length === groupIds.length) {
    throw new Error(`知识星球同步失败：${failures.join('；')}`)
  }

  return {
    items,
    summary:
      `zsxq ${groupIds.length} 个星球：${items.length} topics` +
      (failures.length ? `，失败 ${failures.length} 个（${failures.join('；')}）` : ''),
  }
}

/** zsxq_groups：一次性任务，用 token 拉取账号下的星球列表（页面勾选同步目标用） */
export const zsxqGroupsHandler: JobHandler = async (payload, ctx) => {
  const { token } = groupsPayloadSchema.parse(payload)
  const client = new ZsxqClient(token)
  const data = await client.listGroups(ctx.signal)
  const items = (data.groups ?? []).map((g) => ({ groupId: String(g.group_id), name: g.name ?? null }))
  return { items, summary: `zsxq groups: ${items.length}` }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
