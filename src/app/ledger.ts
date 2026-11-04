/** Durable ledger of external side effects: what the Router intended, and what it knows the platform accepted. */
import type { Store } from './store.ts'

/** Where an effect stands: recorded before running, accepted by the platform, confirmed by a later read, failed, or reconciled. */
export type EffectState = 'intent' | 'sent' | 'confirmed' | 'failed' | 'reconciled'
/** How many effects stand in each state; the `ledger` health entry reports them. */
export interface EffectCounts { intent: number; sent: number; confirmed: number; failed: number; reconciled: number }
/** One external effect, by idempotency key. */
export interface EffectRecord {
  idempotencyKey: string
  instanceId: string
  kind: string
  target: string
  leaseEpoch: number
  state: EffectState
  externalId?: string
  createdAt: string
  updatedAt: string
  detail: Record<string, unknown>
}

/**
 * Records each controlled external effect under a stable idempotency key, before and after it runs.
 * The Outbox records `intent` with its receipt and `sent` once the platform accepted the message; a retry that finds
 * `sent` settles its receipt without sending again, so a crash between the platform accepting a message and the receipt
 * being recorded cannot send it twice. The platform's own idempotency (the GitHub comment marker, the Feishu key) covers
 * the remaining window between the platform accepting and `sent` being recorded.
 * The ledger is written only by the Brain-side Outbox, which the plan makes the single authority for these effects.
 */
export class EffectLedger {
  constructor(private readonly store: Store, private readonly now: () => string = () => new Date().toISOString()) {}

  /** Records an effect before it runs; a key that already has a record keeps its state and detail. */
  intent(key: string, entry: { instanceId: string; kind: string; target: string; leaseEpoch: number }): void {
    const at = this.now()
    this.store.atomic(() => this.store.db.prepare(`INSERT INTO effect_ledger
      (idempotency_key, instance_id, kind, target, lease_epoch, state, created_at, updated_at, detail)
      VALUES (?, ?, ?, ?, ?, 'intent', ?, ?, '{}') ON CONFLICT(idempotency_key) DO NOTHING`)
      .run(key, entry.instanceId, entry.kind, entry.target, entry.leaseEpoch, at, at))
  }

  /** Records that the platform accepted the effect; `detail` says how a retry recognises it, and `externalId` is the platform's own ID when it reported one. */
  sent(key: string, detail: Record<string, unknown> = {}, externalId?: string): void {
    this.store.atomic(() => this.store.db.prepare(`UPDATE effect_ledger SET state = 'sent', external_id = COALESCE(?, external_id),
      updated_at = ?, detail = ? WHERE idempotency_key = ?`).run(externalId ?? null, this.now(), JSON.stringify(detail), key))
  }

  /** Records that the platform will never accept the effect, such as a conversation that no longer exists. */
  failed(key: string, detail: Record<string, unknown> = {}): void {
    this.store.atomic(() => this.store.db.prepare(`UPDATE effect_ledger SET state = 'failed', updated_at = ?, detail = ?
      WHERE idempotency_key = ?`).run(this.now(), JSON.stringify(detail), key))
  }

  /** Records that a sent effect is confirmed, such as when a restart settled its receipt from this record. */
  confirm(key: string): void {
    this.store.atomic(() => this.store.db.prepare(`UPDATE effect_ledger SET state = 'confirmed', updated_at = ?
      WHERE idempotency_key = ? AND state = 'sent'`).run(this.now(), key))
  }

  /** The number of effects in each state, in one read, for the `ledger` health entry. */
  summary(): EffectCounts {
    const counts: EffectCounts = { intent: 0, sent: 0, confirmed: 0, failed: 0, reconciled: 0 }
    for (const row of this.store.db.prepare('SELECT state, COUNT(*) AS count FROM effect_ledger GROUP BY state').all()) {
      const state = String(row.state) as keyof EffectCounts
      if (state in counts) counts[state] = Number(row.count)
    }
    return counts
  }

  /** The record of one effect, when it has one. */
  get(key: string): EffectRecord | undefined {
    const row = this.store.db.prepare(`SELECT idempotency_key, instance_id, kind, target, lease_epoch, state, external_id,
      created_at, updated_at, detail FROM effect_ledger WHERE idempotency_key = ?`).get(key)
    if (row === undefined) return undefined
    return {
      idempotencyKey: String(row.idempotency_key), instanceId: String(row.instance_id), kind: String(row.kind),
      target: String(row.target), leaseEpoch: Number(row.lease_epoch), state: String(row.state) as EffectState,
      ...row.external_id === null ? {} : { externalId: String(row.external_id) },
      createdAt: String(row.created_at), updatedAt: String(row.updated_at),
      detail: JSON.parse(String(row.detail)) as Record<string, unknown>,
    }
  }
}
