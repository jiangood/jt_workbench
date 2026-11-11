/** 邮件服务商内置模板：后台选一个就会自动填好 SMTP 主机 / 端口 / 加密方式。
 *
 *  数据是纯常量（不引任何运行时依赖），config.ts 校验/套模板、mail.ts 兜底默认值都读它。
 *  QQ / 163 / 126 等用的是邮箱「授权码」，不是登录密码。
 */

export type MailSecure = 'ssl' | 'starttls'

export interface MailPreset {
  label: string
  host: string
  port: number
  secure: MailSecure
}

export const MAIL_PRESETS: Record<string, MailPreset> = {
  qq: { label: 'QQ 邮箱', host: 'smtp.qq.com', port: 465, secure: 'ssl' },
  '163': { label: '网易 163', host: 'smtp.163.com', port: 465, secure: 'ssl' },
  '126': { label: '网易 126', host: 'smtp.126.com', port: 465, secure: 'ssl' },
  gmail: { label: 'Gmail', host: 'smtp.gmail.com', port: 465, secure: 'ssl' },
  outlook: { label: 'Outlook', host: 'smtp-mail.outlook.com', port: 587, secure: 'starttls' },
  sina: { label: '新浪邮箱', host: 'smtp.sina.com', port: 465, secure: 'ssl' },
  aliyun: { label: '阿里云邮箱', host: 'smtp.aliyun.com', port: 465, secure: 'ssl' },
}

/** 不走 SMTP 的选项（自定义 / 旧版 Resend），与 MAIL_PRESETS 一起构成合法取值 */
export const MAIL_EXTRA_PROVIDERS = ['custom', 'resend'] as const

/** 后台下拉的展示顺序（QQ 最常用，放第一位） */
const MAIL_PRESET_ORDER = ['qq', '163', '126', 'gmail', 'outlook', 'sina', 'aliyun'] as const

export const MAIL_PROVIDER_OPTIONS = [
  ...MAIL_PRESET_ORDER.map((value) => {
    const p = MAIL_PRESETS[value]
    return {
      value,
      label: `${p.label}（${p.host}:${p.port} ${p.secure === 'ssl' ? 'SSL' : 'STARTTLS'}）`,
    }
  }),
  { value: 'custom', label: '自定义 SMTP（手动填主机 / 端口）' },
  { value: 'resend', label: 'Resend HTTP API（旧，需已验证域名）' },
]

export const MAIL_PROVIDER_VALUES = new Set<string>([
  ...Object.keys(MAIL_PRESETS),
  ...MAIL_EXTRA_PROVIDERS,
])
