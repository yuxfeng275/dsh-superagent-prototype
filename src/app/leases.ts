/** Durable leases that give exactly one holder the right to act on a resource, with a monotonic epoch that never goes back. */
import type { Store } from './store.ts'

/** The ISO deadline `ttlMs` after `at`. */
const deadline = (at: string, ttlMs: number): string => new Date(Date.parse(at) + ttlMs).toISOString()

/** What a lease's row records: a held lease may still be expired by time, which the next acquisition treats as free. */
export type LeaseState = 'held' | 'released' | 'expired' | 'revoked'
/** A lease of one resource, held by one replica at one epoch. */
export interface Lease {
  resourceType: string
  resourceId: string
  holder: string
  epoch: number
  state: LeaseState
  acquiredAt: string
  heartbeatAt: string
  expiresAt: string
}
/**
 * Stores leases and their epoch floor in the instance's SQLite database.
 * The floor row is only ever raised, so an epoch is never reused even after a lease is released, expired, or its row is
 * deleted by maintenance; acquisition computes the next epoch as the larger of the floor and the current row, plus one.
 * The holder self-fences on its own clock: `renew` fails once the deadline passed, so a holder that cannot reach the
 * database must stop rather than write on a lease someone else may already own.
 */
export class Leases {
  constructor(private readonly store: Store, private readonly now: () => string = () => new Date().toISOString()) {}

  /** The current lease row of a resource, whether or not it is still live. */
  current(resourceType: string, resourceId: string): Lease | undefined {
    const row = this.store.db.prepare(`SELECT resource_type, resource_id, holder, epoch, state, acquired_at, heartbeat_at, expires_at
      FROM lease WHERE resource_type = ? AND resource_id = ?`).get(resourceType, resourceId)
    return row === undefined ? undefined : {
      resourceType: String(row.resource_type), resourceId: String(row.resource_id), holder: String(row.holder),
      epoch: Number(row.epoch), state: String(row.state) as LeaseState, acquiredAt: String(row.acquired_at),
      heartbeatAt: String(row.heartbeat_at), expiresAt: String(row.expires_at),
    }
  }

  /**
   * Takes the lease for `holder`, or returns nothing while another holder's lease is live.
   * The same holder extending a live lease keeps its epoch; every takeover, restart after expiry, or re-acquisition
   * after release gets a strictly larger one.
   */
  acquire(resourceType: string, resourceId: string, holder: string, ttlMs: number): Lease | undefined {
    return this.store.atomic(() => {
      const at = this.now()
      const expiresAt = deadline(at, ttlMs)
      const existing = this.current(resourceType, resourceId)
      if (existing && existing.state === 'held' && existing.expiresAt > at) {
        if (existing.holder !== holder) return undefined
        this.store.db.prepare(`UPDATE lease SET heartbeat_at = ?, expires_at = ? WHERE resource_type = ? AND resource_id = ?
          AND holder = ? AND epoch = ? AND state = 'held'`).run(at, expiresAt, resourceType, resourceId, holder, existing.epoch)
        return { ...existing, heartbeatAt: at, expiresAt }
      }
      const epoch = Math.max(this.floor(resourceType, resourceId), existing?.epoch ?? 0) + 1
      this.store.db.prepare(`INSERT INTO lease (resource_type, resource_id, holder, epoch, state, acquired_at, heartbeat_at, expires_at)
        VALUES (?, ?, ?, ?, 'held', ?, ?, ?) ON CONFLICT(resource_type, resource_id) DO UPDATE SET holder = excluded.holder,
        epoch = excluded.epoch, state = excluded.state, acquired_at = excluded.acquired_at, heartbeat_at = excluded.heartbeat_at,
        expires_at = excluded.expires_at`).run(resourceType, resourceId, holder, epoch, at, at, expiresAt)
      this.store.db.prepare(`INSERT INTO lease_generation (resource_type, resource_id, max_epoch, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(resource_type, resource_id) DO UPDATE SET max_epoch = MAX(lease_generation.max_epoch, excluded.max_epoch),
        updated_at = excluded.updated_at`).run(resourceType, resourceId, epoch, at)
      return { resourceType, resourceId, holder, epoch, state: 'held' as const, acquiredAt: at, heartbeatAt: at, expiresAt }
    })
  }

  /** Extends a lease this holder still owns; false once it expired or another epoch holds it. */
  renew(resourceType: string, resourceId: string, holder: string, epoch: number, ttlMs: number): boolean {
    const at = this.now()
    const result = this.store.db.prepare(`UPDATE lease SET heartbeat_at = ?, expires_at = ? WHERE resource_type = ? AND resource_id = ?
      AND holder = ? AND epoch = ? AND state = 'held' AND expires_at > ?`).run(at, deadline(at, ttlMs), resourceType, resourceId, holder, epoch, at)
    return Number(result.changes) > 0
  }

  /** Gives up a lease this holder still owns; an older epoch cannot release a newer holder's lease. */
  release(resourceType: string, resourceId: string, holder: string, epoch: number): boolean {
    const result = this.store.db.prepare(`UPDATE lease SET state = 'released', heartbeat_at = ? WHERE resource_type = ?
      AND resource_id = ? AND holder = ? AND epoch = ? AND state = 'held'`).run(this.now(), resourceType, resourceId, holder, epoch)
    return Number(result.changes) > 0
  }

  /** The highest epoch ever allocated for a resource. */
  floor(resourceType: string, resourceId: string): number {
    const row = this.store.db.prepare('SELECT max_epoch FROM lease_generation WHERE resource_type = ? AND resource_id = ?')
      .get(resourceType, resourceId)
    return Number(row?.max_epoch ?? 0)
  }
}

