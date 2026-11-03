import { describe, expect, it } from 'vitest'
import { KV } from '../src/kv.ts'
import { startRuntime } from './fixtures/host.ts'

describe('instance identity', () => {
  it('names the main Session after the instance, and keeps the name an existing database stored', async () => {
    const fresh = await startRuntime(undefined, { instanceId: 'team-a' })
    try {
      expect(fresh.runtime.masterId).toBe('orchestrator-team-a')
      expect(fresh.runtime.store.get(KV.runtime.masterId)).toBe('orchestrator-team-a')
    } finally { await fresh.stop() }

    // An upgraded deployment keeps its main Session: a new instance name must not orphan the Session and its history.
    const existing = await startRuntime(store => { store.set(KV.runtime.masterId, 'orchestrator-legacy') }, { instanceId: 'team-b' })
    try {
      expect(existing.runtime.masterId).toBe('orchestrator-legacy')
    } finally { await existing.stop() }
  })

  it('shows the instance and replica identities on the state view', async () => {
    const h = await startRuntime(undefined, { instanceId: 'team-a', replicaId: 'mac-mini' })
    try {
      const state = await h.api('GET', 'state')
      expect(state.body.setup).toMatchObject({ machine: { instanceId: 'team-a', replicaId: 'mac-mini' } })
    } finally { await h.stop() }
  })
})
