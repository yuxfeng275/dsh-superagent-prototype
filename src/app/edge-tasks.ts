/** Router dispatch of agent tasks to worker environments, and the results it announces back to the main Session. */
import { key } from '../core/index.ts'
import type { EdgeJobs, WorkerJob } from './edge-jobs.ts'
import type { Environments, WorkerEnvironment } from './environments.ts'
import type { PlacementWait, Scheduler } from './scheduler.ts'

/** One task for a worker environment; `cwd` and `sessionId` let a later dispatch continue the same DSH Session. */
export interface EdgeTaskRequest {
  task: string
  /** Restrict the dispatch to this environment; a request that cannot run waits rather than falling back. */
  environmentId?: string
  /** The workspace on the worker, relative to its work root; defaults to a directory derived from the task. */
  cwd?: string
  /** Continue an earlier task's DSH Session; pass the same `cwd` the first dispatch used. */
  sessionId?: string
}
/** A dispatched task, or why no environment could take it now. */
export type EdgeTaskDispatch = { kind: 'dispatched'; jobId: string; environment: WorkerEnvironment } | { kind: 'waiting'; reason: PlacementWait }

/**
 * The router's side of edge tasks: place the task with the scheduler, queue it for the chosen host, and expose finished
 * results the runtime relays to the main Session. A task asks for the `dsh` capability because the host runs it with DSH.
 */
export class EdgeTasks {
  constructor(private readonly hosts: { environments: Pick<Environments, 'list'>; scheduler: Pick<Scheduler, 'place'>
    jobs: Pick<EdgeJobs, 'enqueue' | 'unannounced' | 'announce'> }) {}

  /** Place and queue one task; the host claims it on its next poll. */
  dispatch(request: EdgeTaskRequest, now: string): EdgeTaskDispatch {
    const task = request.task.trim()
    if (!task) throw new Error('A worker task cannot be empty')
    const placement = this.hosts.scheduler.place({ capabilities: ['dsh'],
      ...(request.environmentId ? { environmentId: request.environmentId } : {}) }, now)
    if (placement.kind === 'wait') return { kind: 'waiting', reason: placement.reason }
    const cwd = request.cwd?.trim() || `tasks/${key(task, now)}`
    const job = this.hosts.jobs.enqueue({ kind: 'task', environmentId: placement.environment.id,
      payload: { cwd, task, ...(request.sessionId ? { sessionId: request.sessionId } : {}) } }, now)
    return { kind: 'dispatched', jobId: job.id, environment: placement.environment }
  }

  /** Finished or failed tasks whose result the main Session has not received yet. */
  unannounced(): WorkerJob[] { return this.hosts.jobs.unannounced() }

  /** Mark a result relayed, so a restart does not repeat it. */
  announce(id: string, now: string): void { this.hosts.jobs.announce(id, now) }
}
