/** DingTalk (钉钉) robot callback messages as domain Triggers, and the Channel address a reply goes to. */
import { z } from 'zod'
import { key, type ChannelRef, type Trigger } from '../core/index.ts'

export const SOURCE = 'dingtalk'
/** Stable Trigger id of a DingTalk message; repeated delivery of the same Stream message is therefore harmless. */
export const dingtalkTriggerId = (messageId: string): string => key(SOURCE, messageId)
/** A reply goes to the conversation the robot received the message in, to the member who sent it in a one-to-one chat. */
export const dingtalkChannel = (message: Pick<DingtalkMessage, 'conversationId' | 'conversationType' | 'msgId'>, staffId: string): ChannelRef =>
  ({ source: SOURCE, thread: `dingtalk:${message.conversationId}`,
    address: { conversationId: message.conversationId, conversationType: String(message.conversationType), staffId, messageId: message.msgId } })
/** One robot callback payload as DingTalk's Stream mode sends it. */
export const DingtalkMessageSchema = z.looseObject({
  msgId: z.string().min(1), conversationId: z.string().min(1), conversationType: z.union([z.string(), z.number()]).default('1'),
  msgtype: z.string().default('text'), text: z.looseObject({ content: z.string().nullish() }).nullish(),
  senderId: z.string().nullish(), senderStaffId: z.string().nullish(), senderNick: z.string().nullish(),
  robotCode: z.string().nullish(), createAt: z.union([z.number(), z.string()]).nullish(),
})
export type DingtalkMessage = z.infer<typeof DingtalkMessageSchema>
/** Parses a Stream callback payload; malformed payloads throw so the caller can report the message as unreadable. */
export function dingtalkMessage(data: unknown): DingtalkMessage { return DingtalkMessageSchema.parse(data) }
/** Parses DingTalk's millisecond `createAt`, falling back to the receive time when it is absent. */
export function dingtalkTime(value: number | string | null | undefined): string {
  const time = Number(value)
  return Number.isFinite(time) && time > 0 ? new Date(time).toISOString() : new Date().toISOString()
}
/**
 * Converts a DingTalk robot message into a Trigger. The conversation is the Thread, so a later message in the same
 * chat continues an open Ticket. A group message reaches the robot only when it mentions the robot; a one-to-one
 * message is addressed to it directly. Only text messages carry a request; other kinds return none.
 */
export function dingtalkTrigger(message: DingtalkMessage): Trigger | undefined {
  if (message.msgtype !== 'text') return undefined
  const text = message.text?.content?.trim()
  if (!text) return undefined
  const sender = message.senderStaffId || message.senderId
  if (!sender) return undefined
  const group = String(message.conversationType) === '2'
  return {
    id: dingtalkTriggerId(message.msgId), source: SOURCE, threads: [{ source: SOURCE, id: message.conversationId }],
    actor: { source: SOURCE, id: sender }, human: true, addressed: group ? 'mention' : 'direct',
    at: dingtalkTime(message.createAt), text, channel: dingtalkChannel(message, sender),
    meta: { conversationId: message.conversationId, conversationType: String(message.conversationType), messageId: message.msgId,
      senderStaffId: sender, ...(message.senderNick ? { senderNick: message.senderNick } : {}), ...(message.robotCode ? { robotCode: message.robotCode } : {}) },
  }
}
