/**
 * 提醒邮件发送（决策 #14：收发信这类 IO 交给 Worker 内置任务，不进 agent）
 *
 * 两条通道，由 app_config.mail_provider 决定：
 * - 内置模板 / 自定义 SMTP：cloudflare:sockets 直连（465 隐式 TLS / 587 STARTTLS），
 *   Cloudflare 出站禁止 25 端口，所以只支持这两个
 * - resend：旧通道，HTTP API（保留兼容，已有 Key 的部署不受影响）
 *
 * 每封邮件一次连接，20s 总超时；失败直接抛 MailError，由 tick 写进 reminder.last_error 等下轮重试。
 */

import { connect } from 'cloudflare:sockets'
import type { Bindings } from './envelope'
import { getConfigs } from './config'
import { MAIL_PRESETS } from './mail-presets'

const SMTP_TIMEOUT_MS = 20_000

export interface MailContent {
  subject: string
  html: string
}

export class MailError extends Error {}

type RawSocket = ReturnType<typeof connect>

export async function sendMail(env: Bindings, content: MailContent): Promise<void> {
  // 邮件参数一次读齐（避免 9 次整表查询）
  const cfg = await getConfigs(env, [
    'mail_provider',
    'smtp_host',
    'smtp_port',
    'smtp_secure',
    'smtp_user',
    'smtp_pass',
    'reminder_from',
    'reminder_to',
    'resend_api_key',
  ])

  const to = cfg.reminder_to.trim()
  if (!to) {
    throw new MailError('收件邮箱未配置（后台 → 参数与密钥 → 邮件提醒）；保留待发，配置后自动补发')
  }

  // 未显式选服务商时：有 Resend Key 走旧通道，否则按 QQ 邮箱模板（只影响默认主机的提示）
  const provider = cfg.mail_provider.trim() || (cfg.resend_api_key.trim() ? 'resend' : 'qq')

  if (provider === 'resend') {
    const apiKey = cfg.resend_api_key.trim()
    if (!apiKey) throw new MailError('Resend API Key 未配置（后台 → 参数与密钥）')
    await sendViaResend(apiKey, cfg.reminder_from.trim() || 'onboarding@resend.dev', to, content)
    return
  }

  const preset = MAIL_PRESETS[provider]
  const host = (cfg.smtp_host || preset?.host || '').trim()
  const port = Number((cfg.smtp_port || (preset ? String(preset.port) : '')).trim())
  const secure = (cfg.smtp_secure || preset?.secure || 'ssl').trim() === 'starttls' ? 'starttls' : 'ssl'
  const user = (cfg.smtp_user || cfg.reminder_from).trim()
  const pass = cfg.smtp_pass
  const from = cfg.reminder_from.trim() || user

  if (!host) throw new MailError('SMTP 主机未配置（后台 → 参数与密钥 → 邮件提醒 → 高级）')
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new MailError('SMTP 端口未配置或不合法（后台 → 参数与密钥 → 邮件提醒 → 高级）')
  if (!user || !pass) throw new MailError('邮箱账号 / 授权码未配置（后台 → 参数与密钥 → 邮件提醒）')
  if (!from) throw new MailError('发件人未配置（后台 → 参数与密钥 → 邮件提醒）')

  await sendViaSmtp({ host, port, secure, user, pass, from, to }, content)
}

// ---------- Resend（旧通道） ----------

async function sendViaResend(apiKey: string, from: string, to: string, content: MailContent): Promise<void> {
  let res: Response
  try {
    res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject: content.subject, html: content.html }),
    })
  } catch (err) {
    throw new MailError(`Resend 请求失败：${errText(err)}`)
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new MailError(`Resend HTTP ${res.status} ${text.slice(0, 200)}`)
  }
}

// ---------- SMTP（cloudflare:sockets） ----------

interface SmtpConfig {
  host: string
  port: number
  secure: 'ssl' | 'starttls'
  user: string
  pass: string
  from: string
  to: string
}

async function sendViaSmtp(cfg: SmtpConfig, content: MailContent): Promise<void> {
  let socket: RawSocket
  try {
    socket = connect(
      { hostname: cfg.host, port: cfg.port },
      { secureTransport: cfg.secure === 'ssl' ? 'on' : 'starttls', allowHalfOpen: false },
    )
  } catch (err) {
    throw new MailError(`SMTP 连接失败（${cfg.host}:${cfg.port}）：${errText(err)}`)
  }

  const session = new SmtpSession(socket)
  try {
    await session.expect(220)
    await session.command('EHLO jt-workbench', 250)

    if (cfg.secure === 'starttls') {
      await session.command('STARTTLS', 220)
      session.upgrade()
      await session.command('EHLO jt-workbench', 250)
    }

    // AUTH LOGIN：QQ / 163 / Gmail / Outlook 都支持；授权码里可能有符号，走 base64 最稳
    await session.command('AUTH LOGIN', 334)
    await session.command(encodeBase64(cfg.user), 334, 'AUTH USER')
    await session.command(encodeBase64(cfg.pass), 235, 'AUTH PASS')

    await session.command(`MAIL FROM:<${mailbox(cfg.from)}>`, 250)
    await session.command(`RCPT TO:<${mailbox(cfg.to)}>`, [250, 251])
    await session.command('DATA', 354)
    await session.data(buildMessage(cfg.from, cfg.to, content))
    await session.command('QUIT', 221).catch(() => {
      // 有的服务端发完直接断连，QUIT 失败不影响已投递结果
    })
  } catch (err) {
    if (err instanceof MailError) throw err
    throw new MailError(`SMTP 发送失败（${cfg.host}:${cfg.port}）：${errText(err)}`)
  } finally {
    await session.close()
  }
}

class SmtpSession {
  private socket: RawSocket
  private reader: ReadableStreamDefaultReader
  private writer: WritableStreamDefaultWriter
  private decoder = new TextDecoder()
  private buffer = ''
  private deadline = Date.now() + SMTP_TIMEOUT_MS

  constructor(socket: RawSocket) {
    this.socket = socket
    this.reader = socket.readable.getReader()
    this.writer = socket.writable.getWriter()
  }

  /** 总体超时（不是每步各算 20s，避免慢速服务端把一次发送拖到几分钟） */
  private withTimeout<T>(p: Promise<T>, what: string): Promise<T> {
    const remain = this.deadline - Date.now()
    if (remain <= 0) return Promise.reject(new MailError(`SMTP 超时 ${SMTP_TIMEOUT_MS / 1000}s（${what}）`))
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new MailError(`SMTP 超时 ${SMTP_TIMEOUT_MS / 1000}s（${what}）`)), remain)
      p.then(
        (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        (err) => {
          clearTimeout(timer)
          reject(err)
        },
      )
    })
  }

  private async readLine(): Promise<string> {
    for (;;) {
      const idx = this.buffer.indexOf('\r\n')
      if (idx >= 0) {
        const line = this.buffer.slice(0, idx)
        this.buffer = this.buffer.slice(idx + 2)
        return line
      }
      const { value, done } = await this.withTimeout(this.reader.read(), '读取响应')
      if (done) throw new MailError('SMTP 连接被服务端关闭')
      if (value) this.buffer += this.decoder.decode(value, { stream: true })
    }
  }

  /** 多行响应："250-..." 继续，末行 "250 ..." 结束 */
  private async readResponse(): Promise<{ code: number; text: string }> {
    const lines: string[] = []
    for (;;) {
      const line = await this.readLine()
      lines.push(line)
      const m = /^(\d{3})([ -]|$)/.exec(line)
      if (!m) throw new MailError(`SMTP 响应格式异常：${line.slice(0, 120)}`)
      if (m[2] !== '-') return { code: Number(m[1]), text: lines.join('\n') }
    }
  }

  private async write(text: string): Promise<void> {
    await this.withTimeout(this.writer.write(new TextEncoder().encode(text)), '写入命令')
  }

  async expect(code: number): Promise<void> {
    const res = await this.readResponse()
    if (res.code !== code) throw new MailError(`SMTP 握手失败（${res.code}）：${shortReply(res.text)}`)
  }

  async command(line: string, expect: number | number[], label = line.split(' ')[0]): Promise<void> {
    await this.write(line + '\r\n')
    const res = await this.readResponse()
    const okCodes = Array.isArray(expect) ? expect : [expect]
    if (!okCodes.includes(res.code)) throw new MailError(`SMTP ${label} 失败（${res.code}）：${shortReply(res.text)}`)
  }

  /** DATA 以单行 "." 结束；正文是 base64，不会有需要 dot-stuffing 的行首点 */
  async data(message: string): Promise<void> {
    await this.write(message + '\r\n.\r\n')
    const res = await this.readResponse()
    if (res.code !== 250) throw new MailError(`SMTP DATA 失败（${res.code}）：${shortReply(res.text)}`)
  }

  /** STARTTLS 升级：必须先释放旧 reader/writer，再调用 startTls（workerd 会复用底层流，持锁升级会报 locked） */
  upgrade(): void {
    this.reader.releaseLock()
    this.writer.releaseLock()
    const next = this.socket.startTls()
    this.socket = next
    this.decoder = new TextDecoder()
    this.buffer = ''
    this.reader = next.readable.getReader()
    this.writer = next.writable.getWriter()
  }

  async close(): Promise<void> {
    try {
      await this.writer.close()
    } catch {
      // 正常关闭失败不覆盖原始错误
    }
    try {
      await this.socket.close()
    } catch {
      // 同上
    }
  }
}

// ---------- 报文 ----------

function buildMessage(from: string, to: string, content: MailContent): string {
  const subject = content.subject.replace(/[\r\n]+/g, ' ').trim()
  const domain = mailbox(from).split('@').pop() || 'workbench.local'
  return [
    `Date: ${new Date().toUTCString()}`,
    `From: ${sanitizeHeader(from)}`,
    `To: ${sanitizeHeader(to)}`,
    `Subject: =?UTF-8?B?${encodeBase64(subject)}?=`,
    `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    foldBase64(encodeBase64(content.html)),
  ].join('\r\n')
}

/** "Name <a@b>" → a@b（未加尖括号时原样返回） */
function mailbox(addr: string): string {
  const m = /<([^>]+)>/.exec(addr)
  return (m ? m[1] : addr).trim()
}

function sanitizeHeader(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim()
}

function encodeBase64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let bin = ''
  const chunk = 0x8000 // 分段喂 String.fromCharCode，避免大正文爆栈
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(bin)
}

/** RFC 2045：每 76 字符折行 */
function foldBase64(b64: string): string {
  return b64.replace(/(.{76})/g, '$1\r\n')
}

function shortReply(text: string): string {
  return text.replace(/^[0-9]{3}[ -]?/gm, '').trim().slice(0, 300)
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
