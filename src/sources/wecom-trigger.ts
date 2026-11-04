/** WeCom (企业微信) callback messages as domain Triggers, and the Channel address a reply goes to. */
import { key, type ChannelRef, type Trigger } from '../core/index.ts'
import { xmlText } from './wecom-crypto.ts'

export const SOURCE = 'wecom'
/** Stable Trigger id of a WeCom message; the id is what makes repeated callbacks harmless. */
export const wecomTriggerId = (messageId: string): string => key(SOURCE, messageId)
/** A reply goes to the member's conversation with the app; `direct` records that the thread is one-to-one. */
export const wecomChannel = (userId: string, messageId: string, agentId: string): ChannelRef =>
  ({ source: SOURCE, thread: `wecom:${userId}`, address: { userId, messageId, agentId, direct: 'true' } })
/** One decrypted callback body, reduced to what the Source reads. */
export interface WecomMessage {
  from: string
  createTime: string
  msgType: string
  messageId?: string
  content?: string
  agentId?: string
}
/** Parses the decrypted XML of a message callback; events (menu clicks, follows) carry no `MsgId` and are ignored. */
export function wecomMessage(xml: string): WecomMessage | undefined {
  const from = xmlText(xml, 'FromUserName')
  const msgType = xmlText(xml, 'MsgType')
  if (!from || !msgType) throw new Error('The WeCom callback has no sender or message type')
  if (msgType === 'event') return undefined
  const messageId = xmlText(xml, 'MsgId')
  if (!messageId) return undefined
  return { from, createTime: xmlText(xml, 'CreateTime') ?? '', msgType, messageId,
    content: xmlText(xml, 'Content') ?? xmlText(xml, 'Recognition'), agentId: xmlText(xml, 'AgentID') }
}
/** Parses a WeCom timestamp, which is a count of seconds. */
export function wecomTime(value: string): string {
  const seconds = Number(value)
  if (!value || !Number.isFinite(seconds)) throw new Error(`Unreadable WeCom message time: ${value}`)
  return new Date(seconds * 1000).toISOString()
}
/**
 * Converts a WeCom message into a Trigger. The member's conversation with the app is the Thread, so a later
 * message from the same member continues an open Ticket, and every message is addressed to the app.
 * Only text and voice-with-recognition messages carry a request; other kinds return none.
 */
export function wecomTrigger(message: WecomMessage): Trigger | undefined {
  const supported = message.msgType === 'text' || message.msgType === 'voice'
  if (!supported) return undefined
  const text = message.content?.trim()
  if (!text) return undefined
  const agentId = message.agentId ?? ''
  return {
    id: wecomTriggerId(message.messageId!), source: SOURCE, threads: [{ source: SOURCE, id: message.from }],
    actor: { source: SOURCE, id: message.from }, human: true, addressed: 'direct', at: wecomTime(message.createTime), text,
    channel: wecomChannel(message.from, message.messageId!, agentId),
    meta: { userId: message.from, messageId: message.messageId, msgType: message.msgType, agentId },
  }
}
