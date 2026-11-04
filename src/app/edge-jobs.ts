/** Durable jobs an edge worker host claims, runs, and reports on. */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Store } from './store.ts'

/** The work a job carries: a command for a ticket workspace, or one agent task for the router. */
export const JobPayloadSchema = z.object({
  /** Working directory on the worker environment; the host keeps it under its work root. */
  cwd: z.string().min(1),
  /** `prepare`: the command for the host's shell; empty means the directory is created and nothing runs. */
  command: z.string().max(20_000).default(''),
  /** `task`: the prompt for one DSH agent run on the worker environment. */
  task: z.string().max(100_000).optional(),
  /** `task`: the DSH Session a run continues, when the router dispatches a follow-up. */
  sessionId: z.string().max(200).optional(),
  /** Extra environment variables; never platform credentials. */
  env: z.record(z.string(), z.string()).default({}),
}).strict()
export type JobPayload = z.infer<typeof JobPayloadSchema>
/** The payload a caller sends; omitted fields take the schema defaults. */
export type JobPayloadInput = z.input<typeof JobPayloadSchema>
/** The host's account of a finished job. */
export const JobResultSchema = z.object({ exitCode: z.number().int(), output: z.string().max(100_000), error: z.string().max(2_000).nullish(),
  sessionId: z.string().max(200).nullish(), /** A worker report a task wrote to `.dsh-report.json`, if any. */
  report: z.unknown().optional() }).strict()
export type JobResult = z.infer<typeof JobResultSchema>
export const JobStateSchema = z.enum(['queued', 'offered', 'started', 'finished', 'failed', 'expired', 'lost'])
/** A job prepares a workspace (`prepare`) or runs one router-dispatched agent task (`task`). */
export const JobKindSchema = z.enum(['prepare', 'task'])
export type JobKind = z.infer<typeof JobKindSchema>
export type JobState = z.infer<typeof JobStateSchema>
/**
 * A workspace preparation job. It is the first edge job kind: an environment creates a ticket's checkout in its own
 * filesystem, so a later worker turn runs where the checkout is.
 */
export const WorkerJobSchema = z.object({
  id: z.string().regex(/^job_[A-Za-z0-9_-]{1,64}$/),
  kind: JobKindSchema,
  environmentId: z.string(),
  ticketId: z.string().nullish(),
  assignmentId: z.string().nullish(),
  payload: JobPayloadSchema,
  state: JobStateSchema,
  attempts: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
  expiresAt: z.string(),
  offeredAt: z.string().nullish(),
  leaseExpiresAt: z.string().nullish(),
  result: JobResultSchema.nullish(),
  /** When the runtime relayed a finished task result to the main Session; null for a job it has not announced. */
  announcedAt: z.string().nullish(),
}).strict()
export type WorkerJob = z.infer<typeof WorkerJobSchema>
export interface EnqueueJob { kind: JobKind; environmentId: string; ticketId?: string; assignmentId?: string; payload: JobPayloadInput; expiresAt?: string }
/** How long an offered job is reserved for the host that claimed it, and how many times it may be offered again after a lost host. */
export const JOB_LEASE_MS = 60_000
export const JOB_TTL_MS = 30 * 60_000
export const MAX_ATTEMPTS = 2

const jobId = (): string => `job_${randomUUID().replaceAll('-', '').slice(0, 20)}`

/**
 * The durable job queue shared by the router and every worker environment.
 * A queued job is claimed once (`queued` to `offered` with a lease), started by the host, and settled by its result; a host
 * that disappears leaves a lease that expires back into the queue at most `MAX_ATTEMPTS` times.
 */
export class EdgeJobs {
  private readonly listeners = new Set<() => void>()
  constructor(private readonly store: Pick<Store, 'db' | 'atomic'>) {}

  /** Queue a job. The caller reserves a slot in the environment; this does not check capacity. */
  enqueue(input: EnqueueJob, now: string): WorkerJob {
    const payload = JobPayloadSchema.parse(input.payload)
    if (input.kind === 'task' && !payload.task?.trim()) throw new Error('A task job needs a task')
    const job: WorkerJob = {
      id: jobId(),
      kind: input.kind,
      environmentId: input.environmentId,
      ticketId: input.ticketId ?? null,
      assignmentId: input.assignmentId ?? null,
      payload,
      state: 'queued',
      attempts: 0,
      createdAt: now,
      updatedAt: now,
      expiresAt: input.expiresAt ?? new Date(Date.parse(now) + JOB_TTL_MS).toISOString(),
      announcedAt: null,
    }
    this.save(job)
    this.changed()
    return job
  }

  /**
   * Claim the oldest queued job of `environmentId`, offering it for `JOB_LEASE_MS`; returns undefined when none waits.
   * Expired offers and deadlines are settled first, so a dead host never keeps work reserved.
   */
  claim(environmentId: string, now: string): WorkerJob | undefined {
    return this.store.atomic(() => {
      this.settle(now)
      const row = this.store.db.prepare("SELECT value FROM worker_job WHERE environment = ? AND state = 'queued' ORDER BY rowid LIMIT 1").get(environmentId)
      if (!row) return undefined
      const job = WorkerJobSchema.parse(JSON.parse(String(row.value)))
      const offered: WorkerJob = { ...job, state: 'offered', attempts: job.attempts + 1, offeredAt: now,
        leaseExpiresAt: new Date(Date.parse(now) + JOB_LEASE_MS).toISOString(), updatedAt: now }
      this.save(offered)
      return offered
    })
  }

  /** Mark an offered job as running on `environmentId`; idempotent for the same host. */
  start(environmentId: string, id: string, now: string): WorkerJob | undefined {
    return this.store.atomic(() => {
      const job = this.owned(environmentId, id)
      if (!job || job.state === 'started' || job.state === 'finished' || job.state === 'failed') return job
      if (job.state !== 'offered') return undefined
      const started: WorkerJob = { ...job, state: 'started', updatedAt: now, leaseExpiresAt: null }
      this.save(started)
      return started
    })
  }

  /** Settle a claimed job with the host's result. */
  finish(environmentId: string, id: string, result: JobResult, now: string): WorkerJob | undefined {
    return this.store.atomic(() => {
      const job = this.owned(environmentId, id)
      if (!job || job.state === 'finished') return job
      if (job.state !== 'offered' && job.state !== 'started') return undefined
      const finished: WorkerJob = { ...job, state: 'finished', result: JobResultSchema.parse(result), updatedAt: now, leaseExpiresAt: null }
      this.save(finished)
      this.changed()
      return finished
    })
  }

  /** Mark a job failed after the host rejected or could not run it. */
  fail(environmentId: string, id: string, error: string, now: string): WorkerJob | undefined {
    return this.store.atomic(() => {
      const job = this.owned(environmentId, id)
      if (!job || job.state === 'failed' || job.state === 'finished') return job
      const failed: WorkerJob = { ...job, state: 'failed', result: { exitCode: -1, output: '', error: error.slice(0, 2_000) }, updatedAt: now, leaseExpiresAt: null }
      this.save(failed)
      this.changed()
      return failed
    })
  }

  /**
   * Reconcile what a reconnecting host reports against the queue: a job it still runs stays started, one it lost returns to
   * the queue (or fails once its attempts are spent), and a finished one settles with the result the host sends separately.
   */
  reconcile(environmentId: string, reports: readonly { id: string; state: 'started' | 'lost' | 'finished' }[], now: string): WorkerJob[] {
    return this.store.atomic(() => reports.flatMap(report => {
      const job = this.owned(environmentId, report.id)
      if (!job) return []
      if (report.state === 'started') {
        if (job.state === 'started') return [job]
        const started: WorkerJob = { ...job, state: 'started', updatedAt: now, leaseExpiresAt: null }
        this.save(started)
        return [started]
      }
      if (report.state === 'finished') return [] // The result arrives through `finish`; a finished report without one is not trusted.
      if (job.state === 'finished' || job.state === 'failed' || job.state === 'expired') return [job]
      const retry: WorkerJob = job.attempts >= MAX_ATTEMPTS
        ? { ...job, state: 'failed', result: { exitCode: -1, output: '', error: 'The host lost the job after its attempts' }, updatedAt: now, leaseExpiresAt: null }
        : { ...job, state: 'queued', offeredAt: null, leaseExpiresAt: null, updatedAt: now }
      this.save(retry)
      this.changed()
      return [retry]
    }))
  }

  /** Record every stale offer and expired job; returns how many rows changed. */
  settle(now: string): number {
    let changed = 0
    for (const job of this.active()) {
      if (job.state === 'offered' && job.leaseExpiresAt && Date.parse(job.leaseExpiresAt) <= Date.parse(now)) {
        const retry: WorkerJob = job.attempts >= MAX_ATTEMPTS
          ? { ...job, state: 'failed', result: { exitCode: -1, output: '', error: 'The host did not claim the job in time' }, updatedAt: now, leaseExpiresAt: null }
          : { ...job, state: 'queued', offeredAt: null, leaseExpiresAt: null, updatedAt: now }
        this.save(retry); changed++
      } else if (Date.parse(job.expiresAt) <= Date.parse(now)) {
        this.save({ ...job, state: 'expired', updatedAt: now, leaseExpiresAt: null }); changed++
      }
    }
    if (changed) this.changed()
    return changed
  }

  /** Jobs queued for, offered to or started on an environment, which count against its capacity. */
  activeCount(environmentId: string): number {
    const row = this.store.db.prepare("SELECT COUNT(*) AS count FROM worker_job WHERE environment = ? AND state IN ('queued', 'offered', 'started')").get(environmentId)
    return Number(row?.count ?? 0)
  }

  get(id: string): WorkerJob | undefined {
    const row = this.store.db.prepare('SELECT value FROM worker_job WHERE id = ?').get(id)
    return row ? WorkerJobSchema.parse(JSON.parse(String(row.value))) : undefined
  }

  /** Finished, failed or expired task jobs the runtime has not yet relayed to the main Session. */
  unannounced(): WorkerJob[] {
    return this.store.db.prepare("SELECT value FROM worker_job WHERE state IN ('finished', 'failed', 'expired') AND value ->> '$.kind' = 'task' AND value ->> '$.announcedAt' IS NULL ORDER BY rowid")
      .all().map(row => WorkerJobSchema.parse(JSON.parse(String(row.value))))
  }

  /** Record that a finished task's result reached the main Session's queue. */
  announce(id: string, now: string): void {
    const job = this.get(id)
    if (job) this.save({ ...job, announcedAt: now })
  }

  /** Jobs newest first, optionally for one environment or ticket. */
  list(filter: { environmentId?: string; ticketId?: string; limit?: number } = {}): WorkerJob[] {
    const clauses: string[] = []
    const parameters: string[] = []
    if (filter.environmentId !== undefined) { clauses.push('environment = ?'); parameters.push(filter.environmentId) }
    if (filter.ticketId !== undefined) { clauses.push("value ->> '$.ticketId' = ?"); parameters.push(filter.ticketId) }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    return this.store.db.prepare(`SELECT value FROM worker_job ${where} ORDER BY rowid DESC LIMIT ?`)
      .all(...parameters, Math.min(filter.limit ?? 50, 200)).map(row => WorkerJobSchema.parse(JSON.parse(String(row.value))))
  }

  /** Subscribe to queue changes; returns a release function. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private active(): WorkerJob[] {
    return this.store.db.prepare("SELECT value FROM worker_job WHERE state IN ('queued', 'offered')").all()
      .map(row => WorkerJobSchema.parse(JSON.parse(String(row.value))))
  }
  private owned(environmentId: string, id: string): WorkerJob | undefined {
    const job = this.get(id)
    return job?.environmentId === environmentId ? job : undefined
  }
  private save(job: WorkerJob): void {
    this.store.db.prepare('INSERT INTO worker_job (id, value, environment, state, created) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET value=excluded.value, environment=excluded.environment, state=excluded.state, created=excluded.created')
      .run(job.id, JSON.stringify(job), job.environmentId, job.state, job.createdAt)
  }
  private changed(): void { for (const listener of this.listeners) listener() }
}
