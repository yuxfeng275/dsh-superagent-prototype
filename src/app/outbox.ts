/** Reliable outbound message delivery backed by persistent receipts, an effect ledger and retried reply effects. */
import type { OutboundMessage, Outbox as OutboxPort, ReplyStatus } from '../core/index.ts'
import type { Commands } from '../infra/commands.ts'
import { checkedImText } from '../infra/text.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import type { HealthEntry } from '../infra/health.ts'
import { FAILURES_BEFORE_ERROR, Later, type Effects } from './effects.ts'
import type { EffectLedger } from './ledger.ts'
import type { Store } from './store.ts'

/** The ledger key of a message's reply: the message ID already identifies it across retries. */
export const replyEffect = (id: string): string => `reply:${id}`

export interface OutboxHost {
  readonly store: Pick<Store, 'atomic' | 'receipts' | 'fencedOut'>
  readonly effects: Pick<Effects, 'enqueue' | 'cancel' | 'handle' | 'idle'>
  readonly sources: Pick<SourceRegistry, 'instance' | 'channelAllowed' | 'send'>
  readonly commands: Commands
  readonly ledger: Pick<EffectLedger, 'intent' | 'sent' | 'failed' | 'confirm' | 'get' | 'summary'>
  /** The `ledger` health entry, which the Outbox keeps current after every settlement and reconcile pass. */
  readonly ledgerHealth: Pick<HealthEntry, 'set'>
  readonly instanceId: string
  /** The instance lease epoch the effect runs under. */
  epoch(): number
  paused(): boolean
}

/**
 * Persists outbound channel messages as receipts and delivers them sequentially through `Effects` and `SourceRegistry`.
 * Implements the core `Outbox` port for `Engine` and source contexts, ensuring per-conversation ordering for each ticket until an earlier message fails repeatedly.
 * Each message also gets an effect-ledger row: `intent` with its receipt, and `sent` once the platform accepted it, so a
 * retry settles a message the platform already accepted without sending it again.
 * Messages wait while processing is paused or their source is unavailable, and settle as dropped when the target conversation is ignored or gone.
 */
export class Outbox implements OutboxPort {
  private duplicate = 0
  constructor(private readonly host: OutboxHost) {
    host.effects.handle('reply', (_payload, id) => this.deliver(id), { limit: () => host.paused() ? 0 : 1, retry: [5000, 300_000] })
  }
  /** Record a message receipt, its ledger intent and its delivery effect atomically; duplicate message IDs are ignored. */
  send(message: OutboundMessage): void {
    // Validate IM reply length here; acknowledgements are already validated when decided.
    if (message.kind === 'reply' && message.channel.source === 'feishu') checkedImText(message.text)
    const { store, effects } = this.host
    store.atomic(() => {
      if (!store.receipts.add(message)) return
      this.record(message)
      effects.enqueue('reply', message.id, {})
    })
    this.report()
  }
  status(id: string): ReplyStatus | undefined { return this.host.store.receipts.get(id)?.status }
  /** How many sends this process avoided because the ledger already recorded the platform's acceptance. */
  get avoided(): number { return this.duplicate }
  /** Keeps the `ledger` health entry current: one count per state and the duplicate sends avoided since this start. */
  report(): void {
    const counts = this.host.ledger.summary()
    this.host.ledgerHealth.set({ state: 'ready', at: new Date().toISOString(),
      detail: `${counts.intent} intent, ${counts.sent} sent, ${counts.confirmed} confirmed, ${counts.failed} failed; ${this.duplicate} duplicate sends avoided` })
  }
  withdraw(id: string): void {
    const { store, effects, ledger } = this.host
    store.atomic(() => {
      if (!store.receipts.withdraw(id)) return
      // A withdrawn message will never be sent; the ledger says so rather than leaving an open intent.
      ledger.failed(replyEffect(id), { reason: 'withdrawn' })
      effects.cancel('reply', id)
    })
    this.report()
  }
  sent(): Promise<void> { return this.host.effects.idle('reply') }
  /**
   * Settles pending receipts whose effect the ledger already records as sent, before delivery starts.
   * A crash between the platform accepting a message and its receipt settling leaves this state; settling it from the
   * ledger means the next start neither sends the message again nor waits for a source to become available.
   * @returns How many receipts the ledger settled.
   */
  reconcile(): number {
    const { store, effects, ledger } = this.host
    let settled = 0
    for (const receipt of store.receipts.waiting()) {
      const key = replyEffect(receipt.id)
      if (ledger.get(key)?.state !== 'sent') continue
      store.atomic(() => {
        store.receipts.settle(receipt, 'sent')
        ledger.confirm(key)
        effects.cancel('reply', receipt.id)
      })
      settled++
    }
    this.duplicate += settled
    this.report()
    return settled
  }
  /** Records the effect's intent, keeping any record a retry already has. */
  private record(message: OutboundMessage): void {
    this.host.ledger.intent(replyEffect(message.id), { instanceId: this.host.instanceId, kind: 'reply',
      target: `${message.channel.source}:${message.channel.thread}`, leaseEpoch: this.host.epoch() })
  }
  private async deliver(id: string): Promise<void> {
    const { store, sources, commands, ledger } = this.host
    const receipt = store.receipts.get(id)
    if (receipt?.status !== 'pending') return
    // A fenced replica sends nothing: the receipt stays pending for the replica that takes over.
    if (store.fencedOut) throw new Later('The instance lease was lost; this replica no longer writes')
    const key = replyEffect(id)
    const recorded = ledger.get(key)
    // A crash after the platform accepted the message but before the receipt settled leaves `sent` (or `confirmed`): settle without sending.
    if (recorded?.state === 'sent' || recorded?.state === 'confirmed') {
      this.duplicate++
      store.receipts.settle(receipt, 'sent')
      this.report()
      return
    }
    // A receipt recorded before the ledger existed, or by an older version, gets its intent now.
    if (!recorded) this.record(receipt)
    if (!sources.instance(receipt.channel.source)?.enabled) throw new Later('The Source is off or not installed')
    // Hold later messages for the same ticket and conversation behind an earlier pending message until it exceeds the failure threshold.
    if (store.receipts.behind(id, FAILURES_BEFORE_ERROR)) throw new Later('An earlier message of this ticket to this conversation waits')
    if (!sources.channelAllowed(receipt.channel)) { store.receipts.settle(receipt, 'channelIgnored'); return }
    // A permanently unreachable target (such as a recalled message or deleted Issue) settles as `channelGone` so its receipt prevents retries.
    const result = await sources.send(receipt, commands)
    if (result === 'waiting') throw new Later('The Source is not installed')
    if (result.result === 'gone') {
      ledger.failed(key, { reason: 'channelGone' })
      store.receipts.settle(receipt, 'channelGone')
      this.report()
      return
    }
    // The platform send is idempotent by its own key (the GitHub marker or the Feishu idempotency key); the platform's own
    // message ID, when it reports one, lets the ledger name the message a retry must not send again.
    ledger.sent(key, { by: 'platform-idempotency' }, result.externalId)
    store.receipts.settle(receipt, 'sent')
    this.report()
  }
}
