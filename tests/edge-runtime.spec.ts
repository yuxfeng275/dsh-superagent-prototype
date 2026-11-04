import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { EdgeServer } from '../src/app/edge-server.ts'
import { WorkerHost } from '../src/edge/worker-host.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host | undefined
afterEach(async () => { await h?.stop(); h = undefined })

it('dispatches a router task to an edge worker and relays its answer to the main Session', async () => {
  h = await startRuntime()
  const fake = join(h.directory, 'fake-dsh')
  writeFileSync(fake, '#!/bin/sh\ncat >/dev/null\necho \'{"type":"session","session_id":"sess-1"}\'\necho \'{"type":"final","text":"remote answer"}\'\n', { mode: 0o755 })
  const server = new EdgeServer({ environments: h.runtime.environments, jobs: h.runtime.edgeJobs, token: 'edge-token', pollTimeoutMs: 200 })
  const port = await server.listen('127.0.0.1', 0)
  const controller = new AbortController()
  const worker = new WorkerHost({ url: `http://127.0.0.1:${port}`, token: 'edge-token', workRoot: join(mkdtempSync(join(tmpdir(), 'edge-worker-')), 'work'),
    name: 'remote-mac', heartbeatMs: 100, dsh: { command: fake } })
  const running = worker.start(controller.signal)
  try {
    await worker.ready
    const dispatched = await h.runTool(h.runtime.masterId, 'orchestrator_worker', { task: 'run the remote check' })
    expect(dispatched).toMatchObject({ dispatched: true, environment: { name: 'remote-mac' } })
    await vi.waitFor(() => {
      const relayed = h!.deliveries.mock.calls.map(([call]) => call as { sessionId: string; text: string })
        .filter(call => call.sessionId === h!.runtime.masterId)
        .flatMap(call => { try { return [JSON.parse(call.text) as Record<string, unknown>] } catch { return [] } })
        .filter(item => item.kind === 'edge_task_result')
      expect(relayed).toContainEqual(expect.objectContaining({ state: 'finished', exit_code: 0, output: 'remote answer', session_id: 'sess-1' }))
    }, { timeout: 8_000, interval: 50 })
    // The result is marked announced, so the next sweep does not repeat it.
    const jobs = h.runtime.edgeJobs.list({ limit: 10 })
    expect(jobs).toContainEqual(expect.objectContaining({ kind: 'task', state: 'finished', announcedAt: expect.any(String) }))
  } finally {
    worker.stop(); await running
    await server.close()
  }
}, 20_000)

it('runs a ticket worker on the configured environment and reports its structured result', async () => {
  h = await startRuntime()
  const fake = join(h.directory, 'ticket-dsh')
  writeFileSync(fake, '#!/bin/sh\ncat >/dev/null\necho \'{"type":"session","session_id":"sess-9"}\'\necho \'{"type":"final","text":"remote ticket done"}\'\n'
    + 'printf %s \'{"state":"ready","summary":"Remote ticket completed"}\' > .dsh-report.json\n', { mode: 0o755 })
  const server = new EdgeServer({ environments: h.runtime.environments, jobs: h.runtime.edgeJobs, token: 'edge-token', pollTimeoutMs: 200 })
  const port = await server.listen('127.0.0.1', 0)
  const controller = new AbortController()
  const workRoot = join(mkdtempSync(join(tmpdir(), 'edge-ticket-')), 'work')
  const worker = new WorkerHost({ url: `http://127.0.0.1:${port}`, token: 'edge-token', workRoot,
    name: 'remote-ticket', heartbeatMs: 100, dsh: { command: fake } })
  const running = worker.start(controller.signal)
  try {
    const environment = await worker.ready
    const settings = h.runtime.store.settings()
    h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, environment: environment.id,
      prepare: 'mkdir -p "$DSH_SUPERAGENT_DIR" && printf prepared > "$DSH_SUPERAGENT_DIR/prepared.txt"' } })
    const { ticket } = await h.acceptedTicket(feishu('9', '@bot fix the remote ticket'))
    await vi.waitFor(() => {
      const current = h!.runtime.store.tickets.get(ticket.id)
      expect(current?.ended?.outcome).toBe('completed')
      expect(current?.assignments.at(-1)?.report).toMatchObject({ state: 'ready', summary: 'Remote ticket completed' })
    }, { timeout: 12_000, interval: 50 })
    // The worker ran on the environment, not in a local Executor Session.
    expect(h.agents.get(`worker-${ticket.id}`)).toBeUndefined()
    const jobs = h.runtime.edgeJobs.list({ ticketId: ticket.id })
    expect(jobs.map(job => job.kind).sort()).toEqual(['prepare', 'task'])
    expect(jobs).toContainEqual(expect.objectContaining({ kind: 'task', ticketId: ticket.id, state: 'finished', announcedAt: expect.any(String) }))
    // The configured prepare command ran on the worker before its agent turn.
    expect(readFileSync(join(workRoot, 'tickets', ticket.execution!.name, 'prepared.txt'), 'utf8')).toBe('prepared')
  } finally {
    worker.stop(); await running
    await server.close()
  }
}, 20_000)
