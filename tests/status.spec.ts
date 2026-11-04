import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Devices } from '../src/app/devices.ts'
import { registerStatus, statusSummary } from '../src/app/status.ts'
import type { HttpHost } from '../src/app/http.ts'
import { Store } from '../src/app/store.ts'
import type { DeviceSession } from '../src/app/devices.ts'
import type { StatusSettings } from '../src/deployment.ts'
import { testMachine } from './fixtures/deployment.ts'

/** Small key-value stand-in for the Store, enough for Devices. */
class MemoryStore {
  private readonly values = new Map<string, unknown>()
  get<V>(key: string): V | undefined { return this.values.get(key) as V | undefined }
  set<V>(key: string, value: V): void { this.values.set(key, structuredClone(value)) }
  delete(key: string): void { this.values.delete(key) }
  keys(prefix: string | { prefix: string }): string[] {
    const text = typeof prefix === 'string' ? prefix : prefix.prefix
    return [...this.values.keys()].filter(key => key.startsWith(text))
  }
}
const settings = (overrides: Partial<StatusSettings> = {}): StatusSettings =>
  ({ enabled: true, publicUrl: '', sessionTtlDays: 30, pairCodeTtlSeconds: 60, maxDevices: 5, ...overrides })
function devicesWith(overrides: Partial<StatusSettings> = {}) {
  let now = Date.parse('2026-01-01T00:00:00.000Z')
  const store = new MemoryStore()
  const devices = new Devices({ store: store as never, status: settings(overrides), now: () => now })
  return { store, devices, advance: (ms: number) => { now += ms } }
}
const cookieValue = (header: string): string => /^dsh_superagent_status=([^;]*)/.exec(header)![1]!

describe('read-only device sessions', () => {
  it('pairs with a one-time code and accepts only the signed cookie of a live device', () => {
    const { devices, advance } = devicesWith()
    const pairing = devices.createCode()
    expect(pairing.code).toMatch(/^[A-Z2-9]{8}$/)
    const paired = devices.redeem(pairing.code, 'iPhone', 'test-agent')
    expect('device' in paired).toBe(true)
    if (!('device' in paired)) return
    expect(devices.authorize(paired.cookie)?.id).toBe(paired.device.id)
    // The short code and the long token redeem the same record once; a second attempt fails.
    expect(devices.redeem(pairing.code, 'Again', 'test-agent')).toEqual({ failure: 'invalid' })
    expect(devices.redeem(pairing.token, 'Again', 'test-agent')).toEqual({ failure: 'invalid' })
    // A tampered value is rejected, and expiry both of the cookie and of the stored record ends access.
    expect(devices.authorize(`${paired.device.id}.9999999999999.${'x'.repeat(43)}`)).toBeUndefined()
    advance(31 * 86_400_000)
    expect(devices.authorize(paired.cookie)).toBeUndefined()
  })
  it('expires pairing codes, enforces the device limit and revokes devices', () => {
    const { devices, advance } = devicesWith({ maxDevices: 1 })
    const short = devices.createCode()
    advance(61_000)
    expect(devices.redeem(short.token, 'Late', 'ua')).toEqual({ failure: 'expired' })
    const first = devices.redeem(devices.createCode().token, 'First', 'ua')
    expect('device' in first).toBe(true)
    if (!('device' in first)) return
    expect(devices.redeem(devices.createCode().code, 'Second', 'ua')).toEqual({ failure: 'limit' })
    expect(devices.list()).toHaveLength(1)
    expect(devices.revoke(first.device.id)).toBe(true)
    expect(devices.authorize(first.cookie)).toBeUndefined()
    expect(devices.revoke(first.device.id)).toBe(false)
    expect(devices.list()).toEqual([])
  })
  it('rate-limits pairing attempts per key', () => {
    const { devices } = devicesWith()
    for (let index = 0; index < 5; index++) expect(devices.allowAttempt('1.2.3.4')).toBe(true)
    expect(devices.allowAttempt('1.2.3.4')).toBe(false)
    expect(devices.allowAttempt('5.6.7.8')).toBe(true)
  })
})

interface Handler { (req: unknown, res: unknown): Promise<void> }
function runtimeFor(store: Store, status: StatusSettings) {
  return {
    store, sources: { instances: () => [], kind: () => undefined }, links: () => () => ({ url: '', label: { zh: '', en: '' } }),
    health: {}, executor: { activeCount: () => 0 },
    machine: testMachine({ status }), configured: () => false, setupProblem: undefined, feishuProblem: undefined,
    ready: Promise.resolve(), deployment: undefined,
  } as unknown as HttpHost
}
function serve(runtime: HttpHost) {
  let handler: Handler = async () => {}
  let registered = 0
  const ctx = { webServer: { host: '127.0.0.1', port: 3082, protocol: 'http:', register: (route: { handler: Handler }) => {
    registered += 1; handler = route.handler; return () => {}
  } } }
  registerStatus(ctx as never, runtime)
  const call = async (method: string, path: string, options: { headers?: Record<string, string>; body?: string; localAddress?: string } = {}) => {
    let status = 0, text = '', raw: Uint8Array = new Uint8Array(), responseHeaders: Record<string, string> = {}
    const headers = { host: '127.0.0.1:3082', 'x-status-request': '1', ...options.headers }
    const req = { method, url: path, headers, socket: { remoteAddress: '127.0.0.1', localAddress: options.localAddress ?? '127.0.0.1' },
      async *[Symbol.asyncIterator]() { if (options.body) yield Buffer.from(options.body) } }
    await handler(req, { writeHead: (code: number, extra: Record<string, string>) => { status = code; responseHeaders = { ...responseHeaders, ...extra } },
      setHeader: (name: string, value: string) => { responseHeaders[name.toLowerCase()] = value },
      end: (data?: string | Buffer) => { text = String(data ?? ''); raw = Buffer.isBuffer(data) ? data : Buffer.from(text) } })
    return { status, text, raw, headers: responseHeaders, body: (() => { try { return JSON.parse(text) as Record<string, unknown> } catch { return {} } })() }
  }
  return { call, registered: () => registered }
}
let directory: string
let store: Store
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'status-spec-')); store = new Store(join(directory, 'orchestrator.sqlite')) })
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })

const remote = { host: 'agent.example', 'x-forwarded-proto': 'https', origin: 'https://agent.example' }
const local = { origin: 'http://127.0.0.1:3082' }

describe('status surface routes', () => {
  it('serves the shell, manifest and icon publicly, and never registers when disabled', async () => {
    const disabled = serve(runtimeFor(store, settings({ enabled: false })))
    expect(disabled.registered()).toBe(0)
    const { call } = serve(runtimeFor(store, settings({ enabled: true })))
    expect(await call('GET', '/status')).toMatchObject({ status: 308, headers: { location: '/status/' } })
    const shell = await call('GET', '/status/tickets/t1')
    expect(shell.status).toBe(200)
    expect(shell.text).toContain('/status/manifest.webmanifest')
    expect(shell.text).toContain('<script type="module" src="/status/app.js">')
    expect(shell.headers['content-security-policy']).toContain("default-src 'self'")
    const manifest = await call('GET', '/status/manifest.webmanifest')
    expect(manifest.status).toBe(200)
    expect(JSON.parse(manifest.text)).toMatchObject({ start_url: '/status/', scope: '/status/', display: 'standalone' })
    const icon = await call('GET', '/status/icon-192.png')
    expect(icon.status).toBe(200)
    expect(icon.headers['content-type']).toBe('image/png')
    expect([...icon.raw.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47])
  })
  it('answers summary only on loopback, or through status.publicUrl over HTTPS with a paired cookie', async () => {
    const { call } = serve(runtimeFor(store, settings({ publicUrl: 'https://agent.example' })))
    const localSummary = await call('GET', '/status/api/summary')
    expect(localSummary.status).toBe(200)
    expect(localSummary.body).toMatchObject({ apiVersion: 1, instance: { id: 'test-instance' },
      health: { state: 'attention', problems: 2 }, paused: false })
    expect(localSummary.body.asOf).toMatch(/Z$/)
    // Loopback-only when no public URL is configured.
    const noPublic = serve(runtimeFor(store, settings()))
    expect((await noPublic.call('GET', '/status/api/summary', { headers: remote })).status).toBe(403)
    // The configured public host must match, and remote plain HTTP is refused.
    expect((await call('GET', '/status/api/summary', { headers: { ...remote, host: 'evil.example' } })).status).toBe(403)
    expect((await call('GET', '/status/api/summary', { headers: { host: 'agent.example' } })).status).toBe(403)
    // A proxy that forwards to loopback is remote, not local: its Host must match status.publicUrl.
    expect((await call('GET', '/status/api/summary', { headers: { host: '127.0.0.1:3082', 'x-forwarded-proto': 'https' } })).status).toBe(403)
    // A loopback Host spoofed over a socket that arrived on another interface is not local.
    expect((await call('GET', '/status/api/summary', { localAddress: '192.168.1.5' })).status).toBe(403)
    expect((await call('GET', '/status/api/summary', { headers: remote })).status).toBe(401)
  })
  it('pairs from a locally generated code, serves the device read-only, and answers 401 after revocation', async () => {
    const { call } = serve(runtimeFor(store, settings({ publicUrl: 'https://agent.example' })))
    // Only the Host machine generates codes; a device can never manage pairing.
    expect((await call('POST', '/status/api/devices/code', { headers: remote })).status).toBe(401)
    expect((await call('GET', '/status/api/setup', { headers: remote })).status).toBe(401)
    const created = await call('POST', '/status/api/devices/code', { headers: local })
    expect(created.status).toBe(200)
    const code = String(created.body.code)
    const setup = await call('GET', '/status/api/setup', { headers: local })
    expect(setup.body).toMatchObject({ enabled: true, publicUrl: 'https://agent.example', devices: [] })
    // An invalid code costs one attempt and creates nothing; the next valid code pairs exactly one device.
    expect((await call('POST', '/status/api/pair', { headers: remote, body: JSON.stringify({ code: 'NOPE' }) })).status).toBe(401)
    const next = await call('POST', '/status/api/devices/code', { headers: local })
    const cookie = (await call('POST', '/status/api/pair', { headers: { ...remote, 'user-agent': 'Mozilla/5.0 (iPhone)' },
      body: JSON.stringify({ code: String(next.body.code) }) })).headers['set-cookie']!
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('Secure')
    expect(cookie).toContain('SameSite=Strict')
    const deviceCookie = cookieValue(cookie)
    const summary = await call('GET', '/status/api/summary', { headers: { ...remote, cookie: `dsh_superagent_status=${deviceCookie}` } })
    expect(summary.status).toBe(200)
    // A paired device still cannot reach management-only routes, and the surface has no write route at all.
    expect((await call('POST', '/status/api/devices/code', { headers: { ...remote, cookie: `dsh_superagent_status=${deviceCookie}` } })).status).toBe(403)
    expect((await call('POST', '/status/api/tickets/t1/stop', { headers: { ...remote, cookie: `dsh_superagent_status=${deviceCookie}` } })).status).toBe(404)
    const devices = (await call('GET', '/status/api/setup', { headers: local })).body.devices as DeviceSession[]
    expect(devices).toHaveLength(1)
    expect((await call('DELETE', `/status/api/devices/${devices[0]!.id}`, { headers: local })).status).toBe(200)
    expect((await call('GET', '/status/api/summary', { headers: { ...remote, cookie: `dsh_superagent_status=${deviceCookie}` } })).status).toBe(401)
  })
  it('requires a same-origin, marked request to pair and rejects expired or unknown codes', async () => {
    const { call } = serve(runtimeFor(store, settings({ publicUrl: 'https://agent.example' })))
    const created = await call('POST', '/status/api/devices/code', { headers: local })
    expect((await call('POST', '/status/api/pair', { headers: { ...remote, 'x-status-request': undefined as never,
      origin: 'https://evil.example' }, body: JSON.stringify({ code: String(created.body.code) }) })).status).toBe(403)
    expect((await call('POST', '/status/api/pair', { headers: { ...remote, 'x-status-request': undefined as never },
      body: JSON.stringify({ code: String(created.body.code) }) })).status).toBe(403)
    expect((await call('POST', '/status/api/pair', { headers: { ...remote, origin: 'https://evil.example' },
      body: JSON.stringify({ code: String(created.body.code) }) })).status).toBe(403)
    expect((await call('POST', '/status/api/pair', { headers: remote, body: 'not json' })).status).toBe(400)
    expect((await call('POST', '/status/api/pair', { headers: remote, body: JSON.stringify({ code: 'AAAAAAAA' }) })).status).toBe(401)
  })
  it('composes the phone summary from the same views as the panel', () => {
    const summary = statusSummary(runtimeFor(store, settings()))
    expect(summary).toMatchObject({ apiVersion: 1, paused: false, health: { state: 'attention' }, sources: [],
      overview: { person: [], executor: { running: 0, queued: 0 }, policyVersion: expect.any(String) } })
    // With no Source and no allowed sender the overview reports both, and the summary keeps its problem count.
    expect(summary.overview.problems.map(problem => problem.kind)).toEqual(expect.arrayContaining(['no-source', 'no-allowed']))
    expect(summary.health.problems).toBe(summary.overview.problems.length)
    expect(summary.instance.label).toBe('test-instance')
  })
})
