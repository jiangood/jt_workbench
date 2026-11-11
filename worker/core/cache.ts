/** cache 表 TTL 封装（v2.1：缓存/状态收进 D1） */

export async function cacheGet(db: D1Database, key: string): Promise<string | null> {
  const row = await db
    .prepare('SELECT v FROM cache WHERE k = ? AND expires_at > ?')
    .bind(key, Date.now())
    .first<{ v: string }>()
  return row?.v ?? null
}

export async function cacheSet(db: D1Database, key: string, value: string, ttlMs: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO cache (k, v, expires_at) VALUES (?, ?, ?)
       ON CONFLICT (k) DO UPDATE SET v = excluded.v, expires_at = excluded.expires_at`,
    )
    .bind(key, value, Date.now() + ttlMs)
    .run()
}
