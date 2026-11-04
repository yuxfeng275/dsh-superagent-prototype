/** Placement: choose the worker environment an assignment should run on. */
import type { EdgeJobs } from './edge-jobs.ts'
import type { Environments, WorkerEnvironment } from './environments.ts'

/** What a placement must satisfy: a pin, capability requirements, and label selectors. */
export interface PlacementRequest {
  /** Restrict placement to this environment; when it cannot take the work, the request waits rather than falling back. */
  environmentId?: string
  /** Capabilities the environment must all announce. */
  capabilities?: readonly string[]
  /** Labels the environment must carry with the same values. */
  labels?: Readonly<Record<string, string>>
  /** An environment this ticket used before, preferred when everything else is equal. */
  previousEnvironmentId?: string
}
/** Why an assignment waits instead of being placed. */
export type PlacementWait = 'noEnvironment' | 'allOffline' | 'pinnedUnavailable' | 'capability' | 'label' | 'busy'
export type Placement = { kind: 'placed'; environment: WorkerEnvironment } | { kind: 'wait'; reason: PlacementWait }
/** Placement inputs for one environment at one moment. */
export interface Candidate { environment: WorkerEnvironment; active: number; available: number }

const holds = (environment: WorkerEnvironment, request: PlacementRequest): boolean =>
  (request.capabilities ?? []).every(capability => environment.capabilities.includes(capability))
const labelled = (environment: WorkerEnvironment, request: PlacementRequest): boolean =>
  Object.entries(request.labels ?? {}).every(([key, value]) => environment.labels[key] === value)
/** Sort key: affinity first, then free capacity (most free first), then freshness, then a stable id. */
function preference(request: PlacementRequest, now: string) {
  return (a: Candidate, b: Candidate): number => {
    const affinity = Number(b.environment.id === request.previousEnvironmentId) - Number(a.environment.id === request.previousEnvironmentId)
    if (affinity) return affinity
    const free = b.available - a.available
    if (free) return free
    const freshness = Date.parse(b.environment.lastSeenAt) - Date.parse(a.environment.lastSeenAt)
    if (freshness) return freshness
    return a.environment.id.localeCompare(b.environment.id)
  }
}

/**
 * The placement decision of the router: filter by hard requirements and online state, then prefer affinity, free
 * capacity and freshness. It reads the registry and the active jobs, so a ticket never exceeds an environment's capacity.
 * Reserving the chosen environment's slot is the caller's next step (the job queue counts offered and started jobs).
 */
export class Scheduler {
  constructor(private readonly environments: Environments, private readonly jobs: EdgeJobs) {}

  /** All environments that can take `request` now, best candidate first. */
  candidates(request: PlacementRequest, now: string): Candidate[] {
    return this.environments.online(now).flatMap(environment => {
      if (request.environmentId !== undefined && environment.id !== request.environmentId) return []
      if (!holds(environment, request) || !labelled(environment, request)) return []
      const active = this.jobs.activeCount(environment.id), available = environment.capacity - active
      return available > 0 ? [{ environment, active, available }] : []
    }).sort(preference(request, now))
  }

  /** Place `request`, or explain why it must wait. */
  place(request: PlacementRequest, now: string): Placement {
    const candidates = this.candidates(request, now)
    if (candidates.length) return { kind: 'placed', environment: candidates[0]!.environment }
    return { kind: 'wait', reason: this.why(request, now) }
  }

  /** Why no environment matched `request`; a pinned environment never falls back to another. */
  why(request: PlacementRequest, now: string): PlacementWait {
    const environments = request.environmentId === undefined
      ? this.environments.list()
      : this.environments.list().filter(environment => environment.id === request.environmentId)
    if (!environments.length) return request.environmentId === undefined ? 'noEnvironment' : 'pinnedUnavailable'
    if (request.environmentId !== undefined) return 'pinnedUnavailable'
    if (!environments.some(environment => this.environments.isOnline(environment, now))) return 'allOffline'
    const online = environments.filter(environment => this.environments.isOnline(environment, now))
    if (!online.some(environment => holds(environment, request))) return 'capability'
    if (!online.some(environment => labelled(environment, request))) return 'label'
    return 'busy'
  }
}
