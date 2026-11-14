// @script
// {
//   "id": "zsxq_sync",
//   "name": "知识星球同步",
//   "version": "1.0.0",
//   "description": "同步已启用星球的帖子、评论、附件与检查状态",
//   "schedule": "0 0 */3 * * *",
//   "enabled": true,
//   "timeout": 3600,
//   "reliability": "reliable"
// }

import { zsxqHandler } from '../../dist/remote-libs/zsxq-jobs.mjs'

export async function run(ctx, payload) {
  return zsxqHandler(payload, {
    signal: ctx.signal,
    heartbeat: typeof ctx.heartbeat === 'function' ? ctx.heartbeat : async () => {},
  })
}
