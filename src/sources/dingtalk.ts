/** DingTalk (钉钉) Source kind, Stream loop and Cordis plugin entry; see docs/009-wecom-dingtalk-sources.md. */
import type { Context } from '@deepseek-ai/cordis'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { health, sourceContext, type SourceContext } from './host.ts'
import type { SourceKind } from './kind.ts'
import { dingtalkCredentials, dingtalkLink, sendDingtalk } from './dingtalk-channel.ts'
import { handleDingtalkFrame, openDingtalkStream, type StreamConnection } from './dingtalk-stream.ts'
import { SOURCE, dingtalkMessage, dingtalkTrigger } from './dingtalk-trigger.ts'

export { SOURCE, dingtalkMessage, dingtalkTrigger, dingtalkTriggerId } from './dingtalk-trigger.ts'
export { dingtalkCredentials, sendDingtalk } from './dingtalk-channel.ts'
export { handleDingtalkFrame, openDingtalkStream, ROBOT_TOPIC } from './dingtalk-stream.ts'

const DingtalkConfigSchema = z.object({
  // Credentials are edited in the panel; formats are checked here, and emptiness is allowed until the Source is used.
  clientId: z.string().trim().max(128).regex(/^[A-Za-z0-9_.-]*$/).default(''),
  clientSecret: z.string().max(256).default(''),
  robotCode: z.string().trim().max(128).regex(/^[A-Za-z0-9_.-]*$/).default(''),
}).strict()
export type DingtalkConfig = z.infer<typeof DingtalkConfigSchema>

const rows = [
  { id: 'direct', label: { zh: '单聊机器人', en: 'Direct chat' }, note: { zh: '接收', en: 'Received' } },
  { id: 'group', label: { zh: '群聊 @ 机器人', en: 'Group mentions' }, note: { zh: '仅 @', en: '@ only' } },
]
export const dingtalkKind: SourceKind<DingtalkConfig> = {
  kind: SOURCE,
  title: { zh: '钉钉', en: 'DingTalk' },
  description: { zh: '通过 Stream 长连接接收单聊和群里 @ 机器人的消息，并以机器人身份回复，不需要公网回调。',
    en: 'Receives messages sent to the robot in direct chats and group mentions over a Stream WebSocket, and replies as the robot without a public callback URL.' },
  schema: DingtalkConfigSchema,
  fields: [
    { key: 'clientId', type: 'text', pattern: '[A-Za-z0-9]*', label: { zh: '机器人 Client ID（AppKey）', en: 'Robot Client ID' },
      hint: { zh: '钉钉开发者后台 → 你的应用 → 凭证与基础信息 → Client ID。',
        en: 'DingTalk developer console → your app → Credentials → Client ID.' } },
    { key: 'clientSecret', type: 'secret', label: { zh: '机器人 Client Secret', en: 'Robot Client Secret' },
      hint: { zh: '同一页的 Client Secret；保存后只显示一次。',
        en: 'The Client Secret on the same page; it is shown once.' } },
    { key: 'robotCode', type: 'text', pattern: '[A-Za-z0-9]*', label: { zh: '机器人 RobotCode', en: 'RobotCode' },
      hint: { zh: '机器人编码，通常与 Client ID 相同；留空时使用 Client ID。',
        en: 'The robot code, usually the same as the Client ID; leave it empty to use the Client ID.' } },
  ],
  health: ['dingtalk'],
  scope: ({ meta }) => ({ listened: true, observed: false, row: String(meta.conversationType) === '2' ? 'group' : 'direct' }),
  channel: {
    allowed: address => !!address.conversationId && (address.conversationType === '2' || !!address.staffId),
    send: sendDingtalk,
    link: dingtalkLink,
  },
  policy: {
    unnamed: { person: { zh: '钉钉成员', en: 'DingTalk member' }, bot: { zh: '钉钉机器人', en: 'DingTalk robot' } },
    schema: z.object({
      allowed: z.array(z.object({ id: z.string().trim().min(1).max(128), name: z.string().trim().max(100).optional() }).strict())
        .refine(users => new Set(users.map(user => user.id)).size === users.length, 'Duplicate user ids').default([]),
    }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的钉钉成员', en: 'DingTalk members who may originate work' },
      columns: [{ key: 'id', type: 'text', label: { zh: '员工 UserID', en: 'Staff UserID' } },
        { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] }],
    explicit: { zh: '名单内的成员在单聊里发消息，或在群里 @ 机器人，总是明确的请求。', en: 'A listed member who messages the robot directly or mentions it in a group always makes an explicit request.' },
    rows: () => rows.map(({ id, label, note }) => ({ id, label, note,
      cells: { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false } })),
  },
  environment: {
    variables: [{ key: 'DSH_SUPERAGENT_DINGTALK_USER', description: {
      zh: '发起工单的钉钉成员 UserID；工单不是从钉钉来的时为空',
      en: 'UserID of the DingTalk member who started the ticket; empty when the ticket did not start on DingTalk' } }],
    values: ({ trigger }) => ({ DSH_SUPERAGENT_DINGTALK_USER: trigger?.source === SOURCE ? String(trigger.meta.senderStaffId ?? '') : '' }),
  },
}

/** Runs the Stream connection while the Source is enabled, reconnecting with backoff after a failure. */
export async function watchDingtalk(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  if (!ctx.configured()) { ctx.report('dingtalk', health('paused', 'setupPending')); return }
  let failures = 0
  while (!signal.aborted) {
    const config = ctx.config<DingtalkConfig>(SOURCE)
    if (!config) {
      ctx.report('dingtalk', health('paused', 'sourceOff'))
      await delay(5000, undefined, { signal }).catch(() => {})
      continue
    }
    let credentials
    try { credentials = dingtalkCredentials(config) }
    catch (error) {
      ctx.report('dingtalk', { state: 'paused', detail: String(error) })
      await delay(15_000, undefined, { signal }).catch(() => {})
      continue
    }
    const running = new AbortController()
    const stop = (): void => running.abort()
    signal.addEventListener('abort', stop, { once: true })
    // Disabling the Source or changing its credentials closes the Stream so a saved form takes effect at once.
    const check = setInterval(() => {
      const current = ctx.config<DingtalkConfig>(SOURCE)
      if (!current || JSON.stringify(current) !== JSON.stringify(config)) running.abort()
    }, 5000)
    // Frames can arrive between the socket opening and `openDingtalkStream` returning; hold their acknowledgements.
    let connection: StreamConnection | undefined
    const queued: unknown[] = []
    const send = (payload: unknown): void => { if (connection) connection.send(payload); else queued.push(payload) }
    try {
      connection = await openDingtalkStream(credentials, {
        signal: running.signal,
        onOpen: () => { failures = 0; ctx.report('dingtalk', { state: 'ready', detail: 'Connected to the DingTalk Stream', at: new Date().toISOString() }) },
        onFrame: async frame => {
          try {
            const action = await handleDingtalkFrame(ctx, frame, send)
            if (action === 'close') connection?.close()
          } catch (error) {
            ctx.report('dingtalk', { state: 'error', detail: String(error) })
          }
        },
      })
      for (const payload of queued.splice(0)) connection.send(payload)
      await connection.done
      if (!running.signal.aborted) throw new Error('DingTalk closed the Stream connection')
    } catch (error) {
      if (!running.signal.aborted) {
        failures += 1
        const detail = `The DingTalk Stream failed: ${error instanceof Error ? error.message : String(error)}`
        // One dropped connection is retried at once; three in a row need a person.
        ctx.report('dingtalk', failures >= 3 ? { state: 'error', detail } : { state: 'starting', detail })
      }
    } finally {
      clearInterval(check)
      running.abort()
      signal.removeEventListener('abort', stop)
    }
    const wait = Math.min(1000 * 2 ** Math.min(failures, 6), 60_000)
    await delay(wait, undefined, { signal }).catch(() => {})
  }
}

export const name = 'dsh-superagent-dingtalk'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(dingtalkKind), 'dingtalk: source kind')
  ctx.effect(() => {
    const controller = new AbortController()
    const source = sourceContext(ctx.orchestrator, dingtalkKind)
    const running = watchDingtalk(source, controller.signal)
      .catch((error: unknown) => { source.report('dingtalk', { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}
