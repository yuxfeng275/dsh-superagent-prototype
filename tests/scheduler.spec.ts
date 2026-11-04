import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { EdgeJobs } from '../src/app/edge-jobs.ts'
import { Environments } from '../src/app/environments.ts'
import { Scheduler } from '../src/app/scheduler.ts'
import { Store } from '../src/app/store.ts'

let directory: string
let store: Store
let environments: Environments
let jobs: EdgeJobs
let scheduler: Scheduler
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'scheduler-'))
  store = new Store(join(directory, 'orchestrator.sqlite'))
  environments = new Environments(store)
  jobs = new EdgeJobs(store)
  scheduler = new Scheduler(environments, jobs)
})
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })

const now = '2026-11-04T00:00:00.000Z'
const later = '2026-11-04T00:01:00.000Z'
const worker = (name: string, overrides: Omit<Parameters<Environments['register']>[0], 'name'> = {}) => environments.register({ ...overrides, name }, now)
const fill = (id: string) => jobs.enqueue({ kind: 'prepare', environmentId: id, payload: { cwd: '/tmp/work', command: '' } }, now)

it('places work on an online environment and prefers the one the ticket used before', () => {
  const first = worker('a')
  const second = worker('b')
  expect(scheduler.place({}, now)).toMatchObject({ kind: 'placed' })
  expect(scheduler.place({ previousEnvironmentId: second.id }, now)).toMatchObject({ kind: 'placed',
    environment: { id: second.id } })
  expect(scheduler.place({ previousEnvironmentId: first.id }, now)).toMatchObject({ kind: 'placed',
    environment: { id: first.id } })
})

it('filters by capability and label and explains each miss', () => {
  const environment = worker('mac', { capabilities: ['xcode'], labels: { os: 'darwin' }, capacity: 2 })
  expect(scheduler.place({ capabilities: ['xcode'], labels: { os: 'darwin' } }, now)).toMatchObject({ kind: 'placed', environment: { id: environment.id } })
  expect(scheduler.place({ capabilities: ['docker'] }, now)).toEqual({ kind: 'wait', reason: 'capability' })
  expect(scheduler.place({ labels: { os: 'linux' } }, now)).toEqual({ kind: 'wait', reason: 'label' })
})

it('waits when no environment is registered, when all are offline, and when all are busy', () => {
  expect(scheduler.place({}, now)).toEqual({ kind: 'wait', reason: 'noEnvironment' })
  const environment = worker('only', { capacity: 1 })
  expect(scheduler.place({}, later)).toEqual({ kind: 'wait', reason: 'allOffline' })
  fill(environment.id)
  expect(scheduler.place({}, now)).toEqual({ kind: 'wait', reason: 'busy' })
})

it('prefers free capacity and skips a draining environment', () => {
  const busy = worker('busy', { capacity: 2 })
  fill(busy.id)
  const free = worker('free', { capacity: 2 })
  expect(scheduler.place({}, now)).toMatchObject({ kind: 'placed', environment: { id: free.id } })
  environments.setState(free.id, 'draining')
  expect(scheduler.place({}, now)).toMatchObject({ kind: 'placed', environment: { id: busy.id } })
})

it('never falls back from a pinned environment', () => {
  const pinned = worker('pinned')
  const other = worker('other')
  expect(scheduler.place({ environmentId: pinned.id }, now)).toMatchObject({ kind: 'placed', environment: { id: pinned.id } })
  environments.setState(pinned.id, 'revoked')
  expect(scheduler.place({ environmentId: pinned.id }, now)).toEqual({ kind: 'wait', reason: 'pinnedUnavailable' })
  expect(scheduler.place({ environmentId: 'env_missing' }, now)).toEqual({ kind: 'wait', reason: 'pinnedUnavailable' })
  expect(scheduler.place({ environmentId: other.id }, now)).toMatchObject({ kind: 'placed', environment: { id: other.id } })
})

it('lists the best candidate first with its free capacity', () => {
  const one = worker('one', { capacity: 3 })
  const two = worker('two', { capacity: 2 })
  fill(two.id)
  const candidates = scheduler.candidates({}, now)
  expect(candidates.map(candidate => [candidate.environment.id, candidate.available])).toEqual([[one.id, 3], [two.id, 1]])
})
