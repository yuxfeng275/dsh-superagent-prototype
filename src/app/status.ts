/**
 * Read-only status surface for desktop and phone: the standalone app served under `/status`, its authenticated
 * `/status/api` data routes, and the loopback-only pairing routes the Host owner uses to authorize a device.
 *
 * The surface is read-only by construction: the data routes only answer `GET` with the existing view functions, so a
 * paired device can never reach a management write route. Management remains loopback-only under `/orchestrator`.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { policyVersion } from '../policy.ts'
import { iconPng, manifestJson, SERVICE_WORKER, shellHtml } from '../status/shell.ts'
import { cookieName, Devices, type DeviceSession } from './devices.ts'
import type { HttpHost } from './http.ts'
import { overview } from './views/overview.ts'
import { sourcesStatus, type SetupState } from './views/sources.ts'
import { decisionList } from './views/threads.ts'
import { executorLoad, ticketDetail, ticketList } from './views/tickets.ts'

const TICKET_STAGES = ['open', 'person', 'working', 'idle', 'ended'] as const
const statusCookie = cookieName
const MAX_BODY = 4096

interface StatusContext {
  /** The Host owner's own browser on this machine; it needs no pairing. */
  local: boolean
  /** True when the request reached us over TLS, directly or through the proxy named by `status.publicUrl`. */
  secure: boolean
  host: string
  ip: string
}
type Gate = { ok: true; context: StatusContext } | { ok: false; status: 401 | 403; code: string; message: string }
type Access = { ok: true; context: StatusContext; device?: DeviceSession } | { ok: false; status: 401 | 403; code: string; message: string }

function head(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  return Array.isArray(value) ? value[0] : value
}
const forwarded = (req: IncomingMessage): boolean =>
  !!(head(req, 'x-forwarded-for') || head(req, 'x-forwarded-host') || head(req, 'x-forwarded-proto') || head(req, 'x-real-ip') || head(req, 'forwarded'))
function authority(value: string): { hostname: string; port: string } | undefined {
  try {
    const url = new URL(`http://${value}`)
    if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) return undefined
    return { hostname: url.hostname.toLowerCase(), port: url.port }
  } catch { return undefined }
}
const loopbackHosts = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])
/** IP rate-limit key: the proxy-reported client when the proxy is trusted, otherwise the socket's peer. */
function clientIp(req: IncomingMessage): string {
  const first = head(req, 'x-forwarded-for')?.split(',')[0]?.trim()
  return first || req.socket?.remoteAddress || 'unknown'
}
function gate(req: IncomingMessage, host: HttpHost, protocol: 'http:' | 'https:'): Gate {
  const parsed = authority(head(req, 'host') ?? '')
  if (!parsed) return { ok: false, status: 403, code: 'untrustedHost', message: 'The request Host is not an authority this status surface serves' }
  // A loopback Host is not enough: a LAN client can spoof it on a socket that arrived on another interface, and a proxy
  // on this machine forwards remote requests with forwarding headers. Only a loopback destination without a proxy is local.
  const destination = req.socket?.localAddress
  const loopbackDestination = destination === undefined || destination === '::1' || destination === '::ffff:127.0.0.1'
    || destination.startsWith('127.')
  const local = loopbackHosts.has(parsed.hostname) && !forwarded(req) && loopbackDestination
  const secure = protocol === 'https:' || head(req, 'x-forwarded-proto')?.split(',')[0]?.trim() === 'https'
  const context: StatusContext = { local, secure, host: parsed.hostname, ip: clientIp(req) }
  if (local) return { ok: true, context }
  const publicUrl = host.machine.status.publicUrl
  if (!publicUrl) return { ok: false, status: 403, code: 'remoteDisabled', message: 'Remote access is off; configure status.publicUrl to pair a phone' }
  const allowed = new URL(publicUrl)
  if (allowed.hostname.toLowerCase() !== parsed.hostname || (allowed.port || '') !== parsed.port)
    return { ok: false, status: 403, code: 'untrustedHost', message: 'The request Host is not status.publicUrl' }
  if (!secure) return { ok: false, status: 403, code: 'httpsRequired', message: 'Remote access requires HTTPS; set up a TLS tunnel and reach it through status.publicUrl' }
  return { ok: true, context }
}
function access(req: IncomingMessage, devices: Devices, host: HttpHost, protocol: 'http:' | 'https:'): Access {
  const checked = gate(req, host, protocol)
  if (!checked.ok) return checked
  if (checked.context.local) return { ok: true, context: checked.context }
  const device = devices.authorize(head(req, 'cookie')?.split(';').map(part => part.trim())
    .find(part => part.startsWith(`${statusCookie}=`))?.slice(statusCookie.length + 1))
  if (!device) return { ok: false, status: 401, code: 'unpaired', message: 'Pair this device from the Host machine first' }
  return { ok: true, context: checked.context, device }
}
function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', ...headers })
  res.end(JSON.stringify(body))
}
function text(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', ...headers })
  res.end(body)
}
async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk)
    size += bytes.length
    if (size > MAX_BODY) throw new Error('Request is too large')
    chunks.push(bytes)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown } catch { throw new Error('The request body is not JSON') }
}
function views(runtime: HttpHost) {
  return { store: runtime.store, sources: runtime.sources, links: runtime.links() }
}
function setupState(runtime: HttpHost): SetupState {
  return { deployment: runtime.configured() ? runtime.deployment : undefined, problem: runtime.setupProblem, feishuProblem: runtime.feishuProblem }
}
/**
 * The phone's first screen: instance identity, health, pause state, the overview's person/problems/executor/flow, and
 * trimmed source health. `asOf` lets the app label a cached snapshot instead of pretending it is live.
 */
export function statusSummary(runtime: HttpHost) {
  const host = views(runtime)
  const shown = overview(host, runtime.health, policyVersion(runtime.store.settings()),
    executorLoad(runtime.store, runtime.executor.activeCount()), runtime.setupProblem ?? runtime.feishuProblem)
  return { apiVersion: 1, asOf: new Date().toISOString(),
    instance: { id: runtime.machine.instanceId, label: runtime.configured() ? runtime.deployment.repository : runtime.machine.instanceId },
    paused: runtime.store.settings().paused,
    health: { state: shown.problems.length ? 'attention' as const : 'ok' as const, problems: shown.problems.length },
    overview: { ...shown, person: shown.person.map(trimRow) },
    // Trim the per-source filtered and dropped message previews: the first screen needs health and counts, not content.
    sources: sourcesStatus(host, runtime.health, setupState(runtime)).map(source =>
      ({ id: source.id, title: source.title, state: source.state, enabled: source.enabled, health: source.health, stats: source.stats })) }
}
export type StatusSummary = ReturnType<typeof statusSummary>
/** Drop the fields the mobile surface does not need and should not expose: the worker directory and Session id. */
function trimRow<T extends { directory?: string; sessionId?: string }>(row: T): Omit<T, 'directory' | 'sessionId'> {
  const { directory: _directory, sessionId: _sessionId, ...rest } = row
  return rest
}
/** One page of Tickets using the panel's own list view, so both surfaces word stages the same way. */
export function statusTickets(runtime: HttpHost, stage: typeof TICKET_STAGES[number], offset: number, limit: number) {
  const page = ticketList(views(runtime), stage, offset, limit)
  return { ...page, items: page.items.map(trimRow) }
}
export type StatusTickets = ReturnType<typeof statusTickets>
/** One Ticket's detail using the panel's own view; internal execution environment paths are not included. */
export function statusTicket(runtime: HttpHost, id: string) {
  const detail = ticketDetail(views(runtime), id)
  if (!detail) return undefined
  // `ref` is the worker Session id; a read-only client needs none of the three.
  return { ...trimRow(detail), assignments: detail.assignments.map(({ ref: _ref, ...assignment }) => assignment) }
}
export type StatusTicket = NonNullable<ReturnType<typeof statusTicket>>
/** Recent decisions, for the app's activity page. */
export function statusActivity(runtime: HttpHost, offset: number, limit: number) {
  return decisionList(views(runtime), [], offset, limit)
}
export type StatusActivity = ReturnType<typeof statusActivity>
/** The local setup view: configuration and paired devices. Never served to a remote device. */
function setupView(runtime: HttpHost, devices: Devices, origin: string) {
  const status = runtime.machine.status
  return { enabled: status.enabled, publicUrl: status.publicUrl, url: `${status.publicUrl || origin}/status/`,
    sessionTtlDays: status.sessionTtlDays, pairCodeTtlSeconds: status.pairCodeTtlSeconds, maxDevices: status.maxDevices,
    devices: devices.list() }
}
/** A short human label for the device being paired, from its User-Agent. */
export function deviceLabel(ua: string): string {
  const phone = /iPhone/i.test(ua) ? 'iPhone' : /iPad/i.test(ua) ? 'iPad' : /Android/i.test(ua) ? 'Android' : /Macintosh|Mac OS X/i.test(ua) ? 'Mac'
    : /Windows/i.test(ua) ? 'Windows' : /Linux/i.test(ua) ? 'Linux' : 'Browser'
  return `${phone} · ${new Date().toISOString().slice(0, 10)}`
}
const pngs = new Map<string, Buffer>()
function icon(name: string): Buffer | undefined {
  const size = name === 'icon-192.png' ? 192 : 512
  if (!name.startsWith('icon-')) return undefined
  const cacheKey = `${size}-${name.includes('maskable')}`
  let image = pngs.get(cacheKey)
  if (!image) pngs.set(cacheKey, image = iconPng(size, name.includes('maskable')))
  return image
}
let bundle: Promise<Buffer> | undefined
/** The built browser app next to the compiled entry; a source checkout that has not been built gets a 503. */
function appBundle(): Promise<Buffer> {
  bundle ??= readFile(fileURLToPath(new URL('./status-app.js', import.meta.url)))
    .catch((error: unknown) => { bundle = undefined; throw error })
  return bundle
}
const HTML_HEADERS = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" }

/**
 * Register the `/status` surface when `status.enabled` is on.
 * @returns a disposer that removes the route registration.
 */
export function registerStatus(ctx: Context, runtime: HttpHost): () => void {
  if (!runtime.machine.status.enabled) return () => {}
  const devices = new Devices({ store: runtime.store, status: runtime.machine.status })
  const dispose = ctx.webServer.register({ kind: 'prefix', path: '/status', handler: async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname
    const protocol = ctx.webServer.protocol ?? 'http:'
    const method = req.method ?? 'GET'
    if (path === '/status') {
      res.writeHead(308, { location: `/status/${url.search}`, 'cache-control': 'no-store' })
      res.end()
      return
    }
    if (path === '/status/app.js') {
      if (method !== 'GET' && method !== 'HEAD') { text(res, 405, 'Method not allowed'); return }
      try {
        const body = await appBundle()
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache',
          'x-content-type-options': 'nosniff' })
        res.end(method === 'HEAD' ? undefined : body)
      } catch {
        text(res, 503, 'The status app is not built; run the package build before serving /status')
      }
      return
    }
    if (path === '/status/manifest.webmanifest') {
      res.writeHead(200, { 'content-type': 'application/manifest+json; charset=utf-8', 'cache-control': 'no-cache' })
      res.end(manifestJson()); return
    }
    if (path === '/status/sw.js') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache',
        'service-worker-allowed': '/status/' })
      res.end(SERVICE_WORKER); return
    }
    if (/^\/status\/icon-(192|512)\.png$/.test(path) || path === '/status/icon-maskable-512.png') {
      const image = icon(path === '/status/icon-maskable-512.png' ? 'icon-maskable-512.png' : path.slice('/status/'.length))
      if (image) {
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' })
        res.end(image); return
      }
    }
    const origin = `${protocol}//${head(req, 'host') ?? ''}`
    if (path.startsWith('/status/api/')) { await api(req, res, runtime, devices, protocol, origin, path, method); return }
    if (method !== 'GET' && method !== 'HEAD') { text(res, 405, 'Method not allowed'); return }
    // The app is a single-page application: every non-API path serves the shell, including deep links.
    const language = /\bzh\b/i.test(head(req, 'accept-language') ?? '') ? 'zh' : 'en'
    res.writeHead(200, HTML_HEADERS)
    res.end(method === 'HEAD' ? undefined : shellHtml(language))
  } })
  return dispose
}

async function api(req: IncomingMessage, res: ServerResponse, runtime: HttpHost, devices: Devices,
  protocol: 'http:' | 'https:', origin: string, path: string, method: string): Promise<void> {
  const segments = path.slice('/status/api/'.length).split('/').filter(Boolean)
  const query = new URL(req.url ?? '/', 'http://localhost').searchParams
  const offset = Math.max(0, Number.parseInt(query.get('offset') ?? '', 10) || 0)
  const limit = Math.min(100, Math.max(1, Number.parseInt(query.get('limit') ?? '', 10) || 20))
  await runtime.ready
  if (method === 'POST' && path === '/status/api/pair') { await pair(req, res, runtime, devices, protocol); return }
  const checked = access(req, devices, runtime, protocol)
  if (!checked.ok) {
    res.writeHead(checked.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ error: checked.message, code: checked.code }))
    return
  }
  const local = checked.context.local
  // Only Tickets and devices have a second path segment; devices has one literal operation (`code`) and one id (revoke).
  const [first, second] = segments
  const operation = !first ? '' : first === 'devices' && second ? (method === 'POST' && second === 'code' ? 'devices/code' : 'devices/:id')
    : first === 'tickets' && second ? 'tickets/:id' : first
  const route = `${method} ${operation}`
  try {
    switch (route) {
      case 'GET summary': json(res, 200, statusSummary(runtime)); return
      case 'GET tickets': {
        const stage = TICKET_STAGES.includes((query.get('state') ?? 'open') as typeof TICKET_STAGES[number]) ? (query.get('state') ?? 'open') as typeof TICKET_STAGES[number] : 'open'
        json(res, 200, statusTickets(runtime, stage, offset, limit)); return
      }
      case 'GET tickets/:id': {
        const ticket = statusTicket(runtime, decodeURIComponent(segments[1]!))
        if (!ticket) { json(res, 404, { error: 'Ticket not found' }); return }
        json(res, 200, ticket); return
      }
      case 'GET activity': json(res, 200, statusActivity(runtime, offset, limit)); return
      case 'GET setup': {
        if (!local) { json(res, 403, { error: 'Pairing and device management happen on the Host machine', code: 'localOnly' }); return }
        json(res, 200, setupView(runtime, devices, origin)); return
      }
      case 'POST devices/code': {
        if (!local) { json(res, 403, { error: 'Pairing codes are generated on the Host machine', code: 'localOnly' }); return }
        if (!sameOriginRequest(req, protocol)) { json(res, 403, { error: 'Same-origin request required', code: 'sameOrigin' }); return }
        const pairing = devices.createCode()
        json(res, 200, { ...pairing, url: `${runtime.machine.status.publicUrl || origin}/status/pair` })
        return
      }
      case 'DELETE devices/:id': {
        if (!local) { json(res, 403, { error: 'Devices are revoked on the Host machine', code: 'localOnly' }); return }
        if (!sameOriginRequest(req, protocol)) { json(res, 403, { error: 'Same-origin request required', code: 'sameOrigin' }); return }
        const id = decodeURIComponent(segments[1]!)
        if (!devices.revoke(id)) { json(res, 404, { error: 'Device not found' }); return }
        json(res, 200, { revoked: true }); return
      }
      default: json(res, 404, { error: 'Unknown status operation' })
    }
  } catch (error) {
    json(res, 500, { error: error instanceof Error ? error.message : String(error) })
  }
}

/** Whether a state-changing request came from a page of this status origin rather than a cross-site form. */
function sameOriginRequest(req: IncomingMessage, protocol: 'http:' | 'https:'): boolean {
  if (head(req, 'x-status-request') !== '1') return false
  const origin = head(req, 'origin')
  if (!origin) return head(req, 'sec-fetch-site') === undefined || head(req, 'sec-fetch-site') === 'same-origin'
  const host = head(req, 'host')
  // The scheme a TLS-terminating proxy reports decides the browser's Origin; the local listener may speak plain HTTP.
  const scheme = head(req, 'x-forwarded-proto')?.split(',')[0]?.trim() === 'https' ? 'https' : protocol.replace(':', '')
  return !!host && origin === `${scheme}://${host}`
}

/** Redeem a pairing code for this browser; the only state-changing public route on the surface. */
async function pair(req: IncomingMessage, res: ServerResponse, runtime: HttpHost, devices: Devices,
  protocol: 'http:' | 'https:'): Promise<void> {
  const checked = gate(req, runtime, protocol)
  if (!checked.ok) { json(res, checked.status, { error: checked.message, code: checked.code }); return }
  if (!sameOriginRequest(req, protocol)) { json(res, 403, { error: 'Same-origin request required', code: 'sameOrigin' }); return }
  let code: string
  try {
    const body = z.object({ code: z.string().trim().min(1).max(200) }).parse(await readJson(req))
    code = body.code
  } catch (error) {
    json(res, 400, { error: error instanceof Error ? error.message : 'Pairing code required', code: 'invalidRequest' }); return
  }
  const ip = clientIp(req)
  if (!devices.allowAttempt(ip)) { json(res, 429, { error: 'Too many pairing attempts; wait a minute and retry', code: 'rateLimited' }); return }
  const result = devices.redeem(code, deviceLabel(head(req, 'user-agent') ?? ''), head(req, 'user-agent') ?? '')
  if ('failure' in result) {
    const status = result.failure === 'expired' ? 410 : result.failure === 'limit' ? 409 : 401
    json(res, status, { error: result.failure === 'expired' ? 'The pairing code has expired; generate a new one'
      : result.failure === 'limit' ? 'This Host has reached its device limit; revoke a device first' : 'The pairing code is not valid', code: result.failure })
    return
  }
  res.setHeader('set-cookie', devices.cookieHeader(result.cookie, checked.context.secure))
  json(res, 200, { paired: true, device: { id: result.device.id, label: result.device.label, expiresAt: result.device.expiresAt } })
}
