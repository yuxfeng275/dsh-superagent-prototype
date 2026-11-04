/** Outbox delivery when processing is paused, a Source kind registers late, or the instance is fenced. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { OutboundMessage } from '../src/core/index.ts'
import { Commands } from '../src/infra/commands.ts'
import { EffectLedger } from '../src/app/ledger.ts'
import { Outbox, replyEffect } from '../src/app/outbox.ts'
import { Store } from '../src/app/store.ts'
import type { SourceKind } from '../src/sources/kind.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host
beforeEach(async () => { h = await startRuntime() })
afterEach(async () => { await h.stop() })
async function at(ms: number) {
  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + ms })
  try { await h.runtime.pump(); await h.runtime.sendReplies() } finally { vi.useRealTimers() }
}

it('holds every message while processing is paused, and sends it once processing resumes', async () => {
  const lark = vi.mocked(Commands.prototype.lark)
  await h.runtime.settings.pause(true, 'panel')
  lark.mockClear()
  h.runtime.outbox.send({ id: 'held', channel: feishu('1', 'x').channel!, text: '已合并。', kind: 'notice' })
  await h.runtime.sendReplies()
  expect([h.runtime.outbox.status('held'), lark.mock.calls.length]).toEqual(['pending', 0])
  await h.runtime.settings.pause(false, 'panel')
  await h.runtime.pump(); await h.runtime.sendReplies()
  expect(h.runtime.outbox.status('held')).toBe('sent')
  expect(JSON.stringify(lark.mock.calls)).toContain('已合并。')
})

it('keeps a message for a Source that is not installed waiting, and sends it once the Source\'s kind registers', async () => {
  const sent: OutboundMessage[] = []
  const probe: SourceKind<Record<string, never>> = { kind: 'probe', title: { zh: '探针', en: 'Probe' }, description: { zh: '', en: '' }, health: [],
    schema: z.object({}).strict(), fields: [],
    channel: { send: async (_host, message) => { sent.push(message); return 'sent' }, link: () => ({ url: '', label: { zh: '探针', en: 'Probe' } }) } }
  h.runtime.outbox.send({ id: 'waiting', channel: { source: 'probe', thread: 'probe:1', address: {} }, text: 'Done', kind: 'reply' })
  await h.runtime.sendReplies()
  expect([h.runtime.outbox.status('waiting'), h.runtime.health.reply?.state]).toEqual(['pending', 'ready'])
  h.runtime.sources.register(probe)
  // A message whose Source was not installed is tried again after 5 seconds.
  await at(5000)
  expect([h.runtime.outbox.status('waiting'), sent.map(message => message.id)]).toEqual(['sent', ['waiting']])
})

it('sends nothing once the instance is fenced, leaving the receipt pending for the next replica', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'outbox-fenced-'))
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  try {
    const handlers = new Map<string, (payload: unknown, key: string) => Promise<void>>()
    const effects = { handle: (kind: string, run: (payload: unknown, key: string) => Promise<void>) => { handlers.set(kind, run) },
      enqueue: vi.fn(), cancel: vi.fn(), idle: vi.fn(async () => {}) }
    const sent: OutboundMessage[] = []
    const sources = { instance: () => ({ enabled: true }), channelAllowed: () => true,
      send: vi.fn(async (message: OutboundMessage) => { sent.push(message); return 'sent' as const }) }
    const outbox = new Outbox({ store, effects, sources, commands: {} as Commands, ledger: new EffectLedger(store),
      instanceId: 'test-instance', epoch: () => 1, paused: () => false } as never)
    const message: OutboundMessage = { id: 'fenced', channel: { source: 'github', thread: 'github:8', address: { number: '8' } }, text: 'Done', kind: 'notice' }
    outbox.send(message)
    store.fence()
    await expect(handlers.get('reply')!({}, 'fenced')).rejects.toThrow('The instance lease was lost')
    expect([sent.length, store.receipts.get('fenced')?.status]).toEqual([0, 'pending'])
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }) }
})

it('records each message in the effect ledger and marks it sent once the platform accepted it', async () => {
  h.runtime.outbox.send({ id: 'ledgered', channel: feishu('1', 'x').channel!, text: '已合并。', kind: 'notice' })
  await h.runtime.pump(); await h.runtime.sendReplies()
  expect(h.runtime.ledger.get(replyEffect('ledgered'))).toMatchObject({ state: 'sent', kind: 'reply', instanceId: 'test-instance',
    detail: { by: 'platform-idempotency' } })
})

it('settles a receipt the platform already accepted instead of sending the message again', async () => {
  const lark = vi.mocked(Commands.prototype.lark)
  await h.runtime.settings.pause(true, 'panel')
  h.runtime.outbox.send({ id: 'accepted', channel: feishu('1', 'x').channel!, text: '已合并。', kind: 'notice' })
  // The platform accepted the message and the ledger recorded it, but the process crashed before the receipt settled.
  h.runtime.ledger.sent(replyEffect('accepted'), { by: 'platform-idempotency' })
  lark.mockClear()
  await h.runtime.settings.pause(false, 'panel')
  await h.runtime.pump(); await h.runtime.sendReplies()
  expect([h.runtime.outbox.status('accepted'), lark.mock.calls.length]).toEqual(['sent', 0])
})

it('settles pending receipts the ledger already records as sent, before delivery starts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'outbox-reconcile-'))
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  try {
    const effects = { handle: vi.fn(), enqueue: vi.fn(), cancel: vi.fn(), idle: vi.fn(async () => {}) }
    const ledger = new EffectLedger(store)
    const outbox = new Outbox({ store, effects, sources: {} as never, commands: {} as never, ledger,
      instanceId: 'test-instance', epoch: () => 1, paused: () => false } as never)
    const message: OutboundMessage = { id: 'reconciled', channel: { source: 'github', thread: 'github:8', address: { number: '8' } }, text: 'Done', kind: 'notice' }
    outbox.send(message)
    // The platform accepted the message and the ledger recorded it, but the process crashed before the receipt settled.
    ledger.sent(replyEffect(message.id), { by: 'platform-idempotency' })
    expect(outbox.reconcile()).toBe(1)
    expect([store.receipts.get(message.id)?.status, ledger.get(replyEffect(message.id))?.state]).toEqual(['sent', 'confirmed'])
    expect(effects.cancel).toHaveBeenCalledWith('reply', message.id)
    // Once settled, the next start has nothing left to reconcile.
    expect(outbox.reconcile()).toBe(0)
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }) }
})
