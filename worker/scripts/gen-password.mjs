// 生成管理员凭据（盐 + 双轮 SHA-256：SHA256(salt ‖ SHA256(pwd))）
// 用法：node scripts/gen-password.mjs <password> [salt]
// 输出可直接粘进 .dev.vars（本地）或 `wrangler secret put`（线上）
import { createHash, randomBytes } from 'node:crypto'

const [pwd, saltArg] = process.argv.slice(2)
if (!pwd) {
  console.error('usage: node scripts/gen-password.mjs <password> [salt]')
  process.exit(1)
}
const salt = saltArg ?? randomBytes(8).toString('hex')
const inner = createHash('sha256').update(pwd).digest('hex')
const hash = createHash('sha256').update(salt + inner).digest('hex')
console.log(`ADMIN_USER=admin`)
console.log(`ADMIN_PWD_SALT=${salt}`)
console.log(`ADMIN_PWD_HASH=${hash}`)
