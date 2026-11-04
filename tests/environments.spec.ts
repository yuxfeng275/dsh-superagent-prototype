import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Environments, HEARTBEAT_TTL_MS } from '../src/app/environments.ts'
import { Store } from '../src/app/store.ts'

let directory: string
let store: Store
let environments: Environments
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'environments-'))
  store = new Store(join(directory, 'orchestrator.sqlite'))
  environments = new Environments(store)
})
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })

const at = (offsetMs = 0): string => new Date(Date.parse('2026-11-04T00:00:00.000Z') + offsetMs).toISOString()

it('registers an environment and keeps it online while it heartbeats', () => {
  const registered = environments.register({ name: 'Mac mini', labels: { os: 'darwin' }, capabilities: ['xcode', 'browser'], capacity: 2 }, at())
  expect(registered.id).toMatch(/^env_/)
  expect(registered).toMatchObject({ name: 'Mac mini', kind: 'byom', state: 'online', capacity: 2, labels: { os: 'darwin' },
    capabilities: ['xcode', 'browser'] })
  expect(environments.online(at(HEARTBEAT_TTL_MS))).toHaveLength(1)
  // A heartbeat older than the TTL reads as offline without a repair write.
  expect(environments.online(at(HEARTBEAT_TTL_MS + 1))).toEqual([])
  const beat = environments.heartbeat(registered.id, at(20_000))!
  expect(beat.lastSeenAt).toBe(at(20_000))
  expect(environments.online(at(25_000))).toHaveLength(1)
})

it('keeps the id across a re-registration and updates the announcement', () => {
  const first = environments.register({ name: 'old', capacity: 1 }, at())
  const second = environments.register({ id: first.id, name: 'new', capabilities: ['docker', 'docker'], capacity: 4 }, at(1_000))
  expect(second).toMatchObject({ id: first.id, name: 'new', capacity: 4, capabilities: ['docker'], registeredAt: first.registeredAt,
    lastSeenAt: at(1_000) })
  expect(environments.list()).toHaveLength(1)
})

it('does not revive a revoked environment by heartbeating', () => {
  const environment = environments.register({ name: 'lost laptop' }, at())
  environments.setState(environment.id, 'revoked')
  const beat = environments.heartbeat(environment.id, at(1_000))!
  expect(beat.state).toBe('revoked')
  expect(environments.online(at(1_000))).toEqual([])
})

it('records a crashed environment offline when swept, and forgets a removed one', () => {
  const environment = environments.register({ name: 'runner' }, at())
  expect(environments.sweep(at(HEARTBEAT_TTL_MS))).toBe(0)
  expect(environments.sweep(at(HEARTBEAT_TTL_MS + 1))).toBe(1)
  expect(environments.get(environment.id)!.state).toBe('offline')
  expect(environments.sweep(at(HEARTBEAT_TTL_MS + 2))).toBe(0)
  expect(environments.remove(environment.id)).toBe(true)
  expect(environments.get(environment.id)).toBeUndefined()
})

it('drains an environment without treating it as offline', () => {
  const environment = environments.register({ name: 'runner' }, at())
  environments.setState(environment.id, 'draining')
  expect(environments.isOnline(environments.get(environment.id)!, at())).toBe(false)
  expect(environments.heartbeat(environment.id, at(1_000))!.state).toBe('draining')
})
