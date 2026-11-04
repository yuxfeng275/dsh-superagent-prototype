import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { EdgeJobs } from '../src/app/edge-jobs.ts'
import { EdgeServer } from '../src/app/edge-server.ts'
import { Environments } from '../src/app/environments.ts'
import { Store } from '../src/app/store.ts'
import { jobDirectory, WorkerHost } from '../src/edge/worker-host.ts'

let directory: string
let store: Store
let environments: Environments
let jobs: EdgeJobs
let server: EdgeServer
let url: string
let controller: AbortController
const cleanups: (() => Promise<void> | void)[] = []
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'edge-host-'))
  store = new Store(join(directory, 'orchestrator.sqlite'))
  environments = new Environments(store)
  jobs = new EdgeJobs(store)
  server = new EdgeServer({ environments, jobs, token: 'test-token', heartbeatIntervalMs: 50, pollTimeoutMs: 200 })
  const port = await server.listen('127.0.0.1', 0)
  url = `http://127.0.0.1:${port}`
  controller = new AbortController()
  cleanups.push(() => server.close())
})
afterEach(async () => {
  controller.abort()
  for (const cleanup of cleanups.reverse()) await cleanup()
  store.close()
  rmSync(directory, { recursive: true, force: true })
})

const host = (overrides: Partial<ConstructorParameters<typeof WorkerHost>[0]> = {}) => new WorkerHost({ url, token: 'test-token',
  workRoot: join(directory, 'worker'), name: 'test host', capacity: 1, heartbeatMs: 50, ...overrides })
async function eventually(check: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${message}`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}
const call = (path: string, body: unknown, token = 'test-token') => fetch(new URL(path, url), { method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })

it('registers a host, runs its job on the work root, and reports the result', async () => {
  const worker = host()
  cleanups.push(() => worker.stop())
  const running = worker.start(controller.signal)
  const environment = await worker.ready
  expect(environment).toMatchObject({ name: 'test host', state: 'online', capacity: 1 })
  expect(await (await call('/v1/edge/heartbeat', { environment_id: environment.id })).json()).toMatchObject({ desired_state: 'online' })

  const job = jobs.enqueue({ kind: 'prepare', environmentId: environment.id,
    payload: { cwd: 'tickets/t1', command: 'printf hello > ready.txt' } }, new Date().toISOString())
  await eventually(() => jobs.get(job.id)?.state === 'finished', 'the job to finish')
  expect(jobs.get(job.id)?.result).toMatchObject({ exitCode: 0, output: '' })
  expect(readFileSync(join(directory, 'worker', 'tickets', 't1', 'ready.txt'), 'utf8')).toBe('hello')
  worker.stop(); await running
})

it('authenticates every edge request', async () => {
  const response = await call('/v1/edge/heartbeat', { environment_id: 'env_missing' }, 'wrong')
  expect(response.status).toBe(401)
  expect(await response.json()).toEqual({ error: 'A valid edge token is required' })
  expect((await call('/v1/edge/jobs:poll', { environment_id: 'env_missing' })).status).toBe(404)
})

it('claims at most the announced capacity and queues the rest', async () => {
  const worker = host({ capacity: 1 })
  cleanups.push(() => worker.stop())
  const running = worker.start(controller.signal)
  const environment = await worker.ready
  const first = jobs.enqueue({ kind: 'prepare', environmentId: environment.id, payload: { cwd: 'a', command: 'sleep 0.2' } }, new Date().toISOString())
  const second = jobs.enqueue({ kind: 'prepare', environmentId: environment.id, payload: { cwd: 'b', command: '' } }, new Date().toISOString())
  await eventually(() => jobs.get(first.id)?.state === 'finished' && jobs.get(second.id)?.state === 'finished', 'both jobs')
  worker.stop(); await running
})

it('reports a job a stopped host left running as lost so it is queued again', async () => {
  const worker = host()
  const running = worker.start(controller.signal)
  const environment = await worker.ready
  // A host that stopped mid-job leaves its id in the state file, without reporting the result.
  jobs.enqueue({ kind: 'prepare', environmentId: environment.id, payload: { cwd: 'lost', command: 'sleep 1' } }, new Date().toISOString())
  const claimed = jobs.claim(environment.id, new Date().toISOString())!
  worker.stop(); await running
  writeFileSync(join(directory, 'worker', 'worker-host.json'), JSON.stringify({ id: environment.id, running: [claimed.id] }))
  const restarted = host()
  cleanups.push(() => restarted.stop())
  const again = restarted.start(controller.signal)
  await restarted.ready
  await eventually(() => ['queued', 'offered', 'started', 'finished'].includes(jobs.get(claimed.id)!.state), 'the lost job to return')
  expect(jobs.get(claimed.id)!.attempts).toBeGreaterThanOrEqual(1)
  restarted.stop(); await again
})

it('keeps a job inside its work root', async () => {
  const worker = host({ workRoot: join(directory, 'constraint') })
  const running = worker.start(controller.signal)
  const environment = await worker.ready
  worker.stop(); await running
  const escape = jobs.enqueue({ kind: 'prepare', environmentId: environment.id, payload: { cwd: '../../outside', command: '' } }, new Date().toISOString())
  await expect(jobDirectory(escape, join(directory, 'constraint'))).rejects.toThrow(/outside the work root/)
})

it('rejects a job path outside the work root over the protocol', async () => {
  const worker = host({ workRoot: join(directory, 'protocol') })
  cleanups.push(() => worker.stop())
  const running = worker.start(controller.signal)
  const environment = await worker.ready
  const job = jobs.enqueue({ kind: 'prepare', environmentId: environment.id, payload: { cwd: '../escape', command: 'true' } }, new Date().toISOString())
  await eventually(() => jobs.get(job.id)?.state === 'failed', 'the escaping job to fail')
  expect(jobs.get(job.id)?.result?.error).toMatch(/outside the work root/)
  worker.stop(); await running
})

it('runs an agent task with DSH and reports its final answer and session', async () => {
  const fake = join(directory, 'fake-dsh')
  writeFileSync(fake, '#!/bin/sh\ncat >/dev/null\necho \'{"type":"session","session_id":"sess-1"}\'\necho \'{"type":"final","text":"task output"}\'\n',
    { mode: 0o755 })
  const worker = host({ dsh: { command: fake, home: join(directory, '.dsh') } })
  cleanups.push(() => worker.stop())
  const running = worker.start(controller.signal)
  const environment = await worker.ready
  expect(environment.capabilities).toContain('dsh')
  const job = jobs.enqueue({ kind: 'task', environmentId: environment.id, payload: { cwd: 'tasks/one', task: 'do the task' } },
    new Date().toISOString())
  await eventually(() => jobs.get(job.id)?.state === 'finished', 'the task to finish')
  expect(jobs.get(job.id)?.result).toMatchObject({ exitCode: 0, output: 'task output', sessionId: 'sess-1' })
  worker.stop(); await running
})

it('reports a task DSH refused to finish with its error and exit code', async () => {
  const fake = join(directory, 'failing-dsh')
  writeFileSync(fake, '#!/bin/sh\ncat >/dev/null\necho \'{"type":"error","message":"model unavailable"}\'\nexit 1\n', { mode: 0o755 })
  const worker = host({ dsh: { command: fake, home: join(directory, '.dsh') } })
  cleanups.push(() => worker.stop())
  const running = worker.start(controller.signal)
  const environment = await worker.ready
  const job = jobs.enqueue({ kind: 'task', environmentId: environment.id, payload: { cwd: 'tasks/two', task: 'do the task' } },
    new Date().toISOString())
  await eventually(() => jobs.get(job.id)?.state === 'finished', 'the task to settle')
  expect(jobs.get(job.id)?.result).toMatchObject({ exitCode: 1, error: 'model unavailable' })
  worker.stop(); await running
})
