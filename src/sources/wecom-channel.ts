/** WeCom (企业微信) Channel: the app sends a text message to the member who asked, through the WeCom API. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { OutboundMessage } from '../core/index.ts'
import { HttpError, requestJson } from '../infra/http.ts'
import type { Commands } from '../infra/commands.ts'
import type { ChannelLink, ChannelLinks, SendResult } from './kind.ts'

/** The credential fields the Source's settings form edits. */
export interface WecomCredentialFields {
  corpId: string
  agentId: string
  secret: string
  token: string
  encodingAESKey: string
}
/** The validated credentials the WeCom API calls take. */
export interface WecomCredentials { corpId: string; agentId: number; secret: string; token: string; encodingAESKey: string }
/**
 * Validates the app credentials the operator entered, naming the missing fields so the panel can say what to fill.
 * An empty field is allowed in the schema so the Source can be enabled before it is configured; using it is not.
 */
export function wecomCredentials(config: WecomCredentialFields): WecomCredentials {
  const missing = [
    ...config.corpId ? [] : ['CorpID'],
    ...config.agentId ? [] : ['AgentId'],
    ...config.secret ? [] : ['app Secret'],
    ...config.token ? [] : ['callback Token'],
    ...config.encodingAESKey ? [] : ['EncodingAESKey'],
  ]
  if (missing.length) throw new Error(`The WeCom Source is not configured yet; fill in ${missing.join(', ')}`)
  const agentId = Number(config.agentId)
  if (!Number.isInteger(agentId) || agentId <= 0) throw new Error('The WeCom AgentId must be a positive number')
  return { corpId: config.corpId, agentId, secret: config.secret, token: config.token, encodingAESKey: config.encodingAESKey }
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
export async function sendWecom(host: { commands: Commands; config: WecomCredentialFields }, message: OutboundMessage): Promise<SendResult> {
  const userId = message.channel.address.userId
  if (!userId) throw new Error('Missing WeCom reply target')
  const credentials = wecomCredentials(host.config)
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
