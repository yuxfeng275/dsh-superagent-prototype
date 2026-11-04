/** Edge worker host: the process installed on a machine that claims and runs this instance's jobs. */
import { spawn } from 'node:child_process'
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import type { WorkerJob } from '../app/edge-jobs.ts'
import type { WorkerEnvironment } from '../app/environments.ts'

/** How a host runs one claimed job; the default runs its command or its agent task in the job's workspace. */
export type JobExecutor = (job: WorkerJob, signal: AbortSignal) => Promise<{ exitCode: number; output: string; error?: string; sessionId?: string }>
/** How a host reaches DSH for a task job. */
export interface DshOptions { command?: string; profile?: string; home?: string }
export interface WorkerHostOptions {
  /** Base URL of the router, such as `http://hub.example:3919`. */
  url: string
  /** Bearer token the router issued. */
  token: string
  /** Directory this host may create workspaces under; no job path may escape it. */
  workRoot: string
  name: string
  kind?: WorkerEnvironment['kind']
  labels?: Record<string, string>
  capabilities?: string[]
  capacity?: number
  version?: string
  heartbeatMs?: number
  pollMs?: number
  /** The DSH launcher for `task` jobs; defaults to `dsh --profile headless` with its home under the work root. */
  dsh?: DshOptions
  execute?: JobExecutor
  log?: (message: string) => void
}
/** How long one job may run before the host stops it. */
export const JOB_TIMEOUT_MS = 30 * 60_000
const MAX_OUTPUT = 100_000
const sleep = (ms: number, signal: AbortSignal): Promise<void> => new Promise(resolve => {
  const timer = setTimeout(done, ms)
  function done() { clearTimeout(timer); signal.removeEventListener('abort', done); resolve() }
  signal.addEventListener('abort', done, { once: true })
})
const now = (): string => new Date().toISOString()
const tail = (text: string): string => text.length <= MAX_OUTPUT ? text : text.slice(-MAX_OUTPUT)

/** Run a command with `sh` in `cwd`, collecting bounded output; a timeout or abort stops it. */
export async function runShell(command: string, cwd: string, env: Record<string, string>, signal: AbortSignal): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('sh', ['-c', command], { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    const collect = (chunks: Buffer[]): void => { output = tail(output + Buffer.concat(chunks).toString('utf8')) }
    child.stdout.on('data', bytes => collect([bytes]))
    child.stderr.on('data', bytes => collect([bytes]))
    const timer = setTimeout(() => child.kill('SIGTERM'), JOB_TIMEOUT_MS)
    const abort = (): void => { child.kill('SIGTERM') }
    signal.addEventListener('abort', abort, { once: true })
    child.on('error', error => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(error) })
    child.on('close', code => { clearTimeout(timer); signal.removeEventListener('abort', abort); resolvePromise({ exitCode: code ?? -1, output }) })
  })
}

/**
 * A worker host connects outward to the router, so it needs no public address of its own: it registers, heartbeats, and
 * long-polls for jobs, one claim at a time per announced slot. Every job's path is confined to `workRoot`, and a job it was
 * running when the process stopped is reported lost on the next start rather than silently replayed.
 */
export class WorkerHost {
  private readonly log: (message: string) => void
  private readonly execute: JobExecutor
  private readonly loops: AbortController[] = []
  private readonly stopping = new AbortController()
  private readonly readyDeferred = Promise.withResolvers<WorkerEnvironment>()
  private environmentId = ''
  private registration?: WorkerEnvironment
  private readonly running = new Set<string>()
  constructor(private readonly options: WorkerHostOptions) {
    // A host stopped before it registers rejects `ready`; a caller that never reads it must not see an unhandled rejection.
    this.readyDeferred.promise.catch(() => {})
    this.log = options.log ?? (() => {})
    this.execute = options.execute ?? ((job, signal) => runJob(job, options.workRoot, signal, options.dsh))
  }
  /** Register, reconcile what an earlier process left running, then heartbeat and poll until `signal` aborts. */
  async start(signal: AbortSignal): Promise<void> {
    const combined = AbortSignal.any([signal, this.stopping.signal])
    try {
      const state = await this.state()
      this.environmentId = state.id ?? ''
      this.running.clear()
      for (const id of state.running) this.running.add(id)
      await this.register(combined)
      this.readyDeferred.resolve(this.registration!)
      await this.reconcile(combined)
      void this.heartbeat(combined)
      for (let slot = 0; slot < (this.options.capacity ?? 1); slot++) {
        const controller = new AbortController()
        this.loops.push(controller)
        void this.loop(AbortSignal.any([combined, controller.signal]))
      }
    } catch (error) {
      // A stop during startup is not a registration failure a caller needs to see; a real one is.
      this.readyDeferred.reject(error)
      if (!combined.aborted) throw error
    }
    await new Promise<void>(resolvePromise => {
      // A stop may already have arrived while registration was under way.
      if (combined.aborted) resolvePromise()
      else combined.addEventListener('abort', () => resolvePromise(), { once: true })
    })
    for (const controller of this.loops) controller.abort()
    await this.persist()
  }
  /** Resolves once the host has registered its environment. */
  get ready(): Promise<WorkerEnvironment> { return this.readyDeferred.promise }
  /** Stop claiming and running jobs; a running job is reported lost for the next start to reconcile. */
  stop(): void { this.stopping.abort(); for (const controller of this.loops) controller.abort() }
  /** The registered environment, once `start` has registered it. */
  get environment(): WorkerEnvironment | undefined { return this.registration }

  private async register(signal: AbortSignal): Promise<void> {
    const state = await this.state()
    const response = await this.call('/v1/edge/register', { ...(state.id ? { id: state.id } : {}),
      name: this.options.name, kind: this.options.kind ?? 'byom', labels: this.options.labels ?? {},
      // A worker host runs agent tasks, so it announces that capability even when the operator lists none.
      capabilities: [...new Set([...(this.options.capabilities ?? []), 'dsh'])], capacity: this.options.capacity ?? 1,
      version: this.options.version ?? '' }, signal)
    if (!response.ok) throw new Error(`Worker host registration failed: ${await response.text()}`)
    const payload = await response.json() as { environment: WorkerEnvironment }
    this.registration = payload.environment
    this.environmentId = payload.environment.id
    await this.persist()
  }
  private async heartbeat(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const response = await this.call('/v1/edge/heartbeat', { environment_id: this.environmentId }, signal)
        if (response.status === 404) await this.register(signal)
      } catch (error) { if (!signal.aborted) this.log(`Heartbeat failed: ${message(error)}`) }
      await sleep(this.options.heartbeatMs ?? 10_000, signal).catch(() => {})
    }
  }
  private async loop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const response = await this.call('/v1/edge/jobs:poll', { environment_id: this.environmentId }, signal)
        if (response.status === 204) continue
        if (response.status === 404) { await this.register(signal); continue }
        if (!response.ok) throw new Error(`Job poll failed: ${await response.text()}`)
        const { job } = await response.json() as { job: WorkerJob }
        await this.run(job, signal)
      } catch (error) {
        if (signal.aborted) return
        this.log(`Job poll failed: ${message(error)}`)
        await sleep(2_000, signal).catch(() => {})
      }
    }
  }
  private async run(job: WorkerJob, signal: AbortSignal): Promise<void> {
    this.running.add(job.id); await this.persist()
    try {
      const started = await this.call(`/v1/edge/jobs/${job.id}/start`, { environment_id: this.environmentId }, signal)
      // A job that is no longer offered here, such as one another host took after a lease expired, must not run twice.
      if (!started.ok) { this.log(`Job ${job.id} is no longer offered; skipping it`); return }
      const result = await this.execute(job, signal)
      await this.call(`/v1/edge/jobs/${job.id}/finish`, { environment_id: this.environmentId, result }, signal)
      this.log(`Job ${job.id} finished with exit code ${result.exitCode}`)
    } catch (error) {
      this.log(`Job ${job.id} failed: ${message(error)}`)
      await this.call(`/v1/edge/jobs/${job.id}/fail`, { environment_id: this.environmentId, error: message(error) }, signal).catch(() => {})
    } finally {
      this.running.delete(job.id); await this.persist()
    }
  }
  private async reconcile(signal: AbortSignal): Promise<void> {
    if (!this.running.size) return
    const jobs = [...this.running].map(id => ({ id, state: 'lost' as const }))
    await this.call('/v1/edge/reconcile', { environment_id: this.environmentId, jobs }, signal)
    this.running.clear(); await this.persist()
  }
  private call(path: string, body: unknown, signal: AbortSignal): Promise<Response> {
    return fetch(new URL(path, this.options.url), { method: 'POST', signal,
      headers: { authorization: `Bearer ${this.options.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  }
  /** Environment id and the jobs this host was running, remembered so a restart keeps its identity and reports lost work. */
  private async state(): Promise<{ id?: string; running: string[] }> {
    const file = join(this.options.workRoot, 'worker-host.json')
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8')) as { id?: string; running?: string[] }
      return { ...(parsed.id ? { id: parsed.id } : {}), running: parsed.running ?? [] }
    } catch { return { running: [] } }
  }
  private async persist(): Promise<void> {
    const file = join(this.options.workRoot, 'worker-host.json')
    try {
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, JSON.stringify({ id: this.environmentId || undefined, running: [...this.running] }))
    } catch (error) {
      // A host whose work root disappeared cannot remember its identity; that is a log line, not a crashed loop.
      this.log(`Could not save the host state: ${message(error)}`)
    }
  }
}
const message = (error: unknown): string => error instanceof Error ? error.message : String(error)

/** Resolve a job's directory under `workRoot`, refusing an absolute path outside it. Exported for tests. */
export async function jobDirectory(job: WorkerJob, workRoot: string): Promise<string> {
  const root = await realpath(workRoot).catch(async () => { await mkdir(workRoot, { recursive: true }); return realpath(workRoot) })
  const directory = resolve(root, isAbsolute(job.payload.cwd) ? job.payload.cwd : join(root, job.payload.cwd))
  if (directory !== root && !directory.startsWith(root + sep)) throw new Error(`Job directory ${job.payload.cwd} is outside the work root ${root}`)
  await mkdir(directory, { recursive: true })
  return directory
}
/** Default job runner: create the directory, then run the job's command or its agent task there. */
export async function runJob(job: WorkerJob, workRoot: string, signal: AbortSignal, dsh?: DshOptions): Promise<{ exitCode: number; output: string; error?: string; sessionId?: string }> {
  const directory = await jobDirectory(job, workRoot)
  if (job.kind === 'task') {
    if (!job.payload.task?.trim()) throw new Error('The task job carries no task')
    return runDshTask(job.payload.task, directory, job.payload.sessionId, dsh, signal)
  }
  if (!job.payload.command.trim()) return { exitCode: 0, output: '' }
  return runShell(job.payload.command, directory, job.payload.env, signal)
}

/**
 * Run one DSH agent turn for a task job: the task goes to stdin, `--json` reports the session and the final answer, and a
 * follow-up job continues the same Session by id. The host's DSH home is under the work root, never the operator's.
 */
export async function runDshTask(task: string, cwd: string, sessionId: string | undefined, dsh: DshOptions | undefined,
  signal: AbortSignal): Promise<{ exitCode: number; output: string; error?: string; sessionId?: string }> {
  const args = ['--profile', dsh?.profile ?? 'headless', '--json', ...(sessionId ? ['--session-id', sessionId] : [])]
  const env = { ...process.env, DSH_HOME: dsh?.home ?? join(cwd, '.dsh') }
  return new Promise((resolvePromise, reject) => {
    const child = spawn(dsh?.command ?? 'dsh', args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
    let final = '', foundSession = sessionId, failure = '', stderr = '', buffer = ''
    const event = (line: string): void => {
      if (!line.trim()) return
      let value: { type?: string; text?: string; session_id?: string; message?: string }
      try { value = JSON.parse(line) as typeof value } catch { return }
      if (value.type === 'session' && value.session_id) foundSession = value.session_id
      else if (value.type === 'final' && typeof value.text === 'string') final = value.text
      else if (value.type === 'error' && value.message) failure = value.message
    }
    child.stdout.on('data', bytes => {
      buffer += bytes.toString('utf8')
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) event(line)
    })
    child.stderr.on('data', bytes => { stderr = tail(stderr + bytes.toString('utf8')) })
    child.stdin.end(task)
    const timer = setTimeout(() => child.kill('SIGTERM'), JOB_TIMEOUT_MS)
    const abort = (): void => { child.kill('SIGTERM') }
    signal.addEventListener('abort', abort, { once: true })
    child.on('error', error => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(error) })
    child.on('close', code => {
      clearTimeout(timer); signal.removeEventListener('abort', abort)
      if (buffer) event(buffer)
      const error = failure || (code ? stderr.trim() || `dsh exited with ${code}` : '')
      resolvePromise({ exitCode: code ?? -1, output: final, ...(foundSession ? { sessionId: foundSession } : {}),
        ...(error ? { error: error.slice(0, 2_000) } : {}) })
    })
  })
}
/** Remove a host's state file; a new identity is registered next time. */
export async function forgetHost(workRoot: string): Promise<void> { await rm(join(workRoot, 'worker-host.json'), { force: true }) }
export { now }
