/** The effect ledger: one record per idempotency key, its intent kept on a retry, and its sent or failed outcome. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { EffectLedger } from '../src/app/ledger.ts'
import { Store } from '../src/app/store.ts'

let directory: string
let store: Store
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orchestrator-ledger-'))
  store = new Store(join(directory, 'orchestrator.sqlite'))
})
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })

it('keeps one record per idempotency key and moves it from intent to sent or failed', () => {
  const ledger = new EffectLedger(store, () => '2026-01-01T00:00:00.000Z')
  ledger.intent('reply:m1', { instanceId: 'team-a', kind: 'reply', target: 'feishu:oc_1:om_1', leaseEpoch: 3 })
  expect(ledger.get('reply:m1')).toMatchObject({ idempotencyKey: 'reply:m1', instanceId: 'team-a', kind: 'reply',
    target: 'feishu:oc_1:om_1', leaseEpoch: 3, state: 'intent', detail: {} })
  ledger.sent('reply:m1', { by: 'platform-idempotency' }, 'om_reply')
  expect(ledger.get('reply:m1')).toMatchObject({ state: 'sent', externalId: 'om_reply', detail: { by: 'platform-idempotency' } })
  // A retry records its intent again but must not move a settled record back.
  ledger.intent('reply:m1', { instanceId: 'team-a', kind: 'reply', target: 'feishu:oc_1:om_1', leaseEpoch: 4 })
  expect(ledger.get('reply:m1')).toMatchObject({ state: 'sent', leaseEpoch: 3 })
  ledger.failed('reply:m1', { reason: 'channelGone' })
  expect(ledger.get('reply:m1')).toMatchObject({ state: 'failed', detail: { reason: 'channelGone' } })
  expect(ledger.get('missing')).toBeUndefined()
})

it('counts the effects in each state for the ledger health entry', () => {
  const ledger = new EffectLedger(store)
  const entry = { instanceId: 'team-a', kind: 'reply', target: 'feishu:oc_1:om_1', leaseEpoch: 1 }
  ledger.intent('reply:a', entry)
  ledger.intent('reply:b', entry)
  ledger.intent('reply:c', entry)
  ledger.sent('reply:a')
  ledger.failed('reply:c', { reason: 'channelGone' })
  expect(ledger.summary()).toEqual({ intent: 1, sent: 1, confirmed: 0, failed: 1, reconciled: 0 })
  ledger.confirm('reply:a')
  expect(ledger.summary()).toEqual({ intent: 1, sent: 0, confirmed: 1, failed: 1, reconciled: 0 })
})
