/** Leases: one live holder, a monotonic epoch floor, renewal deadlines, and the Runtime's instance lease. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Leases } from '../src/app/leases.ts'
import { Store } from '../src/app/store.ts'
import { feishu, startRuntime } from './fixtures/host.ts'

let directory: string
let store: Store
let at: number
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orchestrator-leases-'))
  store = new Store(join(directory, 'orchestrator.sqlite'))
  at = Date.parse('2026-01-01T00:00:00Z')
})
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
const clock = () => new Date(at).toISOString()
const advance = (ms: number) => { at += ms }

describe('leases', () => {
  it('gives one live holder the resource and keeps the epoch when that holder extends it', () => {
    const leases = new Leases(store, clock)
    expect(leases.acquire('instance', 'i1', 'a', 1000)).toMatchObject({ holder: 'a', epoch: 1, state: 'held' })
    // Another holder waits while the lease is live, and the same holder extends without a new epoch.
    expect(leases.acquire('instance', 'i1', 'b', 1000)).toBeUndefined()
    expect(leases.acquire('instance', 'i1', 'a', 1000)).toMatchObject({ holder: 'a', epoch: 1 })
    advance(500)
    expect(leases.renew('instance', 'i1', 'a', 1, 1000)).toBe(true)
    expect(leases.current('instance', 'i1')?.expiresAt).toBe(new Date(at + 1000).toISOString())
    advance(1000)
    // Renewal is refused after the deadline, and the next holder takes the lease with a larger epoch.
    expect(leases.renew('instance', 'i1', 'a', 1, 1000)).toBe(false)
    expect(leases.acquire('instance', 'i1', 'b', 1000)).toMatchObject({ holder: 'b', epoch: 2 })
    // An older epoch can neither renew nor release the new holder's lease.
    expect(leases.renew('instance', 'i1', 'a', 1, 1000)).toBe(false)
    expect(leases.release('instance', 'i1', 'a', 1)).toBe(false)
    expect(leases.release('instance', 'i1', 'b', 2)).toBe(true)
    expect(leases.current('instance', 'i1')).toMatchObject({ holder: 'b', state: 'released' })
    expect(leases.acquire('instance', 'i1', 'a', 1000)).toMatchObject({ holder: 'a', epoch: 3 })
  })

  it('never reuses an epoch, even when the lease row is gone', () => {
    const leases = new Leases(store, clock)
    expect(leases.acquire('instance', 'i1', 'a', 1000)?.epoch).toBe(1)
    advance(1000)
    expect(leases.acquire('instance', 'i1', 'b', 1000)?.epoch).toBe(2)
    store.db.prepare("DELETE FROM lease WHERE resource_type = 'instance' AND resource_id = 'i1'").run()
    expect(leases.floor('instance', 'i1')).toBe(2)
    expect(leases.acquire('instance', 'i1', 'c', 1000)?.epoch).toBe(3)
  })
})

describe('the instance lease', () => {
  it('belongs to the replica at start and takes over a stale lease with a larger epoch', async () => {
    const h = await startRuntime(seed => {
      const past = new Date(Date.now() - 60_000).toISOString()
      seed.db.prepare(`INSERT INTO lease (resource_type, resource_id, holder, epoch, state, acquired_at, heartbeat_at, expires_at)
        VALUES ('instance', 'test-instance', 'old-replica', 4, 'held', ?, ?, ?)`).run(past, past, past)
      seed.db.prepare("INSERT INTO lease_generation (resource_type, resource_id, max_epoch, updated_at) VALUES ('instance', 'test-instance', 4, ?)")
        .run(past)
    })
    try {
      expect(h.runtime.leases.current('instance', 'test-instance')).toMatchObject({ holder: 'test-replica', epoch: 5, state: 'held' })
      expect(h.runtime.receive(feishu('1', '你好'))).toBe('stored')
    } finally { await h.stop() }
  })

  it('keeps a replica without a live lease from taking work', async () => {
    const h = await startRuntime(seed => {
      const future = new Date(Date.now() + 60_000).toISOString()
      const past = new Date(Date.now() - 60_000).toISOString()
      seed.db.prepare(`INSERT INTO lease (resource_type, resource_id, holder, epoch, state, acquired_at, heartbeat_at, expires_at)
        VALUES ('instance', 'test-instance', 'other-replica', 1, 'held', ?, ?, ?)`).run(past, past, future)
    })
    try {
      expect(h.runtime.health.runtime).toMatchObject({ state: 'error', detail: expect.stringContaining('instance lease is held') })
      expect(() => h.runtime.receive(feishu('2', '你好'))).toThrow('does not hold the instance lease')
    } finally { await h.stop() }
  })
})
