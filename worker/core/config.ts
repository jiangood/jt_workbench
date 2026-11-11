/**
 * 参数中心（决策 #23）：Worker 的可运维参数统一存 D1 app_config，不使用 wrangler secret
 *
 * - 读取：D1 为准；缺失且可生成（JWT 密钥）时随机生成并落库，其余保持空
 * - D1 里存在空值 = 显式清空（不会回退到任何默认值）
 * - 0009 未迁移（表不存在）：本次用随机临时值，不落库，其余功能照常
 * - 后台只展示明文给已登录管理员，前端默认掩码
 */

import type { Bindings } from './envelope'
import { MAIL_PRESETS, MAIL_PROVIDER_OPTIONS, MAIL_PROVIDER_VALUES } from './mail-presets'

export type ConfigKind = 'secret' | 'text'
export type ConfigSource = 'd1' | 'empty'

export interface ConfigOption {
  value: string
  label: string
}

export interface ConfigField {
  key: string
  label: string
  kind: ConfigKind
  hint: string
  /** 不允许空值（目前只有 JWT 密钥） */
  required?: boolean
  minLen?: number
  maxLen?: number
  /** 有值时后台渲染成下拉框（如邮件服务商模板） */
  options?: ConfigOption[]
  /** 后台分组：同 group 的字段合并渲染成一张卡片（目前只有 mail） */
  group?: string
  /** 值缺失时自动随机生成（首次读取即落库） */
  generate?: () => string
}

export const CONFIG_FIELDS: ConfigField[] = [
  {
    key: 'jwt_secret',
    label: '登录 JWT 密钥',
    kind: 'secret',
    required: true,
    minLen: 32,
    maxLen: 256,
    generate: () => randomHex(32),
    hint: '签发登录 Cookie 的 HMAC 密钥；重新生成后所有已登录会话（含当前）立即失效',
  },
  {
    key: 'mail_provider',
    label: '服务商模板',
    kind: 'text',
    maxLen: 32,
    group: 'mail',
    options: MAIL_PROVIDER_OPTIONS,
    hint: '选中内置模板会自动填好 SMTP 主机 / 端口 / 加密方式，只需再填邮箱账号与授权码',
  },
  {
    key: 'smtp_user',
    label: '邮箱账号',
    kind: 'text',
    maxLen: 128,
    group: 'mail',
    hint: 'SMTP 登录账号，通常就是完整邮箱地址（未单独填发件人时也作为发件人）',
  },
  {
    key: 'smtp_pass',
    label: '授权码 / 密码',
    kind: 'secret',
    maxLen: 256,
    group: 'mail',
    hint: 'QQ / 163 / 126 填邮箱「授权码」（邮箱设置里开启 SMTP 后获取），不是登录密码；Gmail 填应用专用密码',
  },
  {
    key: 'reminder_from',
    label: '发件人',
    kind: 'text',
    maxLen: 128,
    group: 'mail',
    hint: '留空则用邮箱账号；多数服务商要求与 SMTP 账号一致',
  },
  {
    key: 'reminder_to',
    label: '收件邮箱',
    kind: 'text',
    maxLen: 128,
    group: 'mail',
    hint: '所有提醒统一发到这里（个人收件箱）；留空则不发信，提醒保持待发',
  },
  {
    key: 'smtp_host',
    label: 'SMTP 主机',
    kind: 'text',
    maxLen: 128,
    group: 'mail',
    hint: '选内置模板会自动填；自定义时手动填，如 smtp.example.com',
  },
  {
    key: 'smtp_port',
    label: 'SMTP 端口',
    kind: 'text',
    maxLen: 5,
    group: 'mail',
    hint: '465 = SSL，587 = STARTTLS；Cloudflare 出站不允许 25 端口',
  },
  {
    key: 'smtp_secure',
    label: 'SMTP 加密方式',
    kind: 'text',
    maxLen: 16,
    group: 'mail',
    options: [
      { value: 'ssl', label: 'SSL（465）' },
      { value: 'starttls', label: 'STARTTLS（587）' },
    ],
    hint: '465 用 SSL，587 用 STARTTLS',
  },
  {
    key: 'resend_api_key',
    label: 'Resend 发信 Key（旧通道）',
    kind: 'secret',
    maxLen: 256,
    group: 'mail',
    hint: '仅当服务商模板选「Resend HTTP API」时使用；配置 SMTP 后不再需要，留空即可',
  },
  {
    key: 'agent_latest_version',
    label: 'agent 最新版本',
    kind: 'text',
    maxLen: 64,
    hint: '发布流水线在 agent 有变更时自动写入（发布 tag 去掉前缀 v，如 4.15）；节点版本落后时后台显黄条，节点空闲即触发 Watchtower 即时升级；留空不校验',
  },
  {
    key: 'zsxq_token',
    label: '知识星球 token',
    kind: 'secret',
    maxLen: 1024,
    hint: 'wx.zsxq.com 登录后从请求头取；下发 zsxq_sync 任务时自动注入 payload，留空则任务报「未配置 token」',
  },
]

const FIELD_MAP = new Map(CONFIG_FIELDS.map((f) => [f.key, f]))

/** 值为邮箱地址的参数（发件人 / 全局收件箱） */
const EMAIL_KEYS = new Set(['reminder_from', 'reminder_to'])

export function findField(key: string): ConfigField | undefined {
  return FIELD_MAP.get(key)
}

/** 32 字节随机 → 64 位 hex（与 nodekey.randomNodeKey 同风格） */
export function randomHex(bytes = 32): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export interface ConfigRow {
  k: string
  v: string
  updated_at: number
}

export interface ConfigItem {
  key: string
  label: string
  kind: ConfigKind
  hint: string
  value: string
  source: ConfigSource
  updatedAt: number
  canGenerate: boolean
  required: boolean
  minLen?: number
  maxLen?: number
  options?: ConfigOption[]
  group?: string
}

/** 0009 未迁移时返回 null（调用方退回临时值） */
async function readRows(env: Bindings): Promise<Map<string, ConfigRow> | null> {
  try {
    const res = await env.DB.prepare('SELECT k, v, updated_at FROM app_config').all<ConfigRow>()
    return new Map((res.results ?? []).map((r) => [r.k, r]))
  } catch {
    return null
  }
}

/** ON CONFLICT upsert 语句（单写与批量套模板共用） */
function upsertStatement(env: Bindings, key: string, value: string): D1PreparedStatement {
  return env.DB
    .prepare(
      `INSERT INTO app_config (k, v, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at`,
    )
    .bind(key, value, Date.now())
}

async function writeRow(env: Bindings, key: string, value: string): Promise<void> {
  await upsertStatement(env, key, value).run()
}

/** 首次落库：并发只留一个值（先写者胜，后到者读回），避免两头签发不同 JWT 密钥 */
async function seedRow(env: Bindings, key: string, value: string): Promise<string> {
  await env.DB
    .prepare(`INSERT INTO app_config (k, v, updated_at) VALUES (?, ?, ?) ON CONFLICT (k) DO NOTHING`)
    .bind(key, value, Date.now())
    .run()
  const row = await env.DB.prepare('SELECT v FROM app_config WHERE k = ?').bind(key).first<{ v: string }>()
  return row?.v ?? value
}

/** 取生效值；缺失且可生成时随机生成并落库。未注册的 key 直接抛错，防手滑写脏数据 */
export async function getConfig(env: Bindings, key: string): Promise<string> {
  const field = FIELD_MAP.get(key)
  if (!field) throw new Error(`unknown config key: ${key}`)

  const rows = await readRows(env)
  if (rows?.has(key)) return rows.get(key)!.v // 空值也是显式值

  const seed = field.generate?.() || ''
  if (!seed) return ''
  if (!rows) return seed // 迁移未跑：本次可用但不落库
  try {
    return await seedRow(env, key, seed)
  } catch (err) {
    console.error('seed config failed:', key, String(err))
    return seed
  }
}

/** 一次查询读多个参数（邮件发送要读 9 个，避免逐条拉整表）；不触发 generate 落库 */
export async function getConfigs<K extends string>(env: Bindings, keys: readonly K[]): Promise<Record<K, string>> {
  const rows = await readRows(env)
  const out = {} as Record<K, string>
  for (const key of keys) {
    if (!FIELD_MAP.has(key)) throw new Error(`unknown config key: ${key}`)
    out[key] = rows?.get(key)?.v ?? ''
  }
  return out
}

export function validateConfig(field: ConfigField, raw: string): string | null {
  const value = raw.trim()
  if (field.required && !value) return `${field.label}不能为空`
  if (field.minLen && value && value.length < field.minLen) return `${field.label}至少 ${field.minLen} 位`
  if (field.maxLen && value.length > field.maxLen) return `${field.label}最多 ${field.maxLen} 位`
  if (field.kind === 'secret' && /\s/.test(value)) return `${field.label}不能包含空白字符`
  if (EMAIL_KEYS.has(field.key) && value && !/^[^\s@]+@[^\s@]+$/.test(value)) return `${field.label}需为邮箱地址`
  if (field.key === 'mail_provider' && value && !MAIL_PROVIDER_VALUES.has(value)) return '未知的邮件服务商'
  if (field.key === 'smtp_host' && /\s/.test(value)) return `${field.label}不能包含空白字符`
  if (field.key === 'smtp_port' && value && !(/^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 65535)) {
    return 'SMTP 端口需为 1~65535'
  }
  if (field.key === 'smtp_secure' && value && !['ssl', 'starttls'].includes(value)) return '加密方式只能是 ssl 或 starttls'
  return null
}

function describeFromRow(field: ConfigField, row: ConfigRow | undefined): ConfigItem {
  return {
    key: field.key,
    label: field.label,
    kind: field.kind,
    hint: field.hint,
    value: row?.v ?? '',
    source: row ? 'd1' : 'empty',
    updatedAt: row?.updated_at ?? 0,
    canGenerate: !!field.generate,
    required: !!field.required,
    minLen: field.minLen,
    maxLen: field.maxLen,
    options: field.options,
    group: field.group,
  }
}

export async function describeConfig(env: Bindings, key: string): Promise<ConfigItem> {
  const field = FIELD_MAP.get(key)!
  const rows = await readRows(env)
  return describeFromRow(field, rows?.get(key))
}

export async function listConfig(env: Bindings): Promise<ConfigItem[]> {
  const rows = await readRows(env)
  return CONFIG_FIELDS.map((f) => describeFromRow(f, rows?.get(f.key)))
}

export async function setConfig(env: Bindings, key: string, raw: string): Promise<ConfigItem> {
  const field = FIELD_MAP.get(key)
  if (!field) throw new Error(`unknown config key: ${key}`)
  const value = raw.trim()

  // 选中内置服务商模板：一次 batch 把主机 / 端口 / 加密方式一起写好（自定义 / Resend 只写自身）
  const preset = field.key === 'mail_provider' ? MAIL_PRESETS[value] : undefined
  if (preset) {
    await env.DB.batch([
      upsertStatement(env, field.key, value),
      upsertStatement(env, 'smtp_host', preset.host),
      upsertStatement(env, 'smtp_port', String(preset.port)),
      upsertStatement(env, 'smtp_secure', preset.secure),
    ])
  } else {
    await writeRow(env, field.key, value)
  }
  return describeConfig(env, field.key)
}


/** 随机重置（仅 generate 型）：JWT 密钥重置 = 全部会话下线 */
export async function resetConfig(env: Bindings, key: string): Promise<ConfigItem> {
  const field = FIELD_MAP.get(key)
  if (!field?.generate) throw new Error(`config not rotatable: ${key}`)
  return setConfig(env, field.key, field.generate())
}
