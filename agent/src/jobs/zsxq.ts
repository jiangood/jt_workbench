/** zsxq_sync：知识星球话题同步（极简 TS client，token 走 agent env，不进 D1；签名可选——读接口仅 token） */

import { z } from 'zod'
import { ZsxqClient, ZsxqApiError, type ZsxqTopic } from '../zsxq-client.js'
import type { JobHandler } from '../types.js'

const payloadSchema = z.object({
  groupId: z.string().min(1),
  count: z.number().int().min(1).max(30).default(20),
  endTime: z.string().optional(), // 分页游标（YYYY-MM-DDTHH:mm:ss.SSS+0800）
})

export const zsxqHandler: JobHandler = async (payload, ctx) => {
  const { groupId, count, endTime } = payloadSchema.parse(payload)
  const token = process.env.ZSXQ_TOKEN
  if (!token) throw new Error('ZSXQ_TOKEN not configured (agent env)')

  const client = new ZsxqClient(token)

  // 沿用旧系统的克制节奏：页间随机停顿，避免触发风控
  await sleep(1000 + Math.random() * 2000)

  const data = await client.listTopics(groupId, count, endTime)
  const items = (data.topics ?? []).map((t: ZsxqTopic) => ({
    topicId: String(t.topic_id),
    groupId,
    title: t.title ?? null,
    talkText: t.talk?.text ?? null,
    images: (t.talk?.images ?? []).map((im) => {
      const best = im.original ?? im.large ?? im.middle
      return best ? { u: best.url, w: im.original?.width ?? null, h: im.original?.height ?? null } : null
    }).filter(Boolean),
    files: (t.talk?.files ?? []).map((f) => ({ name: f.name, size: f.size })),
    createTime: t.create_time ? Date.parse(t.create_time) || null : null,
  }))

  if (ctx.signal.aborted) return { items: [], summary: 'aborted' }

  // 顺带刷新星球名称（失败不影响同步结果）
  let groupName: string | null = null
  try {
    const groups = await client.listGroups()
    groupName = (groups.groups ?? []).find((g) => String(g.group_id) === groupId)?.name ?? null
  } catch (e) {
    if (e instanceof ZsxqApiError) console.warn(`groups.list failed: ${e.code} ${e.message}`)
  }

  return {
    items,
    summary: `zsxq ${groupId}: ${items.length} topics${groupName ? ` (${groupName})` : ''}`,
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
