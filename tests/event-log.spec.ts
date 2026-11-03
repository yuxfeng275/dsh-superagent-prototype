/** The durable event log: recording, per-thread sequencing, acknowledgement, and replay after a crash. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EventLog, eventId } from '../src/app/events.ts'
import { Store } from '../src/app/store.ts'
import type { Trigger } from '../src/core/index.ts'
import { feishu, startRuntime } from './fixtures/host.ts'

const trigger = (id: string, thread = 'oc_team:om_1'): Trigger => ({ id, source: 'feishu', threads: [{ source: 'feishu', id: thread }],
  actor: { source: 'feishu', id: 'ou_alice' }, human: true, at: '2026-10-01T00:00:00.000Z', text: 'hi', meta: {} })

let directory: string
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'orchestrator-events-')) })
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

describe('the event log', () => {
  it('records an event once, sequences it on its thread, and acknowledges it', () => {
    const store = new Store(join(directory, 'orchestrator.sqlite'))
    try {
      const events = new EventLog(store)
      const first = trigger('om_1')
      expect(events.append(first)).toBe(eventId(first))
      // A repeated Source event is the same row, not a second sequence number.
      expect(events.append(first)).toBe(eventId(first))
      expect(events.append(trigger('om_2'))).not.toBe(eventId(first))
      expect(events.append(trigger('om_3', 'oc_team:om_9'))).toBe(eventId(trigger('om_3', 'oc_team:om_9')))
      expect(events.get(eventId(first))).toMatchObject({ threadSeq: 1 })
      expect(events.get(eventId(trigger('om_2')))).toMatchObject({ threadSeq: 2 })
      expect(events.get(eventId(trigger('om_3', 'oc_team:om_9')))).toMatchObject({ threadSeq: 1 })
      expect(events.unacked().map(item => item.id)).toEqual(['om_1', 'om_2', 'om_3'])
      events.ack(eventId(first))
      expect(events.unacked().map(item => item.id)).toEqual(['om_2', 'om_3'])
    } finally { store.close() }
  })

  it('replays an event a crash left unacknowledged, and acknowledges the ones the Engine stores', async () => {
    const message = feishu('1', '请修复登录')
    // Seed only the event: this is the state a crash between recording and acknowledging leaves behind.
    const h = await startRuntime(store => { new EventLog(store).append(message) })
    try {
      await h.runtime.idle()
      expect(h.runtime.store.triggers.get(message.id)).toBeDefined()
      expect(new EventLog(h.runtime.store).unacked()).toEqual([])
    } finally { await h.stop() }
  })

  it('records and acknowledges an event the runtime receives, and ignores a duplicate delivery', async () => {
    const h = await startRuntime()
    try {
      const message = feishu('2', '你好')
      expect(h.runtime.receive(message)).toBe('stored')
      expect(h.runtime.store.triggers.get(message.id)).toBeDefined()
      expect(new EventLog(h.runtime.store).unacked()).toEqual([])
      expect(new EventLog(h.runtime.store).get(eventId(message))).toMatchObject({ threadSeq: 1 })
      expect(h.runtime.receive(message)).toBe('duplicate')
      expect(new EventLog(h.runtime.store).unacked()).toEqual([])
    } finally { await h.stop() }
  })
})
