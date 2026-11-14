/** Shared D1-backed payload builders for legacy and remote Zsxq execution. */

export function payloadGroupIds(payload: Record<string, unknown>): string[] {
  const raw = Array.isArray(payload.groupIds) ? payload.groupIds : [payload.groupId]
  return raw.filter((id): id is string => typeof id === 'string' && id !== '')
}

export async function zsxqCursors(
  db: D1Database,
  ids: string[],
): Promise<Record<string, { cursor: string | null; done: boolean }>> {
  if (!ids.length) return {}
  try {
    const placeholders = ids.map(() => '?').join(',')
    const result = await db.prepare(
      'SELECT group_id AS groupId, cursor, done FROM zsxq_sync_state WHERE group_id IN (' + placeholders + ')',
    ).bind(...ids).all<{ groupId: string; cursor: string | null; done: number }>()
    const output: Record<string, { cursor: string | null; done: boolean }> = {}
    for (const row of result.results ?? []) {
      output[row.groupId] = { cursor: row.cursor ?? null, done: row.done === 1 }
    }
    return output
  } catch {
    return {}
  }
}

const RECONCILE_LIMIT = 30

export async function zsxqReconcileTargets(
  db: D1Database,
  ids: string[],
  column: 'comments_checked_at' | 'checked_at',
  now = Date.now(),
): Promise<Array<{ topicId: string; groupId: string }>> {
  if (!ids.length) return []
  try {
    const placeholders = ids.map(() => '?').join(',')
    const result = await db.prepare(
      'SELECT id AS topicId, group_id AS groupId FROM zsxq_topic ' +
      'WHERE group_id IN (' + placeholders + ') AND deleted = 0 ' +
      (column === 'comments_checked_at' ? 'AND (comments_retry_at IS NULL OR comments_retry_at <= ?) ' : '') +
      'ORDER BY COALESCE(' + column + ', 0) ASC, create_time DESC LIMIT ?',
    ).bind(...ids, ...(column === 'comments_checked_at' ? [now] : []), RECONCILE_LIMIT)
      .all<{ topicId: string; groupId: string }>()
    return (result.results ?? []).filter((row) => row.topicId && row.groupId)
  } catch {
    return []
  }
}
