/** Worker environments: the machines, sandboxes and shared hosts an instance may place work on. */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Store } from './store.ts'

/** Kinds of execution environment in the P2 edge model. */
export const EnvironmentKindSchema = z.enum(['byom', 'cloud-sandbox', 'shared-host', 'managed-runner'])
export type EnvironmentKind = z.infer<typeof EnvironmentKindSchema>
/** Lifecycle of an environment; only `online` accepts new work. */
export const EnvironmentStateSchema = z.enum(['online', 'draining', 'offline', 'revoked'])
export type EnvironmentState = z.infer<typeof EnvironmentStateSchema>
const NameSchema = z.string().trim().min(1).max(100)
const LabelValueSchema = z.string().trim().max(200)
const CapabilitySchema = z.string().trim().regex(/^[a-z][a-z0-9-]*$/).max(100)
/**
 * One registered environment. `labels` are operator-facing selectors (`os: darwin`, `team: ios`), `capabilities` the hard
 * requirements a placement may ask for, and `capacity` the number of jobs it runs at once.
 */
export const EnvironmentSchema = z.object({
  id: z.string().regex(/^env_[A-Za-z0-9_-]{1,64}$/),
  name: NameSchema,
  kind: EnvironmentKindSchema,
  labels: z.record(z.string(), LabelValueSchema),
  capabilities: z.array(CapabilitySchema).max(100),
  capacity: z.number().int().min(1).max(64),
  state: EnvironmentStateSchema,
  version: z.string().trim().max(100),
  registeredAt: z.string(),
  lastSeenAt: z.string(),
}).strict()
export type WorkerEnvironment = z.infer<typeof EnvironmentSchema>
/** What a worker host announces when it registers; an id keeps a host's identity across restarts. */
export const EnvironmentRegistrationSchema = z.object({
  id: z.string().regex(/^env_[A-Za-z0-9_-]{1,64}$/).optional(),
  name: NameSchema,
  kind: EnvironmentKindSchema.default('byom'),
  labels: z.record(z.string(), LabelValueSchema).default({}),
  capabilities: z.array(CapabilitySchema).max(100).default([]),
  capacity: z.number().int().min(1).max(64).default(1),
  version: z.string().trim().max(100).default(''),
}).strict()
export type EnvironmentRegistration = z.infer<typeof EnvironmentRegistrationSchema>
/** The registration a host sends; omitted fields take the schema defaults. */
export type EnvironmentRegistrationInput = z.input<typeof EnvironmentRegistrationSchema>

/** How long an environment stays contactable without a heartbeat; a host heartbeats more often than this. */
export const HEARTBEAT_TTL_MS = 30_000
const fresh = (environment: WorkerEnvironment, now: string): boolean =>
  environment.state === 'online' && Date.parse(now) - Date.parse(environment.lastSeenAt) <= HEARTBEAT_TTL_MS
const environmentId = (): string => `env_${randomUUID().replaceAll('-', '').slice(0, 20)}`

/**
 * The environment registry, stored beside the instance's other records.
 * A heartbeat older than `HEARTBEAT_TTL_MS` reads as offline without a write, so a crashed host needs no repair step; the
 * state is persisted only when an operator drains, revokes or removes an environment, or when `sweep` records a change.
 */
export class Environments {
  constructor(private readonly store: Pick<Store, 'db' | 'atomic'>) {}

  /** Register a host (or refresh the announcement of one that already registered) and mark it online. */
  register(input: EnvironmentRegistrationInput, now: string): WorkerEnvironment {
    const registration = EnvironmentRegistrationSchema.parse(input)
    return this.store.atomic(() => {
      const existing = registration.id ? this.get(registration.id) : undefined
      const environment: WorkerEnvironment = {
        id: existing?.id ?? registration.id ?? environmentId(),
        name: registration.name,
        kind: registration.kind,
        labels: registration.labels,
        capabilities: [...new Set(registration.capabilities)],
        capacity: registration.capacity,
        state: 'online',
        version: registration.version,
        registeredAt: existing?.registeredAt ?? now,
        lastSeenAt: now,
      }
      this.save(environment)
      return environment
    })
  }

  /** Record a heartbeat and return the stored environment and the state the host should honour. */
  heartbeat(id: string, now: string, state?: 'online' | 'draining'): WorkerEnvironment | undefined {
    return this.store.atomic(() => {
      const environment = this.get(id)
      if (!environment) return undefined
      // A revoked environment stays revoked: a host that lost its grant must not revive it by heartbeating.
      if (environment.state === 'revoked') {
        this.save({ ...environment, lastSeenAt: now })
        return environment
      }
      const next: WorkerEnvironment = { ...environment, lastSeenAt: now, state: state ?? (environment.state === 'draining' ? 'draining' : 'online') }
      this.save(next)
      return next
    })
  }

  /** Change an environment's operator state (`draining` stops new jobs; `revoked` stops all of them). */
  setState(id: string, state: EnvironmentState): WorkerEnvironment | undefined {
    return this.store.atomic(() => {
      const environment = this.get(id)
      if (!environment) return undefined
      const next = { ...environment, state }
      this.save(next)
      return next
    })
  }

  /** Remove an environment; jobs it already accepted are left to the job store. */
  remove(id: string): boolean {
    return Number(this.store.db.prepare('DELETE FROM environment WHERE id = ?').run(id).changes) > 0
  }

  get(id: string): WorkerEnvironment | undefined {
    const row = this.store.db.prepare('SELECT value FROM environment WHERE id = ?').get(id)
    return row ? EnvironmentSchema.parse(JSON.parse(String(row.value))) : undefined
  }

  /** Every registered environment, newest registration first. */
  list(): WorkerEnvironment[] {
    return this.store.db.prepare('SELECT value FROM environment ORDER BY rowid DESC').all()
      .map(row => EnvironmentSchema.parse(JSON.parse(String(row.value))))
  }

  /** Environments a job may be placed on now: online and heartbeating within the TTL. */
  online(now: string): WorkerEnvironment[] {
    return this.list().filter(environment => fresh(environment, now))
  }

  /** Whether `environment` is online and fresh at `now`. */
  isOnline(environment: WorkerEnvironment, now: string): boolean { return fresh(environment, now) }

  /** Record stale online or draining environments as offline; returns how many state changes were written. */
  sweep(now: string): number {
    return this.store.atomic(() => {
      let changed = 0
      for (const environment of this.list()) {
        if (environment.state === 'revoked' || environment.state === 'offline' || fresh(environment, now)) continue
        this.save({ ...environment, state: 'offline' })
        changed++
      }
      return changed
    })
  }

  private save(environment: WorkerEnvironment): void {
    this.store.db.prepare('INSERT INTO environment (id, value, state, last_seen) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET value=excluded.value, state=excluded.state, last_seen=excluded.last_seen')
      .run(environment.id, JSON.stringify(environment), environment.state, environment.lastSeenAt)
  }
}
