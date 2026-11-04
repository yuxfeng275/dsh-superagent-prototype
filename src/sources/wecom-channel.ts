/** WeCom (企业微信) Channel: the app sends a text message to the member who asked, through the WeCom API. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import type { OutboundMessage } from '../core/index.ts'
import { HttpError, requestJson } from '../infra/http.ts'
import type { Commands } from '../infra/commands.ts'
import type { ChannelLink, ChannelLinks, SendResult } from './kind.ts'

/** The WeCom app's credentials, kept in a local JSON file rather than in the settings database. */
export const WecomCredentialsSchema = z.object({
  corpId: z.string().trim().min(1).max(64),
  agentId: z.number().int().positive(),
  secret: z.string().min(1).max(256),
  token: z.string().regex(/^[A-Za-z0-9]{1,64}$/),
  encodingAESKey: z.string().regex(/^[A-Za-z0-9]{43}$/),
}).strict()
export type WecomCredentials = z.infer<typeof WecomCredentialsSchema>

/** Reads and validates the app credentials named by the Source's `credentials` setting. */
export function loadWecomCredentials(path: string): WecomCredentials {
  if (!path) throw new Error('The WeCom Source has no credentials file')
  let value: unknown
  try { value = JSON.parse(readFileSync(path, 'utf8')) }
  catch (error) { throw new Error(`Cannot read the WeCom credentials file ${path}: ${error instanceof Error ? error.message : String(error)}`) }
  const parsed = WecomCredentialsSchema.safeParse(value)
  if (!parsed.success) throw new Error(`The WeCom credentials file ${path} is not valid: ${parsed.error.issues.map(issue => `${issue.path.join('.')} ${issue.message}`).join('; ')}`)
  return parsed.data
}

const TOKEN_URL = 'https://qyapi.weixin.qq.com/cgi-bin/gettoken'
const SEND_URL = 'https://qyapi.weixin.qq.com/cgi-bin/message/send'
const TokenSchema = z.looseObject({ errcode: z.number().default(0), errmsg: z.string().default(''), access_token: z.string().optional(), expires_in: z.number().optional() })
const SendSchema = z.looseObject({ errcode: z.number().default(0), errmsg: z.string().default(''), msgid: z.string().optional() })
const expired = (code: number): boolean => code === 40014 || code === 42001
/** Permanent send failures: the member no longer exists or is outside the app's visible range. */
const GONE = new Set([40003, 81013])

interface Token { token: string; expiresAt: number }
const tokens = new Map<string, Token>()
const tokenKey = (credentials: WecomCredentials): string =>
  `${credentials.corpId}:${createHash('sha256').update(credentials.secret).digest('hex').slice(0, 16)}`
/** The app access token, cached until shortly before WeCom expires it. */
async function accessToken(credentials: WecomCredentials, signal?: AbortSignal): Promise<string> {
  const cached = tokens.get(tokenKey(credentials))
  if (cached && cached.expiresAt > Date.now()) return cached.token
  const url = `${TOKEN_URL}?corpid=${encodeURIComponent(credentials.corpId)}&corpsecret=${encodeURIComponent(credentials.secret)}`
  const body = TokenSchema.parse(await requestJson(url, { signal }))
  if (body.errcode !== 0 || !body.access_token) throw new HttpError(`WeCom rejected the app credentials: ${body.errmsg} (${body.errcode})`, undefined, String(body.errcode))
  const ttl = Math.max(60, body.expires_in ?? 7200) - 60
  tokens.set(tokenKey(credentials), { token: body.access_token, expiresAt: Date.now() + ttl * 1000 })
  return body.access_token
}
/** Drops cached tokens; tests use it so one stub's token does not leak into the next. */
export function forgetWecomTokens(): void { tokens.clear() }

/**
 * Sends one message to the member and reports the WeCom message id for the effect ledger.
 * A rejected token is retried once with a fresh one; a member who no longer exists is `gone`.
 */
export async function sendWecom(host: { commands: Commands; config: { credentials: string } }, message: OutboundMessage): Promise<SendResult> {
  const userId = message.channel.address.userId
  if (!userId) throw new Error('Missing WeCom reply target')
  const credentials = loadWecomCredentials(host.config.credentials)
  let token = await accessToken(credentials)
  for (let attempt = 0; attempt < 2; attempt++) {
    const body = await requestJson(`${SEND_URL}?access_token=${encodeURIComponent(token)}`, { body: {
      touser: userId, msgtype: 'text', agentid: credentials.agentId, text: { content: message.text }, safe: 0 } })
    const result = SendSchema.parse(body)
    if (result.errcode === 0) return result.msgid ? { result: 'sent', externalId: result.msgid } : { result: 'sent' }
    if (expired(result.errcode) && attempt === 0) {
      tokens.delete(tokenKey(credentials))
      token = await accessToken(credentials)
      continue
    }
    if (GONE.has(result.errcode)) return { result: 'gone' }
    throw new HttpError(`WeCom rejected the message: ${result.errmsg} (${result.errcode})`, undefined, String(result.errcode))
  }
  throw new HttpError('WeCom rejected the message after a token refresh')
}
/** The panel shows which Source a reply went to; WeCom app conversations have no public deep link. */
export function wecomLink(address: Record<string, string>, _links: ChannelLinks): ChannelLink {
  const member = address.userId
  return { url: '', label: member ? { zh: `企业微信成员 ${member}`, en: `WeCom member ${member}` } : { zh: '企业微信消息', en: 'WeCom message' } }
}
