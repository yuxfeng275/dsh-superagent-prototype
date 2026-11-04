/** WeCom (企业微信) Source kind, callback receiver and Cordis plugin entry; see docs/009-wecom-dingtalk-sources.md. */
import type { Context } from '@deepseek-ai/cordis'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { threadKey, type Trigger } from '../core/index.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import type { SourceKind } from './kind.ts'
import { sendWecom, wecomCredentials, wecomLink } from './wecom-channel.ts'
import { decryptWecom, wecomSignature, wecomSignatureMatches, xmlText } from './wecom-crypto.ts'
import { SOURCE, wecomMessage, wecomTrigger } from './wecom-trigger.ts'

export { SOURCE, wecomMessage, wecomTrigger, wecomTriggerId } from './wecom-trigger.ts'
export { sendWecom, wecomCredentials, wecomLink } from './wecom-channel.ts'
export { decryptWecom, encryptWecom, wecomSignature } from './wecom-crypto.ts'

const WecomConfigSchema = z.object({
  // Credentials are edited in the panel; formats are checked here, and emptiness is allowed until the Source is used.
  corpId: z.string().trim().max(64).regex(/^[A-Za-z0-9]*$/).default(''),
  agentId: z.string().trim().max(16).regex(/^\d*$/).default(''),
  secret: z.string().max(256).default(''),
  token: z.string().trim().max(64).regex(/^[A-Za-z0-9]*$/).default(''),
  encodingAESKey: z.string().trim().max(43).regex(/^[A-Za-z0-9]*$/).default(''),
  host: z.string().trim().min(1).default('127.0.0.1'),
  port: z.number().int().min(1).max(65535).default(8091),
  path: z.string().trim().regex(/^\/[A-Za-z0-9/_-]*$/).default('/wecom'),
}).strict()
export type WecomConfig = z.infer<typeof WecomConfigSchema>

export const wecomKind: SourceKind<WecomConfig> = {
  kind: SOURCE,
  title: { zh: '企业微信', en: 'WeCom' },
  description: { zh: '接收成员发给企业微信自建应用的消息，并以应用身份回复。回调地址需要能从公网访问。',
    en: 'Receives messages members send to a WeCom self-built app and replies as the app. The callback URL must be reachable from the internet.' },
  schema: WecomConfigSchema,
  fields: [
    { key: 'corpId', type: 'text', pattern: '[A-Za-z0-9]*', label: { zh: '企业 ID（CorpID）', en: 'Corp ID' },
      hint: { zh: '企业微信管理后台 → 我的企业 → 企业信息 → 企业ID，通常以 ww 开头。',
        en: 'WeCom admin console → My Enterprise → Enterprise Info → Corp ID; it usually starts with ww.' } },
    { key: 'agentId', type: 'text', pattern: '[0-9]*', label: { zh: '应用 AgentId', en: 'App AgentId' },
      hint: { zh: '应用管理 → 自建 → 你的应用 → AgentId，例如 1000002。',
        en: 'App Management → Self-built → your app → AgentId, for example 1000002.' } },
    { key: 'secret', type: 'secret', label: { zh: '应用 Secret', en: 'App Secret' },
      hint: { zh: '应用详情 → Secret；保存后只显示一次，可重置后再填。',
        en: 'App detail → Secret; it is shown once and can be reset if lost.' } },
    { key: 'token', type: 'secret', pattern: '[A-Za-z0-9]*', label: { zh: '回调 Token', en: 'Callback Token' },
      hint: { zh: '应用详情 → 接收消息 → API 接收 里的 Token，由英文和数字组成。',
        en: 'App detail → Receive Messages → API receive → Token; letters and digits.' } },
    { key: 'encodingAESKey', type: 'secret', pattern: '[A-Za-z0-9]*', label: { zh: '回调 EncodingAESKey', en: 'Callback EncodingAESKey' },
      hint: { zh: '同一处的 43 位 EncodingAESKey。', en: 'The 43-character EncodingAESKey from the same page.' } },
    { key: 'host', type: 'text', advanced: true, label: { zh: '监听地址', en: 'Listen address' }, hint: { zh: '默认只监听本机，由反向代理转发公网回调；直接暴露时改为 0.0.0.0。',
      en: 'Listens on the loopback interface by default, leaving a reverse proxy to forward the public callback; use 0.0.0.0 to expose it directly.' } },
    { key: 'port', type: 'number', advanced: true, min: 1, max: 65535, label: { zh: '监听端口', en: 'Listen port' } },
    { key: 'path', type: 'text', advanced: true, pattern: '/[A-Za-z0-9/_-]*', label: { zh: '回调路径', en: 'Callback path' },
      hint: { zh: '把企业微信后台“接收消息”的 URL 设为 https://<你的域名><回调路径>，反向代理到本机该端口。',
        en: 'Set the URL under "Receive Messages" in WeCom to https://<your host><callback path>, proxied to this port on the host.' } },
  ],
  health: ['wecom'],
  scope: () => ({ listened: true, observed: false, row: 'direct' }),
  channel: {
    allowed: (address, _config) => !!address.userId,
    send: sendWecom,
    link: wecomLink,
  },
  policy: {
    unnamed: { person: { zh: '企业微信成员', en: 'WeCom member' }, bot: { zh: '企业微信应用', en: 'WeCom app' } },
    schema: z.object({
      allowed: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_@.-]{1,64}$/), name: z.string().trim().max(100).optional() }).strict())
        .refine(users => new Set(users.map(user => user.id)).size === users.length, 'Duplicate user ids').default([]),
    }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的企业微信成员', en: 'WeCom members who may originate work' },
      columns: [{ key: 'id', type: 'text', label: { zh: 'UserID', en: 'UserID' }, pattern: '[A-Za-z0-9_@.-]{1,64}' },
        { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] }],
    explicit: { zh: '名单内的成员在应用会话里发消息，总是明确的请求。', en: 'A listed member who messages the app always makes an explicit request.' },
    rows: () => [{ id: 'direct', label: { zh: '应用会话', en: 'App conversation' }, note: { zh: '接收', en: 'Received' },
      cells: { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false } }],
  },
  environment: {
    variables: [{ key: 'DSH_SUPERAGENT_WECOM_USER', description: {
      zh: '发起工单的企业微信成员 UserID；工单不是从企业微信来的时为空',
      en: 'UserID of the WeCom member who started the ticket; empty when the ticket did not start on WeCom' } }],
    values: ({ trigger }) => ({ DSH_SUPERAGENT_WECOM_USER: trigger?.source === SOURCE ? String(trigger.meta.userId ?? '') : '' }),
  },
}
/** One callback as the HTTP layer hands it to the Source. */
export interface WecomCallback { method: string; url: string; body?: string }
/** Reads a callback body, bounded so a misbehaving peer cannot exhaust memory. */
async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > 1_048_576) throw new Error('The WeCom callback exceeds 1 MiB')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}
/**
 * Answers one WeCom callback: the GET that verifies the URL returns the decrypted echo string, and a POST
 * verifies and decrypts the event, hands its message to the Engine and acknowledges it. Everything else is a
 * request the Source does not answer.
 */
export async function answerWecom(ctx: Pick<SourceContext, 'receive' | 'threads'>, config: WecomConfig,
  callback: WecomCallback): Promise<{ status: number; body: string }> {
  const url = new URL(callback.url, 'http://localhost')
  if (url.pathname !== config.path) return { status: 404, body: 'not found' }
  const credentials = wecomCredentials(config)
  const signature = url.searchParams.get('msg_signature')
  const timestamp = url.searchParams.get('timestamp')
  const nonce = url.searchParams.get('nonce')
  if (!signature || !timestamp || !nonce) return { status: 400, body: 'missing signature' }
  const method = callback.method.toUpperCase()
  if (method === 'GET') {
    const echo = url.searchParams.get('echostr')
    if (!echo) return { status: 400, body: 'missing echostr' }
    const expected = wecomSignature(credentials.token, timestamp, nonce, echo)
    if (!wecomSignatureMatches(expected, signature)) return { status: 403, body: 'invalid signature' }
    return { status: 200, body: decryptWecom(echo, credentials.encodingAESKey, credentials.corpId) }
  }
  if (method !== 'POST') return { status: 405, body: 'method not allowed' }
  const encrypt = xmlText(callback.body ?? '', 'Encrypt')
  if (!encrypt) return { status: 400, body: 'missing Encrypt' }
  const expected = wecomSignature(credentials.token, timestamp, nonce, encrypt)
  if (!wecomSignatureMatches(expected, signature)) return { status: 403, body: 'invalid signature' }
  const message = wecomMessage(decryptWecom(encrypt, credentials.encodingAESKey, credentials.corpId))
  const trigger: Trigger | undefined = message ? wecomTrigger(message) : undefined
  if (trigger) {
    await ctx.receive(trigger)
    // The member's conversation is the Thread; name it after the sender for the panel.
    for (const ref of trigger.threads) ctx.threads.describe(threadKey(ref), { label: String(trigger.meta.userId ?? ''), facts: { member: { value: String(trigger.meta.userId ?? '') } } })
  }
  return { status: 200, body: 'success' }
}

/** Starts the callback server; a listen failure rejects so the loop can report it and retry. */
async function listen(ctx: SourceContext, config: WecomConfig, signal: AbortSignal): Promise<Server> {
  const server = createServer((request, response) => {
    void (async () => {
      try {
        const body = request.method === 'POST' ? await readBody(request) : undefined
        const answer = await answerWecom(ctx, config, { method: request.method ?? 'GET', url: request.url ?? '/', ...(body === undefined ? {} : { body }) })
        response.statusCode = answer.status
        response.setHeader('content-type', 'text/plain; charset=utf-8')
        response.end(answer.body)
      } catch (error) {
        ctx.report('wecom', { state: 'error', detail: String(error) })
        response.statusCode = 500
        response.end('error')
      }
    })()
  })
  server.on('error', error => ctx.report('wecom', { state: 'error', detail: `The WeCom callback server failed: ${String(error)}` }))
  await new Promise<void>((resolve, reject) => {
    const failed = (error: unknown): void => reject(error)
    server.once('error', failed)
    server.listen(config.port, config.host, () => { server.off('error', failed); resolve() })
  })
  const stop = (): void => { server.close(); server.closeAllConnections() }
  if (signal.aborted) stop()
  else signal.addEventListener('abort', stop, { once: true })
  return server
}
/** Runs the callback server while the Source is enabled, following configuration changes without a restart. */
export async function watchWecom(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  if (!ctx.configured()) { ctx.report('wecom', health('paused', 'setupPending')); return }
  let server: Server | undefined
  let bound = ''
  try {
    while (!signal.aborted) {
      const config = ctx.config<WecomConfig>(SOURCE)
      if (!config) {
        if (server) { server.close(); server = undefined; bound = '' }
        ctx.report('wecom', health('paused', 'sourceOff'))
      } else {
        // Do not listen, and say exactly what is missing, until the panel's credential fields are filled in.
        try { wecomCredentials(config) }
        catch (error) {
          if (server) { server.close(); server = undefined; bound = '' }
          ctx.report('wecom', { state: 'paused', detail: String(error) })
          await delay(5000, undefined, { signal }).catch(() => {})
          continue
        }
        const target = `${config.host}:${config.port}${config.path}`
        if (server && bound !== target) { server.close(); server = undefined; bound = '' }
        if (!server) {
          try { server = await listen(ctx, config, signal); bound = target }
          catch (error) {
            ctx.report('wecom', { state: 'error', detail: `Cannot listen on ${target}: ${error instanceof Error ? error.message : String(error)}` })
            // A busy port rarely clears in five seconds; wait longer before trying again.
            await delay(30_000, undefined, { signal }).catch(() => {})
            continue
          }
        }
        ctx.report('wecom', { state: 'ready', detail: `Listening on ${bound}`, at: new Date().toISOString() })
      }
      await delay(5000, undefined, { signal }).catch(() => {})
    }
  } finally {
    if (server) { server.close(); server.closeAllConnections() }
  }
}

export const name = 'dsh-superagent-wecom'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(wecomKind), 'wecom: source kind')
  ctx.effect(() => {
    const controller = new AbortController()
    const source = sourceContext(ctx.orchestrator, wecomKind)
    const running = watchWecom(source, controller.signal)
      .catch((error: unknown) => { source.report('wecom', { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}
