import type { TradeSignal, RawTxEvent } from "@tradebot/core";

/** A mempool signal that hasn't confirmed within this window is treated as dropped and evicted. */
const PENDING_TTL_MS = 15 * 60_000;
/** Don't scan the whole map on every insert — prune at most this often. */
const PRUNE_INTERVAL_MS = 60_000;

type PendingEntry = { signal: TradeSignal; ts: number; nonceKey: string | null };

export class SignalDeduper {
  // key: "chain:txHash" → pending mempool signals for that transaction
  private readonly pending = new Map<string, PendingEntry[]>();
  // key: "chain:from:nonce" → txKey, for replacement detection
  private readonly nonceToTx = new Map<string, string>();
  private lastPruneAt = 0;

  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  trackMempool(signal: TradeSignal): void {
    const txKey = `${signal.chain}:${signal.txHash}`;
    this.addPending(txKey, { signal, ts: this.now(), nonceKey: null });
    this.maybePrune();
  }

  trackMempoolWithNonce(signal: TradeSignal, from: string, nonce: number): void {
    const txKey = `${signal.chain}:${signal.txHash}`;
    const nonceKey = `${signal.chain}:${from.toLowerCase()}:${nonce}`;
    this.addPending(txKey, { signal, ts: this.now(), nonceKey });
    this.nonceToTx.set(nonceKey, txKey);
    this.maybePrune();
  }

  resolveConfirmed(
    event: RawTxEvent,
    confirmedSignal: TradeSignal
  ): { action: "update"; original: TradeSignal } | { action: "new" } {
    void confirmedSignal;
    const txKey = `${event.chain}:${event.txHash}`;
    const entry = this.takeMatchingEntry(txKey, confirmedSignal);
    if (entry) {
      return { action: "update", original: entry.signal };
    }
    return { action: "new" };
  }

  resolveReverted(event: RawTxEvent): TradeSignal | null {
    return this.resolveRevertedAll(event)[0] ?? null;
  }

  resolveRevertedAll(event: RawTxEvent): TradeSignal[] {
    const txKey = `${event.chain}:${event.txHash}`;
    const entries = this.pending.get(txKey) ?? [];
    for (const entry of entries) this.deleteNonce(entry);
    this.pending.delete(txKey);
    return entries.map((entry) => entry.signal);
  }

  resolveReplaced(chain: string, from: string, nonce: number): TradeSignal | null {
    return this.resolveReplacedAll(chain, from, nonce)[0] ?? null;
  }

  resolveReplacedAll(chain: string, from: string, nonce: number, currentTxHash?: string): TradeSignal[] {
    const nonceKey = `${chain}:${from.toLowerCase()}:${nonce}`;
    const txKey = this.nonceToTx.get(nonceKey);
    if (!txKey) return [];
    // The confirmed tx carries the same nonce as its own pending entry — that's a confirmation,
    // not a replacement. Leave the entry intact so resolveConfirmed can match it.
    if (currentTxHash !== undefined && txKey === `${chain}:${currentTxHash}`) return [];
    const entries = this.pending.get(txKey) ?? [];
    this.nonceToTx.delete(nonceKey);
    this.pending.delete(txKey);
    return entries.map((entry) => entry.signal);
  }

  hasPending(chain: string, txHash: string): boolean {
    return this.pending.has(`${chain}:${txHash}`);
  }

  /** Test/inspection helper. */
  get pendingCount(): number {
    let count = 0;
    for (const entries of this.pending.values()) count += entries.length;
    return count;
  }

  private addPending(txKey: string, entry: PendingEntry): void {
    const entries = this.pending.get(txKey) ?? [];
    entries.push(entry);
    this.pending.set(txKey, entries);
  }

  private takeMatchingEntry(txKey: string, confirmedSignal: TradeSignal): PendingEntry | null {
    const entries = this.pending.get(txKey);
    if (!entries || entries.length === 0) return null;

    const index = entries.findIndex((entry) => signalsMatch(entry.signal, confirmedSignal));
    // No pending entry matches this confirmed signal — don't consume an unrelated provisional.
    if (index < 0) return null;
    const [entry] = entries.splice(index, 1);
    if (entries.length === 0) this.pending.delete(txKey);
    if (entry) this.deleteNonce(entry);
    return entry ?? null;
  }

  private deleteEntry(txKey: string, entry: PendingEntry): void {
    const entries = this.pending.get(txKey);
    if (entries) {
      const index = entries.indexOf(entry);
      if (index >= 0) entries.splice(index, 1);
      if (entries.length === 0) this.pending.delete(txKey);
    }
    this.deleteNonce(entry);
  }

  private deleteNonce(entry: PendingEntry): void {
    if (entry.nonceKey) this.nonceToTx.delete(entry.nonceKey);
  }

  /** Evict mempool signals that never confirmed/reverted so the maps don't grow unboundedly. */
  private maybePrune(): void {
    const now = this.now();
    if (now - this.lastPruneAt < PRUNE_INTERVAL_MS) return;
    this.lastPruneAt = now;
    for (const [txKey, entries] of this.pending) {
      for (const entry of [...entries]) {
        if (now - entry.ts >= PENDING_TTL_MS) this.deleteEntry(txKey, entry);
      }
    }
  }
}

function signalsMatch(left: TradeSignal, right: TradeSignal): boolean {
  return (
    left.side === right.side &&
    left.tokenIn.address.toLowerCase() === right.tokenIn.address.toLowerCase() &&
    left.tokenOut.address.toLowerCase() === right.tokenOut.address.toLowerCase()
  );
}
