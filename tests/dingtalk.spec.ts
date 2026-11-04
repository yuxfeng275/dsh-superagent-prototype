import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Engine, key, type Assessor, type Executor, type OutboundMessage, type Thread, type Trigger } from '../src/core/index.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { Store } from '../src/app/store.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { Commands } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { forgetDingtalkTokens, sendDingtalk } from '../src/sources/dingtalk-channel.ts'
import { handleDingtalkFrame, openDingtalkStream, ROBOT_TOPIC, type StreamFrame } from '../src/sources/dingtalk-stream.ts'
import { dingtalkKind, watchDingtalk } from '../src/sources/dingtalk.ts'
import { dingtalkMessage, dingtalkTrigger } from '../src/sources/dingtalk-trigger.ts'
import { testDeployment } from './fixtures/deployment.ts'

const credentials = { clientId: 'ding-client', clientSecret: 'ding-secret', robotCode: 'ding-robot' }
function credentialsFile(overrides: Record<string, unknown> = {}): string {
  const path = join(mkdtempSync(join(tmpdir(), 'dingtalk-credentials-')), 'robot.json')
  writeFileSync(path, JSON.stringify({ ...credentials, ...overrides }))
  return path
}
const payload = (overrides: Record<string, unknown> = {}) => ({ msgId: 'msg-1', conversationId: 'cid-group', conversationType: '2',
  msgtype: 'text', text: { content: ' 请把标题改短 ' }, senderStaffId: 'staff-1', senderNick: 'Zhang San', senderId: 'sender-1',
  robotCode: 'ding-robot', createAt: 1757376000000, sessionWebhook: 'https://oapi.dingtalk.com/robot/sendBySession?session=x', ...overrides })
function host(config: Record<string, unknown> = {}) {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'dingtalk-')), 'db.sqlite'))
  store.saveSettings(SettingsSchema.parse({ policy: { sources: { dingtalk: { allowed: [{ id: 'staff-1', name: 'Zhang San' }] } } },
    eval: { mode: 'auto' }, sources: { dingtalk: { enabled: true, config: { credentials: credentialsFile(), ...config } } } }))
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board)
  sources.register(dingtalkKind)
  const assessor: Assessor = { request: vi.fn(async () => {}) }
  const executor: Executor = { start: vi.fn(async () => {}), deliver: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources), assessor, executor,
    outbox: { send: () => {}, status: () => undefined, withdraw: () => {} } })
  const commands = new Commands(() => testDeployment(), {}, new AbortController().signal)
  const receive = vi.fn((trigger: Trigger) => { const result = engine.receive(trigger); engine.evaluateDue(); return result })
  const deps: SourceContextDeps = { store, engine, outbox: { send: () => {} }, commands, sources, deployment: testDeployment(),
    ready: Promise.resolve(), configured: () => true, receive }
  return { store, engine, sources, board, commands, receive, ctx: sourceContextOf(deps, dingtalkKind) }
}
class FakeSocket {
  static OPEN = 1
  static instances: FakeSocket[] = []
  readyState = 0
  private readonly listeners = new Map<string, ((event: never) => void)[]>()
  sent: string[] = []
  constructor(readonly url: string) {
    FakeSocket.instances.push(this)
    queueMicrotask(() => { this.readyState = FakeSocket.OPEN; this.emit('open', {} as never) })
  }
  addEventListener(type: string, listener: (event: never) => void): void {
    this.listeners.set(type, [...this.listeners.get(type) ?? [], listener])
  }
  emit(type: string, event: never): void { for (const listener of this.listeners.get(type) ?? []) listener(event) }
  send(data: string): void { this.sent.push(data) }
  close(): void { if (this.readyState === 3) return; this.readyState = 3; this.emit('close', {} as never) }
}
afterEach(() => { forgetDingtalkTokens(); vi.unstubAllGlobals(); vi.restoreAllMocks(); FakeSocket.instances = [] })

describe('dingtalk source', () => {
  it('translates group mentions and direct messages into Triggers keyed by message id', () => {
    const group = dingtalkTrigger(dingtalkMessage(payload()))!
    expect(group).toMatchObject({ id: key('dingtalk', 'msg-1'), source: 'dingtalk', threads: [{ source: 'dingtalk', id: 'cid-group' }],
      actor: { source: 'dingtalk', id: 'staff-1' }, human: true, addressed: 'mention', at: '2025-09-09T00:00:00.000Z', text: '请把标题改短',
      channel: { source: 'dingtalk', address: { conversationId: 'cid-group', conversationType: '2', staffId: 'staff-1', messageId: 'msg-1' } } })
    expect(dingtalkTrigger(dingtalkMessage(payload({ conversationType: '1', conversationId: 'cid-p2p' })))!.addressed).toBe('direct')
    expect(dingtalkTrigger(dingtalkMessage(payload({ msgtype: 'picture' })))).toBeUndefined()
  })
  it('stores a robot callback and acknowledges it with its own message id', async () => {
    const h = host()
    const frame: StreamFrame = { type: 'CALLBACK', headers: { topic: ROBOT_TOPIC, messageId: 'frame-1' }, data: JSON.stringify(payload()) }
    const sent: unknown[] = []
    expect(await handleDingtalkFrame(h.ctx, frame, value => sent.push(value))).toBe('none')
    expect(h.receive).toHaveBeenCalledTimes(1)
    expect(h.engine.candidate(key('dingtalk', 'msg-1'))?.strength).toBe('explicit')
    expect(sent[0]).toMatchObject({ code: 200, headers: { messageId: 'frame-1', contentType: 'application/json' } })
  })
  it('answers the Stream system frames and stops on disconnect', async () => {
    const h = host()
    const sent: unknown[] = []
    const ping: StreamFrame = { type: 'SYSTEM', headers: { topic: 'ping', messageId: 'f1' }, data: 'x' }
    expect(await handleDingtalkFrame(h.ctx, ping, value => sent.push(value))).toBe('none')
    expect(sent).toHaveLength(1)
    const disconnect: StreamFrame = { type: 'SYSTEM', headers: { topic: 'disconnect', messageId: 'f2' }, data: 'bye' }
    expect(await handleDingtalkFrame(h.ctx, disconnect, value => sent.push(value))).toBe('close')
    expect(sent).toHaveLength(2)
  })
  it('opens the gateway, receives a frame on the socket and closes cleanly', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ endpoint: 'wss://example.test/stream', ticket: 'ticket-1' }),
      { status: 200, headers: { 'content-type': 'application/json' } })))
    vi.stubGlobal('WebSocket', FakeSocket)
    const frames: StreamFrame[] = []
    const connection = await openDingtalkStream(credentials, { signal: new AbortController().signal, onFrame: frame => { frames.push(frame) } })
    const socket = FakeSocket.instances[0]!
    expect(socket.url).toBe('wss://example.test/stream?ticket=ticket-1')
    socket.emit('message', { data: JSON.stringify({ type: 'SYSTEM', headers: { topic: 'KEEPALIVE' } }) } as never)
    connection.send({ code: 200 })
    await vi.waitFor(() => expect(frames).toHaveLength(1))
    expect(JSON.parse(socket.sent[0]!)).toEqual({ code: 200 })
    connection.close()
    await connection.done
  })
  it('sends a group message and a direct message through the robot API, and treats a missing target as gone', async () => {
    const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    const posts: { url: string; body: Record<string, unknown>; token?: string }[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/oauth2/accessToken')) return answer({ accessToken: 'token-1', expireIn: 7200 })
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      const token = (init?.headers as Record<string, string> | undefined)?.['x-acs-dingtalk-access-token']
      posts.push({ url: String(url), body, ...token ? { token } : {} })
      if (String(url).includes('oToMessages')) return answer({ code: 'invalidUser', message: 'user not found' }, 400)
      return answer({ processQueryKey: 'query-1' })
    }))
    const h = host()
    const outbound = (address: Record<string, string>): OutboundMessage => ({ id: `r-${address.conversationId}`, kind: 'reply', text: 'Done',
      channel: { source: 'dingtalk', thread: `dingtalk:${address.conversationId}`, address } })
    expect(await sendDingtalk({ commands: h.commands, config: { credentials: credentialsFile() } }, outbound({ conversationId: 'cid-group', conversationType: '2' })))
      .toEqual({ result: 'sent', externalId: 'query-1' })
    expect(posts[0]).toMatchObject({ url: 'https://api.dingtalk.com/v1.0/robot/groupMessages/send', token: 'token-1',
      body: { robotCode: 'ding-robot', openConversationId: 'cid-group', msgKey: 'sampleText', msgParam: JSON.stringify({ content: 'Done' }) } })
    expect(await sendDingtalk({ commands: h.commands, config: { credentials: credentialsFile() } }, outbound({ conversationId: 'cid-p2p', conversationType: '1', staffId: 'staff-1' })))
      .toEqual({ result: 'gone' })
    expect(posts[1]!.body).toMatchObject({ robotCode: 'ding-robot', userIds: ['staff-1'] })
  })
  it('gates the group and direct scopes, and pauses until setup finishes', async () => {
    const h = host()
    const trigger = dingtalkTrigger(dingtalkMessage(payload()))!
    expect(dingtalkKind.scope!({ meta: trigger.meta }, { credentials: '' })).toEqual({ listened: true, observed: false, row: 'group' })
    const thread = { key: 'dingtalk:cid-group', ref: { source: 'dingtalk', id: 'cid-group' }, createdAt: '', subscriptions: [],
      correlated: [], pending: [], meta: {} } as Thread
    expect(settingsPolicy(h.store.settings(), h.sources).gate(trigger, thread, [])).toMatchObject({ admissible: true, strength: 'explicit' })
    expect(settingsPolicy(h.store.settings(), h.sources).gate({ ...trigger, actor: { source: 'dingtalk', id: 'guest' } }, thread, []))
      .toMatchObject({ admissible: false, reason: 'not_a_member' })
    const controller = new AbortController()
    const ctx = sourceContextOf({ store: h.store, engine: h.engine, outbox: { send: () => {} }, commands: h.commands, sources: h.sources,
      deployment: testDeployment(), ready: Promise.resolve(), configured: () => false, receive: h.receive }, dingtalkKind)
    await watchDingtalk(ctx, controller.signal)
    expect(h.board.all.dingtalk).toMatchObject({ state: 'paused', code: 'setupPending' })
  })
})
