import type { TradeSignal, RawTxEvent } from "@tradebot/core";

export class SignalDeduper {
  // key: "chain:txHash" → pending mempool signal
  private readonly pending = new Map<string, TradeSignal>();
  // key: "chain:from:nonce" → pending mempool signal (for replacement detection)
  private readonly pendingByNonce = new Map<string, TradeSignal>();

  trackMempool(signal: TradeSignal): void {
    const txKey = `${signal.chain}:${signal.txHash}`;
    this.pending.set(txKey, signal);
    if (signal.txHash) {
      // We'll fill nonce info if available — stored separately in pendingByNonce
    }
  }

  trackMempoolWithNonce(signal: TradeSignal, from: string, nonce: number): void {
    this.trackMempool(signal);
    const nonceKey = `${signal.chain}:${from.toLowerCase()}:${nonce}`;
    this.pendingByNonce.set(nonceKey, signal);
  }

  resolveConfirmed(
    event: RawTxEvent,
    confirmedSignal: TradeSignal
  ): { action: "update"; original: TradeSignal } | { action: "new" } {
    const txKey = `${event.chain}:${event.txHash}`;
    const original = this.pending.get(txKey);
    if (original) {
      this.pending.delete(txKey);
      // Clean up nonce entry if present
      if (event.nonce !== undefined) {
        const nonceKey = `${event.chain}:${event.from.toLowerCase()}:${event.nonce}`;
        this.pendingByNonce.delete(nonceKey);
      }
      return { action: "update", original };
    }
    return { action: "new" };
  }

  resolveReverted(event: RawTxEvent): TradeSignal | null {
    const txKey = `${event.chain}:${event.txHash}`;
    const signal = this.pending.get(txKey) ?? null;
    if (signal) {
      this.pending.delete(txKey);
      if (event.nonce !== undefined) {
        const nonceKey = `${event.chain}:${event.from.toLowerCase()}:${event.nonce}`;
        this.pendingByNonce.delete(nonceKey);
      }
    }
    return signal;
  }

  resolveReplaced(chain: string, from: string, nonce: number): TradeSignal | null {
    const nonceKey = `${chain}:${from.toLowerCase()}:${nonce}`;
    const signal = this.pendingByNonce.get(nonceKey) ?? null;
    if (signal) {
      this.pendingByNonce.delete(nonceKey);
      const txKey = `${signal.chain}:${signal.txHash}`;
      this.pending.delete(txKey);
    }
    return signal;
  }

  hasPending(chain: string, txHash: string): boolean {
    return this.pending.has(`${chain}:${txHash}`);
  }
}
