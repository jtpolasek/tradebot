import type { ChainId } from "@tradebot/core";

/**
 * Minimal projection of a TradeSignal used to diff what the current decoder *would* produce from a
 * recording against what is already persisted. Ported from the GMGN `candidateReprocess` tool and
 * adapted to tradebot's signal shape: `decodeStatus` is already the decoder's own domain
 * ("decoded" | "candidate"), so no status remapping is needed.
 */
export type ReprocessSignal = {
  chain: ChainId;
  txHash: string;
  walletId: string;
  decodeStatus: string;
  side: "buy" | "sell";
  tokenInAddress: string;
  tokenOutAddress: string;
  reason: string | null;
};

export type ReprocessChangeKind = "status" | "side" | "copy-token-address" | "newly-derived" | "missing-derived";

export type ReprocessChange = {
  key: string;
  chain: ChainId;
  txHash: string;
  walletId: string;
  kinds: ReprocessChangeKind[];
  storedStatus?: string | undefined;
  derivedStatus?: string | undefined;
  storedSide?: string | undefined;
  derivedSide?: string | undefined;
  storedCopyTokenAddress?: string | undefined;
  derivedCopyTokenAddress?: string | undefined;
  storedReason?: string | null | undefined;
  derivedReason?: string | null | undefined;
};

export type ReprocessReport = {
  summary: {
    stored: number;
    derived: number;
    changed: number;
    statusChanges: number;
    sideChanges: number;
    copyTokenAddressImprovements: number;
    newlyDerived: number;
    missingDerived: number;
  };
  changes: ReprocessChange[];
};

export function reprocessKey(signal: Pick<ReprocessSignal, "chain" | "txHash">): string {
  return `${signal.chain}|${signal.txHash.toLowerCase()}`;
}

export function summarizeReprocess(
  stored: ReprocessSignal[],
  derived: ReprocessSignal[]
): ReprocessReport {
  const storedByKey = new Map(stored.map((s) => [reprocessKey(s), s]));
  const derivedByKey = new Map(derived.map((s) => [reprocessKey(s), s]));
  const changes: ReprocessChange[] = [];
  let statusChanges = 0;
  let sideChanges = 0;
  let copyTokenAddressImprovements = 0;
  let newlyDerived = 0;
  let missingDerived = 0;

  for (const [key, derivedSignal] of derivedByKey) {
    const storedSignal = storedByKey.get(key);
    if (!storedSignal) {
      newlyDerived += 1;
      changes.push(toChange(key, undefined, derivedSignal, ["newly-derived"]));
      continue;
    }

    const kinds: ReprocessChangeKind[] = [];
    if (storedSignal.decodeStatus !== derivedSignal.decodeStatus) {
      statusChanges += 1;
      kinds.push("status");
    }
    if (storedSignal.side !== derivedSignal.side) {
      sideChanges += 1;
      kinds.push("side");
    }
    if (!copyTokenAddress(storedSignal) && copyTokenAddress(derivedSignal)) {
      copyTokenAddressImprovements += 1;
      kinds.push("copy-token-address");
    }
    if (kinds.length) changes.push(toChange(key, storedSignal, derivedSignal, kinds));
  }

  for (const [key, storedSignal] of storedByKey) {
    if (derivedByKey.has(key)) continue;
    missingDerived += 1;
    changes.push(toChange(key, storedSignal, undefined, ["missing-derived"]));
  }

  return {
    summary: {
      stored: stored.length,
      derived: derived.length,
      changed: changes.length,
      statusChanges,
      sideChanges,
      copyTokenAddressImprovements,
      newlyDerived,
      missingDerived,
    },
    changes: changes.sort((a, b) => a.key.localeCompare(b.key)),
  };
}

function toChange(
  key: string,
  stored: ReprocessSignal | undefined,
  derived: ReprocessSignal | undefined,
  kinds: ReprocessChangeKind[]
): ReprocessChange {
  const signal = derived ?? stored;
  if (!signal) throw new Error("A reprocess change needs a stored or derived signal.");

  return {
    key,
    chain: signal.chain,
    txHash: signal.txHash,
    walletId: signal.walletId,
    kinds,
    storedStatus: stored?.decodeStatus,
    derivedStatus: derived?.decodeStatus,
    storedSide: stored?.side,
    derivedSide: derived?.side,
    storedCopyTokenAddress: stored ? copyTokenAddress(stored) : undefined,
    derivedCopyTokenAddress: derived ? copyTokenAddress(derived) : undefined,
    storedReason: stored?.reason,
    derivedReason: derived?.reason,
  };
}

function copyTokenAddress(signal: Pick<ReprocessSignal, "side" | "tokenInAddress" | "tokenOutAddress">): string {
  if (signal.side === "buy") return signal.tokenOutAddress;
  if (signal.side === "sell") return signal.tokenInAddress;
  return "";
}
