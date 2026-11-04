/** HTTP protocol an edge worker host speaks to its router: register, heartbeat, claim jobs, report results. */
import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { z } from 'zod'
import { JobResultSchema, type WorkerJob } from './edge-jobs.ts'
import type { EdgeJobs } from './edge-jobs.ts'
import { EnvironmentRegistrationSchema } from './environments.ts'
import type { Environments } from './environments.ts'

/** How often a host should heartbeat, and how long a job poll may hang before answering 204. */
export const HEARTBEAT_INTERVAL_MS = 10_000
export const POLL_TIMEOUT_MS = 25_000
const MAX_BODY = 256 * 1024

export interface EdgeServerHost {
  readonly environments: Environments
  readonly jobs: EdgeJobs
  /** Bearer token every host must present. Empty disables the server. */
  readonly token: string
  readonly heartbeatIntervalMs?: number
  readonly pollTimeoutMs?: number
}
/** An edge request refused with an HTTP status, such as a bad body, a missing environment or a lost job. */
class EdgeError extends Error { constructor(readonly status: 400 | 401 | 404 | 409, message: string) { super(message) } }

async function body(req: IncomingMessage): Promise<unknown> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk); size += bytes.length
    if (size > MAX_BODY) throw new EdgeError(400, `Request exceeds ${MAX_BODY} bytes`)
    chunks.push(bytes)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }
  catch { throw new EdgeError(400, 'The request body is not JSON') }
}
function send(res: ServerResponse, status: number, value?: unknown): void {
  if (value === undefined) { res.writeHead(status); res.end(); return }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  res.end(JSON.stringify(value))
}
/** Compare bearer tokens without leaking a prefix through timing. */
function authorized(header: string | undefined, token: string): boolean {
  if (!token || !header?.startsWith('Bearer ')) return false
  const digest = (value: string): Buffer => createHash('sha256').update(value).digest()
  return timingSafeEqual(digest(header.slice('Bearer '.length)), digest(token))
}
const HeartbeatBody = z.object({ environment_id: z.string().min(1), state: z.enum(['online', 'draining']).optional() }).strict()
const PollBody = z.object({ environment_id: z.string().min(1) }).strict()
const JobBody = z.object({ environment_id: z.string().min(1) }).strict()
const FinishBody = z.object({ environment_id: z.string().min(1), result: JobResultSchema }).strict()
const FailBody = z.object({ environment_id: z.string().min(1), error: z.string().min(1).max(2_000) }).strict()
const ReconcileBody = z.object({ environment_id: z.string().min(1),
  jobs: z.array(z.object({ id: z.string().min(1), state: z.enum(['started', 'lost', 'finished']) }).strict()).max(200) }).strict()
const RegisterBody = EnvironmentRegistrationSchema

/**
 * The edge listener. It binds its own port (separately from the loopback-only management panel) so a worker host on another
 * machine can reach it, and it authenticates every request with a bearer token. It owns no scheduling policy: it records
 * hosts, hands out claimed jobs, and stores results.
 */
export class EdgeServer {
  private server?: Server
  private readonly waiters = new Set<() => void>()
  private readonly unsubscribe: () => void
  constructor(private readonly host: EdgeServerHost) {
    // A queued job wakes every hanging poll; the poll loop re-checks its own environment.
    this.unsubscribe = host.jobs.subscribe(() => { for (const wake of [...this.waiters]) wake() })
  }
  /** Listen on `host:port`; port 0 selects a free port. Returns the bound port. */
  async listen(host: string, port: number): Promise<number> {
    if (this.server) throw new Error('The edge server is already listening')
    this.server = createServer((req, res) => { void this.handle(req, res) })
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject)
      this.server!.listen(port, host, () => { this.server!.off('error', reject); resolve() })
    })
    const address = this.server.address()
    return typeof address === 'object' && address ? address.port : port
  }
  /** Stop accepting requests, release hanging polls, and close. */
  async close(): Promise<void> {
    this.unsubscribe()
    for (const wake of [...this.waiters]) wake()
    const server = this.server
    this.server = undefined
    if (!server) return
    await new Promise<void>(resolve => {
      server.close(() => resolve())
      // Fetch keeps connections alive; close them so a shutdown does not wait for the keep-alive timeout.
      server.closeAllConnections()
    })
  }
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (!authorized(req.headers.authorization, this.host.token)) throw new EdgeError(401, 'A valid edge token is required')
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (req.method !== 'POST') throw new EdgeError(404, 'Unknown edge operation')
      const path = url.pathname
      if (path === '/v1/edge/register') return send(res, 200, await this.register(await body(req)))
      if (path === '/v1/edge/heartbeat') return send(res, 200, await this.heartbeat(await body(req)))
      if (path === '/v1/edge/jobs:poll') return await this.poll(req, res)
      const match = /^\/v1\/edge\/jobs\/(job_[A-Za-z0-9_-]{1,64})\/(start|finish|fail)$/.exec(path)
      if (match) return send(res, 200, await this.settle(match[2] as 'start' | 'finish' | 'fail', match[1]!, await body(req)))
      if (path === '/v1/edge/reconcile') return send(res, 200, await this.reconcile(await body(req)))
      throw new EdgeError(404, 'Unknown edge operation')
    } catch (error) {
      if (error instanceof z.ZodError) send(res, 400, { error: error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ') })
      else if (error instanceof EdgeError) send(res, error.status, { error: error.message })
      else send(res, 500, { error: error instanceof Error ? error.message : String(error) })
    }
  }
  private async register(input: unknown) {
    const environment = this.host.environments.register(RegisterBody.parse(input), new Date().toISOString())
    return { environment, heartbeat_interval_ms: this.host.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS,
      poll_timeout_ms: this.host.pollTimeoutMs ?? POLL_TIMEOUT_MS }
  }
  private async heartbeat(input: unknown) {
    const parsed = HeartbeatBody.parse(input)
    const environment = this.host.environments.heartbeat(parsed.environment_id, new Date().toISOString(), parsed.state)
    if (!environment) throw new EdgeError(404, 'Unknown environment; register first')
    return { environment, desired_state: environment.state }
  }
  private async poll(req: IncomingMessage, res: ServerResponse) {
    const { environment_id: environmentId } = PollBody.parse(await body(req))
    if (!this.host.environments.get(environmentId)) throw new EdgeError(404, 'Unknown environment; register first')
    const deadline = Date.now() + (this.host.pollTimeoutMs ?? POLL_TIMEOUT_MS)
    for (;;) {
      const environment = this.host.environments.get(environmentId)
      if (!environment) throw new EdgeError(404, 'Unknown environment; register first')
      // A draining or revoked environment keeps its claimed jobs but receives no new ones.
      if (environment.state === 'online') {
        const job = this.host.jobs.claim(environmentId, new Date().toISOString())
        if (job) return send(res, 200, { job })
      }
      const left = deadline - Date.now()
      if (left <= 0) return send(res, 204)
      await this.wait(Math.min(left, 1_000))
    }
  }
  private async settle(action: 'start' | 'finish' | 'fail', id: string, input: unknown) {
    const now = new Date().toISOString()
    if (action === 'start') {
      const { environment_id: environmentId } = JobBody.parse(input)
      const job = this.host.jobs.start(environmentId, id, now)
      if (!job) throw new EdgeError(404, 'Job not found for this environment')
      return { job }
    }
    if (action === 'finish') {
      const parsed = FinishBody.parse(input)
      const job = this.host.jobs.finish(parsed.environment_id, id, parsed.result, now)
      if (!job) throw new EdgeError(404, 'Job not found for this environment')
      return { job }
    }
    const parsed = FailBody.parse(input)
    const job = this.host.jobs.fail(parsed.environment_id, id, parsed.error, now)
    if (!job) throw new EdgeError(404, 'Job not found for this environment')
    return { job }
  }
  private async reconcile(input: unknown) {
    const parsed = ReconcileBody.parse(input)
    if (!this.host.environments.get(parsed.environment_id)) throw new EdgeError(404, 'Unknown environment; register first')
    return { jobs: this.host.jobs.reconcile(parsed.environment_id, parsed.jobs, new Date().toISOString()) }
  }
  /** Wait for a queue change or `ms`, whichever comes first, after releasing the poll's waiter. */
  private wait(ms: number): Promise<void> {
    return new Promise(resolve => {
      const wake = () => { clearTimeout(timer); this.waiters.delete(wake); resolve() }
      const timer = setTimeout(wake, ms)
      this.waiters.add(wake)
    })
  }
}
export type { WorkerJob }
