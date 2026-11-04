import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { EdgeJobs } from '../src/app/edge-jobs.ts'
import { EdgeTasks } from '../src/app/edge-tasks.ts'
import { Environments } from '../src/app/environments.ts'
import { Scheduler } from '../src/app/scheduler.ts'
import { Store } from '../src/app/store.ts'

let directory: string
let store: Store
let environments: Environments
let jobs: EdgeJobs
let tasks: EdgeTasks
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'edge-tasks-'))
  store = new Store(join(directory, 'orchestrator.sqlite'))
  environments = new Environments(store)
  jobs = new EdgeJobs(store)
  tasks = new EdgeTasks({ environments, scheduler: new Scheduler(environments, jobs), jobs })
})
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })

const now = '2026-11-04T00:00:00.000Z'
const setup = (name = 'mac', overrides: Parameters<Environments['register']>[0] = { name: 'mac' }) =>
  environments.register({ capabilities: ['dsh'], ...overrides, name }, now)
const settle = (jobId: string) => {
  const claimed = jobs.claim(jobs.get(jobId)!.environmentId, now)!
  jobs.start(claimed.environmentId, claimed.id, now)
  jobs.finish(claimed.environmentId, claimed.id, { exitCode: 0, output: 'done', sessionId: 'sess-1' }, now)
}

it('queues a task on a matching environment and exposes its finished result once', () => {
  const environment = setup()
  const dispatched = tasks.dispatch({ task: 'Run the tests.' }, now)
  expect(dispatched).toMatchObject({ kind: 'dispatched', environment: { id: environment.id } })
  if (dispatched.kind !== 'dispatched') throw new Error('not dispatched')
  const job = jobs.get(dispatched.jobId)!
  expect(job).toMatchObject({ kind: 'task', state: 'queued', environmentId: environment.id, announcedAt: null })
  expect(job.payload).toMatchObject({ task: 'Run the tests.', command: '' })
  expect(job.payload.cwd).toMatch(/^tasks\//)
  settle(dispatched.jobId)
  expect(tasks.unannounced()).toEqual([expect.objectContaining({ id: dispatched.jobId, state: 'finished',
    result: { exitCode: 0, output: 'done', sessionId: 'sess-1' } })])
  tasks.announce(dispatched.jobId, now)
  expect(tasks.unannounced()).toEqual([])
})

it('waits with the scheduler reason when no environment can take the task', () => {
  expect(tasks.dispatch({ task: 'Run.' }, now)).toEqual({ kind: 'waiting', reason: 'noEnvironment' })
  // A host without the DSH capability cannot run agent tasks.
  setup('plain', { name: 'plain', capabilities: [] })
  expect(tasks.dispatch({ task: 'Run.' }, now)).toEqual({ kind: 'waiting', reason: 'capability' })
})

it('never falls back from an explicitly requested environment', () => {
  setup('a')
  const b = setup('b')
  expect(tasks.dispatch({ task: 'Run.', environmentId: 'env_missing' }, now)).toEqual({ kind: 'waiting', reason: 'pinnedUnavailable' })
  expect(tasks.dispatch({ task: 'Run.', environmentId: b.id }, now)).toMatchObject({ kind: 'dispatched',
    environment: { id: b.id } })
})

it('honours capacity and the same workspace and session across a follow-up', () => {
  const environment = setup('only', { name: 'only', capacity: 1 })
  const first = tasks.dispatch({ task: 'First.', cwd: 'task-one' }, now)
  expect(first.kind).toBe('dispatched')
  expect(tasks.dispatch({ task: 'Second.' }, now)).toEqual({ kind: 'waiting', reason: 'busy' })
  settle((first as { jobId: string }).jobId)
  const follow = tasks.dispatch({ task: 'Continue.', cwd: 'task-one', sessionId: 'sess-1' }, now)
  expect(follow).toMatchObject({ kind: 'dispatched', environment: { id: environment.id } })
  const job = jobs.get((follow as { jobId: string }).jobId)!
  expect(job.payload).toMatchObject({ cwd: 'task-one', sessionId: 'sess-1', task: 'Continue.' })
})
