import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Engine, key, type Assessor, type Executor, type OutboundMessage, type Thread, type Trigger } from '../src/core/index.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { Store } from '../src/app/store.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { Commands } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { forgetWecomTokens, sendWecom } from '../src/sources/wecom-channel.ts'
import { encryptWecom, wecomSignature } from '../src/sources/wecom-crypto.ts'
import { answerWecom, watchWecom, wecomKind } from '../src/sources/wecom.ts'
import { wecomMessage, wecomTrigger } from '../src/sources/wecom-trigger.ts'
import { testDeployment } from './fixtures/deployment.ts'

const credentials = { corpId: 'ww123456', agentId: 1000002, secret: 'corp-secret', token: 'callbacktoken', encodingAESKey: 'a'.repeat(43) }
const message = (content = '请帮我修一下文案') => `<xml><ToUserName><![CDATA[${credentials.corpId}]]></ToUserName>` +
  `<FromUserName><![CDATA[zhangsan]]></FromUserName><CreateTime>1757376000</CreateTime>` +
  `<MsgType><![CDATA[text]]></MsgType><Content><![CDATA[${content}]]></Content><MsgId>1234567890</MsgId>` +
  `<AgentID>${credentials.agentId}</AgentID></xml>`
function credentialsFile(overrides: Record<string, unknown> = {}): string {
  const path = join(mkdtempSync(join(tmpdir(), 'wecom-credentials-')), 'app.json')
  writeFileSync(path, JSON.stringify({ ...credentials, ...overrides }))
  return path
}
function callback(inner: string, options: { timestamp?: string; nonce?: string; path?: string; token?: string } = {}) {
  const timestamp = options.timestamp ?? '1757376000', nonce = options.nonce ?? 'nonce'
  const encrypt = encryptWecom(inner, credentials.encodingAESKey, credentials.corpId)
  const signature = wecomSignature(options.token ?? credentials.token, timestamp, nonce, encrypt)
  return { method: 'POST', url: `${options.path ?? '/wecom'}?msg_signature=${signature}&timestamp=${timestamp}&nonce=${nonce}`,
    body: `<xml><ToUserName><![CDATA[${credentials.corpId}]]></ToUserName><Encrypt><![CDATA[${encrypt}]]></Encrypt>` +
      `<AgentID><![CDATA[${credentials.agentId}]]></AgentID></xml>` }
}
async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise<void>(resolve => server.close(() => resolve()))
  return port
}
function host(path = credentialsFile(), config: Record<string, unknown> = {}) {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'wecom-')), 'db.sqlite'))
  store.saveSettings(SettingsSchema.parse({ policy: { sources: { wecom: { allowed: [{ id: 'zhangsan', name: 'Zhang San' }] } } },
    eval: { mode: 'auto' }, sources: { wecom: { enabled: true, config: { credentials: path, host: '127.0.0.1', port: 8091, path: '/wecom', ...config } } } }))
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board)
  sources.register(wecomKind)
  const assessor: Assessor = { request: vi.fn(async () => {}) }
  const executor: Executor = { start: vi.fn(async () => {}), deliver: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources), assessor, executor,
    outbox: { send: () => {}, status: () => undefined, withdraw: () => {} } })
  const commands = new Commands(() => testDeployment(), {}, new AbortController().signal)
  const receive = vi.fn((trigger: Trigger) => { const result = engine.receive(trigger); engine.evaluateDue(); return result })
  const deps: SourceContextDeps = { store, engine, outbox: { send: () => {} }, commands, sources, deployment: testDeployment(),
    ready: Promise.resolve(), configured: () => true, receive }
  return { store, engine, sources, board, commands, receive, ctx: sourceContextOf(deps, wecomKind) }
}
afterEach(() => { forgetWecomTokens(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('wecom source', () => {
  it('verifies a callback URL by returning the decrypted echo string', async () => {
    const h = host()
    const echo = encryptWecom('echo-123', credentials.encodingAESKey, credentials.corpId)
    const timestamp = '1757376000', nonce = 'n'
    const signature = wecomSignature(credentials.token, timestamp, nonce, echo)
    const answer = await answerWecom(h.ctx, { credentials: credentialsFile(), host: '127.0.0.1', port: 8091, path: '/wecom' },
      { method: 'GET', url: `/wecom?msg_signature=${signature}&timestamp=${timestamp}&nonce=${nonce}&echostr=${encodeURIComponent(echo)}` })
    expect(answer).toEqual({ status: 200, body: 'echo-123' })
  })
  it('takes in a signed text callback once, on the sender\'s conversation, as an explicit request', async () => {
    const h = host()
    const config = { credentials: credentialsFile(), host: '127.0.0.1', port: 8091, path: '/wecom' }
    const first = await answerWecom(h.ctx, config, callback(message()))
    expect(first).toEqual({ status: 200, body: 'success' })
    const trigger = h.receive.mock.calls[0]![0]
    expect(trigger).toMatchObject({ id: key('wecom', '1234567890'), source: 'wecom', threads: [{ source: 'wecom', id: 'zhangsan' }],
      actor: { source: 'wecom', id: 'zhangsan' }, human: true, addressed: 'direct', at: '2025-09-09T00:00:00.000Z',
      text: '请帮我修一下文案', channel: { source: 'wecom', thread: 'wecom:zhangsan', address: { userId: 'zhangsan', messageId: '1234567890', agentId: '1000002' } } })
    expect(h.engine.candidate(key('wecom', '1234567890'))?.strength).toBe('explicit')
    // WeCom repeats a callback when the acknowledgement is lost; the stable Trigger id stores it once.
    await answerWecom(h.ctx, config, callback(message()))
    expect(h.store.triggers.get(key('wecom', '1234567890'))).toBeDefined()
  })
  it('rejects a tampered signature and messages that are not requests', async () => {
    const h = host()
    const config = { credentials: credentialsFile(), host: '127.0.0.1', port: 8091, path: '/wecom' }
    const tampered = callback(message(), { token: 'wrong-token' })
    expect((await answerWecom(h.ctx, config, tampered)).status).toBe(403)
    expect(h.receive).not.toHaveBeenCalled()
    const image = `<xml><FromUserName><![CDATA[zhangsan]]></FromUserName><CreateTime>1757376000</CreateTime>` +
      `<MsgType><![CDATA[image]]></MsgType><MsgId>22</MsgId></xml>`
    expect(await answerWecom(h.ctx, config, callback(image))).toEqual({ status: 200, body: 'success' })
    expect(h.receive).not.toHaveBeenCalled()
    // The callback path is the only route the server answers.
    expect((await answerWecom(h.ctx, config, { method: 'POST', url: '/other' })).status).toBe(404)
  })
  it('parses voice recognition and timestamps, and skips events', () => {
    const voice = wecomMessage(`<xml><FromUserName><![CDATA[zhangsan]]></FromUserName><CreateTime>1757376000</CreateTime>` +
      `<MsgType><![CDATA[voice]]></MsgType><Recognition><![CDATA[把首页的标题改短一点]]></Recognition><MsgId>99</MsgId></xml>`)!
    expect(wecomTrigger(voice)).toMatchObject({ text: '把首页的标题改短一点', at: '2025-09-09T00:00:00.000Z' })
    expect(wecomMessage('<xml><FromUserName><![CDATA[zhangsan]]></FromUserName><MsgType><![CDATA[event]]></MsgType></xml>')).toBeUndefined()
  })
  it('reports an allowed member\'s direct message as explicit and someone else as not a member', () => {
    const h = host()
    const trigger = wecomTrigger(wecomMessage(message())!)!
    const thread = { key: 'wecom:zhangsan', ref: { source: 'wecom', id: 'zhangsan' }, createdAt: '', subscriptions: [],
      correlated: [], pending: [], meta: {} } as Thread
    expect(settingsPolicy(h.store.settings(), h.sources).gate(trigger, thread, [])).toMatchObject({ admissible: true, strength: 'explicit' })
    const guest = { ...trigger, actor: { source: 'wecom', id: 'lisi' } }
    expect(settingsPolicy(h.store.settings(), h.sources).gate(guest, thread, [])).toMatchObject({ admissible: false, reason: 'not_a_member' })
  })
  it('sends through the app API, records the platform message id, and treats a missing member as gone', async () => {
    const path = credentialsFile()
    const answer = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    const sent: { url: string; body: unknown }[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/gettoken')) return answer({ errcode: 0, access_token: 'token-1', expires_in: 7200 })
      sent.push({ url: String(url), body: JSON.parse(String(init?.body)) })
      return answer(sent.length === 1 ? { errcode: 0, errmsg: 'ok', msgid: 'm-1' } : { errcode: 81013, errmsg: 'user not found' })
    }))
    const outbound = (id: string): OutboundMessage => ({ id, kind: 'reply', text: 'Done, PR ready', channel: { source: 'wecom', thread: 'wecom:zhangsan',
      address: { userId: 'zhangsan', messageId: '1234567890', agentId: '1000002' } } })
    const h = host(path)
    expect(await sendWecom({ commands: h.commands, config: { credentials: path } }, outbound('r1'))).toEqual({ result: 'sent', externalId: 'm-1' })
    expect(sent[0]!.body).toMatchObject({ touser: 'zhangsan', msgtype: 'text', agentid: 1000002, text: { content: 'Done, PR ready' } })
    expect(await sendWecom({ commands: h.commands, config: { credentials: path } }, outbound('r2'))).toEqual({ result: 'gone' })
  })
  it('runs the callback server while the Source is on, then stops listening', async () => {
    const port = await freePort()
    const h = host(credentialsFile(), { port })
    const controller = new AbortController()
    const running = watchWecom(h.ctx, controller.signal)
    await vi.waitFor(() => expect(h.board.all.wecom).toMatchObject({ state: 'ready' }), { timeout: 5000 })
    const signed = callback(message())
    const answer = await fetch(`http://127.0.0.1:${port}${signed.url}`, { method: 'POST', body: signed.body })
    expect(answer.status).toBe(200)
    expect(h.receive).toHaveBeenCalledTimes(1)
    controller.abort()
    await running
    await expect(fetch(`http://127.0.0.1:${port}/wecom`, { method: 'POST' })).rejects.toThrow()
  })
  it('pauses until setup finishes, and while its credentials cannot be read', async () => {
    const h = host(credentialsFile(), { port: await freePort() })
    const paused = async (configured: boolean, path = credentialsFile()) => {
      const store = new Store(join(mkdtempSync(join(tmpdir(), 'wecom-paused-')), 'db.sqlite'))
      store.saveSettings(SettingsSchema.parse({ sources: { wecom: { enabled: true, config: { credentials: path, host: '127.0.0.1',
        port: await freePort(), path: '/wecom' } } } }))
      const board = new HealthBoard()
      const sources = new SourceRegistry(() => store.settings(), board)
      sources.register(wecomKind)
      const deps: SourceContextDeps = { store, engine: h.engine, outbox: { send: () => {} }, commands: h.commands, sources,
        deployment: testDeployment(), ready: Promise.resolve(), configured: () => configured, receive: h.receive }
      const ctx = sourceContextOf(deps, { kind: 'wecom', health: ['wecom'] })
      const controller = new AbortController()
      const running = watchWecom(ctx, controller.signal)
      if (!configured) { await running; return board.all.wecom }
      await vi.waitFor(() => expect(board.all.wecom).toMatchObject({ state: 'paused' }), { timeout: 5000 })
      controller.abort(); await running
      return board.all.wecom
    }
    expect(await paused(false)).toMatchObject({ state: 'paused', code: 'setupPending' })
    expect(await paused(true, join(tmpdir(), 'missing-wecom-credentials.json'))).toMatchObject({ state: 'paused' })
  })
})
