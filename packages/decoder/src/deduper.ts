import type { TradeSignal, RawTxEvent } from "@tradebot/core";

/** A mempool signal that hasn't confirmed within this window is treated as dropped and evicted. */
const PENDING_TTL_MS = 15 * 60_000;
/** Don't scan the whole map on every insert — prune at most this often. */
const PRUNE_INTERVAL_MS = 60_000;

type PendingEntry = { signal: TradeSignal; ts: number; nonceKey: string | null };

export class SignalDeduper {
  // key: "chain:txHash" → pending mempool signal
  private readonly pending = new Map<string, PendingEntry>();
  // key: "chain:from:nonce" → txKey, for replacement detection
  private readonly nonceToTx = new Map<string, string>();
  private lastPruneAt = 0;

  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  trackMempool(signal: TradeSignal): void {
    const txKey = `${signal.chain}:${signal.txHash}`;
    this.pending.set(txKey, { signal, ts: this.now(), nonceKey: null });
    this.maybePrune();
  }

  trackMempoolWithNonce(signal: TradeSignal, from: string, nonce: number): void {
    const txKey = `${signal.chain}:${signal.txHash}`;
    const nonceKey = `${signal.chain}:${from.toLowerCase()}:${nonce}`;
    this.pending.set(txKey, { signal, ts: this.now(), nonceKey });
    this.nonceToTx.set(nonceKey, txKey);
    this.maybePrune();
  }

  resolveConfirmed(
    event: RawTxEvent,
    confirmedSignal: TradeSignal
  ): { action: "update"; original: TradeSignal } | { action: "new" } {
    void confirmedSignal;
    const txKey = `${event.chain}:${event.txHash}`;
    const entry = this.pending.get(txKey);
    if (entry) {
      this.deleteEntry(txKey, entry);
      return { action: "update", original: entry.signal };
    }
    return { action: "new" };
  }

  resolveReverted(event: RawTxEvent): TradeSignal | null {
    const txKey = `${event.chain}:${event.txHash}`;
    const entry = this.pending.get(txKey);
    if (entry) this.deleteEntry(txKey, entry);
    return entry?.signal ?? null;
  }

  resolveReplaced(chain: string, from: string, nonce: number): TradeSignal | null {
    const nonceKey = `${chain}:${from.toLowerCase()}:${nonce}`;
    const txKey = this.nonceToTx.get(nonceKey);
    if (!txKey) return null;
    const entry = this.pending.get(txKey);
    this.nonceToTx.delete(nonceKey);
    if (entry) {
      this.pending.delete(txKey);
      return entry.signal;
    }
    return null;
  }

  hasPending(chain: string, txHash: string): boolean {
    return this.pending.has(`${chain}:${txHash}`);
  }

  /** Test/inspection helper. */
  get pendingCount(): number {
    return this.pending.size;
  }

  private deleteEntry(txKey: string, entry: PendingEntry): void {
    this.pending.delete(txKey);
    if (entry.nonceKey) this.nonceToTx.delete(entry.nonceKey);
  }

  /** Evict mempool signals that never confirmed/reverted so the maps don't grow unboundedly. */
  private maybePrune(): void {
    const now = this.now();
    if (now - this.lastPruneAt < PRUNE_INTERVAL_MS) return;
    this.lastPruneAt = now;
    for (const [txKey, entry] of this.pending) {
      if (now - entry.ts >= PENDING_TTL_MS) this.deleteEntry(txKey, entry);
    }
  }
}
