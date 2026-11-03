/** Durable log of the events a Source hands to the runtime, and the local acknowledgements that say each one was handled. */
import { key, threadKey, type Trigger } from '../core/index.ts'
import type { Store } from './store.ts'

/** Deterministic ID of a Trigger's event: the same Source event always gets the same row. */
export const eventId = (trigger: Pick<Trigger, 'source' | 'id'>): string => key('event', trigger.source, trigger.id)

/**
 * Records every Trigger before the Engine handles it and acknowledges it in the Engine's own transaction.
 * A crash between the two leaves an unacknowledged event that the next start replays, so an accepted event is never
 * lost to a crash; replay is safe because the Engine ignores a Trigger it already stored.
 * The event log also allocates the per-thread sequence the control plane will later use as a cursor.
 */
export class EventLog {
  constructor(private readonly store: Store, private readonly now: () => string = () => new Date().toISOString()) {}

  /**
   * Records `trigger` if its Source event is new, and returns its event ID.
   * The first thread of the Trigger names the sequence; the row and its `thread_seq` commit together.
   */
  append(trigger: Trigger): string {
    if (!trigger.threads.length) throw new Error('A trigger must belong to at least one thread')
    const id = eventId(trigger)
    const thread = threadKey(trigger.threads[0]!)
    return this.store.atomic(() => {
      if (this.store.db.prepare('SELECT 1 FROM event_log WHERE id = ?').get(id)) return id
      const seq = Number(this.store.db.prepare('SELECT IFNULL(MAX(thread_seq), 0) + 1 AS seq FROM event_log WHERE thread_key = ?')
        .get(thread)?.seq ?? 1)
      this.store.db.prepare(`INSERT INTO event_log (id, source, dedupe_key, thread_key, thread_seq, at, value, received_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`)
        .run(id, trigger.source, trigger.id, thread, seq, trigger.at, JSON.stringify(trigger), this.now())
      return id
    })
  }

  /** Acknowledges an event inside the caller's transaction, which must also store the Trigger (or its duplicate). */
  ack(id: string): void {
    this.store.db.prepare('INSERT INTO inbox_ack (event_id, acked_at) VALUES (?, ?) ON CONFLICT(event_id) DO NOTHING')
      .run(id, this.now())
  }

  /** Unacknowledged events, oldest first: the ones a crash left unhandled. */
  unacked(limit = 100): Trigger[] {
    return this.store.db.prepare(`SELECT value FROM event_log e LEFT JOIN inbox_ack a ON a.event_id = e.id
      WHERE a.event_id IS NULL ORDER BY e.rowid LIMIT ?`).all(limit).map(row => JSON.parse(String(row.value)) as Trigger)
  }

  /** The event row recorded for a Trigger, when it has one. */
  get(id: string): { id: string; threadSeq: number; receivedAt: string } | undefined {
    const row = this.store.db.prepare('SELECT id, thread_seq, received_at FROM event_log WHERE id = ?').get(id)
    return row === undefined ? undefined : { id: String(row.id), threadSeq: Number(row.thread_seq), receivedAt: String(row.received_at) }
  }
}
