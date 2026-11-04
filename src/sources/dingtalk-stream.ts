/**
 * DingTalk (钉钉) Stream mode: an outbound WebSocket, so no public callback URL is needed. The robot obtains an
 * endpoint and ticket from the gateway, receives callback frames and acknowledges each one.
 */
import { z } from 'zod'
import { requestJson } from '../infra/http.ts'
import type { SourceContext } from './host.ts'
import { dingtalkMessage, dingtalkTrigger } from './dingtalk-trigger.ts'

export const GATEWAY_URL = 'https://api.dingtalk.com/v1.0/gateway/connections/open'
/** The callback topic that carries robot messages. */
export const ROBOT_TOPIC = '/v1.0/im/bot/messages/get'
const FrameSchema = z.looseObject({ type: z.string(), headers: z.looseObject({ topic: z.string().optional(), messageId: z.string().optional() }).default({}),
  data: z.string().optional() })
export type StreamFrame = z.infer<typeof FrameSchema>
const GatewaySchema = z.object({ endpoint: z.url(), ticket: z.string().min(1) })
/** Acknowledges one downstream frame; DingTalk retries a callback the robot leaves unacknowledged. */
const ack = (frame: StreamFrame, data: string): Record<string, unknown> => ({ code: 200,
  headers: { messageId: frame.headers.messageId, contentType: 'application/json' }, message: 'OK', data })
/**
 * Handles one Stream frame: system frames (ping, disconnect) and robot callbacks. A robot message is stored before
 * it is acknowledged; a storage failure leaves it unacknowledged so DingTalk delivers it again, and stable Trigger
 * IDs make the second delivery harmless. A malformed payload is acknowledged and reported, not retried forever.
 * @returns `close` when the server asked the client to disconnect.
 */
export async function handleDingtalkFrame(ctx: Pick<SourceContext, 'receive' | 'threads'>,
  frame: StreamFrame, send: (payload: unknown) => void): Promise<'none' | 'close'> {
  if (!frame.headers.messageId) return 'none'
  if (frame.type === 'SYSTEM') {
    if (frame.headers.topic === 'ping' || frame.headers.topic === 'disconnect') {
      send(ack(frame, frame.data ?? ''))
      return frame.headers.topic === 'disconnect' ? 'close' : 'none'
    }
    return 'none'
  }
  if (frame.type === 'EVENT') { send(ack(frame, JSON.stringify({ status: 'SUCCESS' }))); return 'none' }
  if (frame.type !== 'CALLBACK') return 'none'
  if (frame.headers.topic !== ROBOT_TOPIC) { send(ack(frame, JSON.stringify({ status: 'SUCCESS' }))); return 'none' }
  let message: ReturnType<typeof dingtalkMessage>
  try { message = dingtalkMessage(JSON.parse(frame.data ?? 'null')) }
  catch (error) {
    // Acknowledge so the server stops retrying a payload this version cannot read; the caller reports it.
    send(ack(frame, JSON.stringify({ status: 'SUCCESS' })))
    throw error
  }
  const trigger = dingtalkTrigger(message)
  if (trigger) {
    await ctx.receive(trigger)
    const name = String(trigger.meta.senderNick ?? trigger.actor.id)
    for (const ref of trigger.threads) {
      ctx.threads.describe(`${ref.source}:${ref.id}`, { label: String(trigger.meta.conversationType) === '2' ? `群 ${ref.id}` : name,
        facts: { member: { value: name } } })
    }
  }
  send(ack(frame, frame.data ?? ''))
  return 'none'
}
/** A live Stream connection: send a frame, close it, and await its end. */
export interface StreamConnection { send(payload: unknown): void; close(): void; done: Promise<void> }
/** Opens the gateway connection and the WebSocket; resolves once the socket is open. */
export async function openDingtalkStream(credentials: { clientId: string; clientSecret: string },
  options: { signal: AbortSignal; onFrame(frame: StreamFrame): void | Promise<void>; onOpen?(): void }): Promise<StreamConnection> {
  const WebSocket = globalThis.WebSocket
  if (!WebSocket) throw new Error('This Node.js build has no WebSocket client; DingTalk Stream needs Node 22.4 or later')
  const gateway = GatewaySchema.parse(await requestJson(GATEWAY_URL, { signal: options.signal, body: {
    clientId: credentials.clientId, clientSecret: credentials.clientSecret,
    subscriptions: [{ type: 'CALLBACK', topic: ROBOT_TOPIC }], ua: `dsh-superagent/0.1.0 node/${process.version}` } }))
  const socket = new WebSocket(`${gateway.endpoint}?ticket=${encodeURIComponent(gateway.ticket)}`)
  let opened = false
  let chain = Promise.resolve()
  const finished = new Promise<void>(resolve => { socket.addEventListener('close', () => resolve(), { once: true }) })
  const ready = new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => { opened = true; options.onOpen?.(); resolve() }, { once: true })
    socket.addEventListener('error', () => { if (!opened) reject(new Error('The DingTalk Stream socket failed before it opened')) }, { once: true })
    socket.addEventListener('close', () => { if (!opened) reject(new Error('The DingTalk Stream socket closed before it opened')) }, { once: true })
    socket.addEventListener('message', event => {
      // Frames are processed in order; one slow callback must not let the next frame overtake it.
      let parsed: unknown
      try { parsed = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data)) }
      catch { return }
      const frame = FrameSchema.safeParse(parsed)
      if (!frame.success) return
      chain = chain.then(() => options.onFrame(frame.data)).catch(() => {})
    })
  })
  const close = (): void => { try { socket.close() } catch { /* Already closing. */ } }
  if (options.signal.aborted) close()
  else options.signal.addEventListener('abort', close, { once: true })
  try { await ready }
  catch (error) { close(); throw error }
  return { send: payload => { if (socket.readyState === WebSocket.OPEN) void socket.send(JSON.stringify(payload)) },
    close, done: finished.then(() => { options.signal.removeEventListener('abort', close) }) }
}
