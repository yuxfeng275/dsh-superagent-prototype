/** Recovery after a restart: a Source event delivered again, and a reply the platform accepted before the receipt settled. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { EventLog } from '../src/app/events.ts'
import { EffectLedger } from '../src/app/ledger.ts'
import { replyEffect } from '../src/app/outbox.ts'
import { Store } from '../src/app/store.ts'
import type { OutboundMessage } from '../src/core/index.ts'
import { feishu, startRuntime } from './fixtures/host.ts'

it('keeps one Trigger and one Ticket when the same Source event arrives again after a restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'orchestrator-recovery-'))
  try {
    const message = feishu('1', '请修复登录')
    const first = await startRuntime(undefined, {}, { directory, keep: true })
    try {
      const accepted = await first.acceptedTicket(message)
      expect(accepted.ticket.id).toBeTruthy()
    } finally { await first.stop() }

    // The same state directory opens again, as it does after a crash: the event was acknowledged, so its Trigger stays.
    const second = await startRuntime(undefined, {}, { directory, keep: true })
    try {
      expect(second.runtime.receive(message)).toBe('duplicate')
      expect(Number(second.runtime.store.db.prepare('SELECT COUNT(*) AS count FROM trigger WHERE id = ?').get(message.id)?.count)).toBe(1)
      expect(second.runtime.store.tickets.list()).toHaveLength(1)
    } finally { await second.stop() }
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

it('settles a reply the platform accepted before a crash when the runtime starts', async () => {
  const message: OutboundMessage = { id: 'accepted-before-crash', channel: feishu('1', 'x').channel!, text: '已合并。', kind: 'notice' }
  const h = await startRuntime(store => {
    store.receipts.add(message)
    store.db.prepare(`INSERT INTO effect (kind, key, value, seq, due, since) VALUES ('reply', ?, '{}', 1, ?, ?)`)
      .run(message.id, Date.now(), new Date().toISOString())
    const ledger = new EffectLedger(store)
    ledger.intent(replyEffect(message.id), { instanceId: 'test-instance', kind: 'reply', target: 'feishu:oc_team:om_1', leaseEpoch: 1 })
    ledger.sent(replyEffect(message.id), { by: 'platform-idempotency' })
  })
  try {
    expect(h.runtime.outbox.status(message.id)).toBe('sent')
    expect(h.runtime.ledger.get(replyEffect(message.id))).toMatchObject({ state: 'confirmed' })
    expect(h.runtime.effects.pending('reply')).toBe(false)
  } finally { await h.stop() }
})

it('replays an event a crash left unacknowledged after a restart on the same directory', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'orchestrator-recovery-'))
  try {
    const first = await startRuntime(undefined, {}, { directory, keep: true })
    await first.stop()
    // A Source recorded this event, then the process stopped before the Engine stored its Trigger.
    const message = feishu('2', '请补一个测试')
    const crashed = new Store(join(directory, 'orchestrator.sqlite'))
    try { new EventLog(crashed).append(message) } finally { crashed.close() }

    const second = await startRuntime(undefined, {}, { directory, keep: true })
    try {
      expect(second.runtime.store.triggers.get(message.id)).toBeDefined()
      expect(new EventLog(second.runtime.store).unacked()).toEqual([])
    } finally { await second.stop() }
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
