/** DingTalk (钉钉) Channel: the robot sends a text message to the member or group through the DingTalk open API. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import type { OutboundMessage } from '../core/index.ts'
import { HttpError, requestJson } from '../infra/http.ts'
import type { Commands } from '../infra/commands.ts'
import type { ChannelLink, ChannelLinks, SendResult } from './kind.ts'

/** The DingTalk robot credentials, kept in a local JSON file rather than in the settings database. */
export const DingtalkCredentialsSchema = z.object({
  clientId: z.string().trim().min(1).max(128),
  clientSecret: z.string().min(1).max(256),
  robotCode: z.string().trim().min(1).max(128).optional(),
}).strict()
export type DingtalkCredentials = z.infer<typeof DingtalkCredentialsSchema>
/** Reads and validates the robot credentials named by the Source's `credentials` setting. */
export function loadDingtalkCredentials(path: string): DingtalkCredentials {
  if (!path) throw new Error('The DingTalk Source has no credentials file')
  let value: unknown
  try { value = JSON.parse(readFileSync(path, 'utf8')) }
  catch (error) { throw new Error(`Cannot read the DingTalk credentials file ${path}: ${error instanceof Error ? error.message : String(error)}`) }
  const parsed = DingtalkCredentialsSchema.safeParse(value)
  if (!parsed.success) throw new Error(`The DingTalk credentials file ${path} is not valid: ${parsed.error.issues.map(issue => `${issue.path.join('.')} ${issue.message}`).join('; ')}`)
  return parsed.data
}

const TOKEN_URL = 'https://api.dingtalk.com/v1.0/oauth2/accessToken'
const GROUP_URL = 'https://api.dingtalk.com/v1.0/robot/groupMessages/send'
const DIRECT_URL = 'https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend'
const TokenSchema = z.looseObject({ accessToken: z.string().optional(), expireIn: z.number().optional() })
const SendSchema = z.looseObject({ processQueryKey: z.string().optional() })
const robotCode = (credentials: DingtalkCredentials): string => credentials.robotCode || credentials.clientId
/** A rejected robot, member or conversation is permanent; a throttled or unauthenticated call is not. */
const gone = (error: unknown): boolean => error instanceof HttpError && (error.status === 404
  || (error.status === 400 && /(robot|staff|user|conversation|chat).*(not found|not exist|invalid|not in)/i.test(error.message)))

interface Token { token: string; expiresAt: number }
const tokens = new Map<string, Token>()
const tokenKey = (credentials: DingtalkCredentials): string =>
  `${credentials.clientId}:${createHash('sha256').update(credentials.clientSecret).digest('hex').slice(0, 16)}`
/** The robot access token, cached until shortly before DingTalk expires it. */
async function accessToken(credentials: DingtalkCredentials, signal?: AbortSignal): Promise<string> {
  const cached = tokens.get(tokenKey(credentials))
  if (cached && cached.expiresAt > Date.now()) return cached.token
  const body = TokenSchema.parse(await requestJson(TOKEN_URL, { body: { appKey: credentials.clientId, appSecret: credentials.clientSecret }, signal }))
  if (!body.accessToken) throw new HttpError('DingTalk did not return an access token')
  const ttl = Math.max(60, body.expireIn ?? 7200) - 60
  tokens.set(tokenKey(credentials), { token: body.accessToken, expiresAt: Date.now() + ttl * 1000 })
  return body.accessToken
}
/** Drops cached tokens; tests use it so one stub's token does not leak into the next. */
export function forgetDingtalkTokens(): void { tokens.clear() }

/**
 * Sends one text message to the conversation and reports the platform's send key for the effect ledger.
 * The open API, unlike the callback's session Webhook, keeps working after a ticket has run for a while.
 */
export async function sendDingtalk(host: { commands: Commands; config: { credentials: string } }, message: OutboundMessage): Promise<SendResult> {
  const { conversationId, conversationType, staffId } = message.channel.address
  const credentials = loadDingtalkCredentials(host.config.credentials)
  const group = conversationType === '2'
  if (!group && !staffId) throw new Error('Missing DingTalk reply target')
  let token = await accessToken(credentials)
  const body = group
    ? { robotCode: robotCode(credentials), openConversationId: conversationId, msgKey: 'sampleText', msgParam: JSON.stringify({ content: message.text }) }
    : { robotCode: robotCode(credentials), userIds: [staffId], msgKey: 'sampleText', msgParam: JSON.stringify({ content: message.text }) }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = SendSchema.parse(await requestJson(group ? GROUP_URL : DIRECT_URL, { body, headers: { 'x-acs-dingtalk-access-token': token } }))
      return result.processQueryKey ? { result: 'sent', externalId: result.processQueryKey } : { result: 'sent' }
    } catch (error) {
      // A token that expired between the cache and the call is refreshed once; other failures keep the Outbox retrying.
      if (error instanceof HttpError && error.status === 401 && attempt === 0) {
        tokens.delete(tokenKey(credentials))
        token = await accessToken(credentials)
        continue
      }
      if (gone(error)) return { result: 'gone' }
      throw error
    }
  }
  throw new HttpError('DingTalk rejected the message after a token refresh')
}
/** WeCom and DingTalk conversations have no public deep link; the panel only needs a label. */
export function dingtalkLink(address: Record<string, string>, _links: ChannelLinks): ChannelLink {
  return { url: '', label: address.conversationType === '2'
    ? { zh: '钉钉群消息', en: 'DingTalk group message' } : { zh: '钉钉消息', en: 'DingTalk message' } }
}
