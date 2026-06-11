import type { ChainId } from "@tradebot/core";

export type LedgerDelta = {
  entryType: "buy" | "sell" | "total_loss";
  cashDelta: number;
  quantityDelta: number;
  costBasisDelta: number;
  realizedPnlDelta: number;
  feeDelta: number;
};

export type LedgerEntry = {
  id: string;
  tradeId: string;
  tokenAddress: string;
  chain: ChainId;
  entryType: "buy" | "sell" | "total_loss";
  cashDelta: number;
  quantityDelta: number;
  costBasisDelta: number;
  realizedPnlDelta: number;
  feeDelta: number;
  createdAt: string;
};

export type TradeLedgerInput = {
  side: "buy" | "sell";
  quantity: number;
  priceUsd: number;
  notionalUsd: number;
  gasUsd: number;
  slippageUsd: number;
  dexFeeUsd: number;
  totalCostUsd: number;
  realizedPnlUsd: number;
};

export type PortfolioTotals = {
  cashUsd: number;
  realizedPnlUsd: number;
  feesPaidUsd: number;
};

export type PositionAggregate = {
  tokenAddress: string;
  chain: ChainId;
  quantity: number;
  averageEntryUsd: number;
  costBasisUsd: number;
  realizedPnlUsd: number;
  feesPaidUsd: number;
  updatedAt: string;
};

export type LedgerMismatch = {
  tradeId: string;
  field: string;
  expected: number;
  actual: number | null;
};

const OPEN_POSITION_EPSILON = 1e-10;
const VERIFY_EPSILON = 1e-6;

export function ledgerDeltaFromTrade(trade: TradeLedgerInput): LedgerDelta {
  const fees = trade.gasUsd + trade.slippageUsd + trade.dexFeeUsd;

  if (trade.side === "buy") {
    return {
      entryType: "buy",
      cashDelta: -trade.totalCostUsd,
      quantityDelta: trade.quantity,
      costBasisDelta: trade.notionalUsd + fees,
      realizedPnlDelta: 0,
      feeDelta: fees,
    };
  }

  const proceeds = Math.max(0, trade.notionalUsd - fees);
  const isTotalLoss = trade.priceUsd === 0 && trade.notionalUsd === 0;

  return {
    entryType: isTotalLoss ? "total_loss" : "sell",
    cashDelta: proceeds,
    quantityDelta: -trade.quantity,
    costBasisDelta: -(proceeds - trade.realizedPnlUsd),
    realizedPnlDelta: trade.realizedPnlUsd,
    feeDelta: fees,
  };
}

export function derivePortfolioTotals(entries: LedgerEntry[], startingCashUsd: number): PortfolioTotals {
  let cashUsd = startingCashUsd;
  let realizedPnlUsd = 0;
  let feesPaidUsd = 0;
  for (const item of entries) {
    cashUsd += item.cashDelta;
    realizedPnlUsd += item.realizedPnlDelta;
    feesPaidUsd += item.feeDelta;
  }
  return { cashUsd, realizedPnlUsd, feesPaidUsd };
}

export function derivePositions(entries: LedgerEntry[]): PositionAggregate[] {
  const byToken = new Map<string, PositionAggregate>();

  for (const item of entries) {
    let current = byToken.get(item.tokenAddress);
    if (!current) {
      current = {
        tokenAddress: item.tokenAddress,
        chain: item.chain,
        quantity: 0,
        averageEntryUsd: 0,
        costBasisUsd: 0,
        realizedPnlUsd: 0,
        feesPaidUsd: 0,
        updatedAt: item.createdAt,
      };
      byToken.set(item.tokenAddress, current);
    }
    current.quantity += item.quantityDelta;
    current.costBasisUsd += item.costBasisDelta;
    current.realizedPnlUsd += item.realizedPnlDelta;
    current.feesPaidUsd += item.feeDelta;
    if (item.createdAt > current.updatedAt) current.updatedAt = item.createdAt;
  }

  return Array.from(byToken.values())
    .filter((position) => position.quantity > OPEN_POSITION_EPSILON)
    .map((position) => ({
      ...position,
      averageEntryUsd: position.costBasisUsd / position.quantity,
    }))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export function verifyLedger(
  trades: Array<TradeLedgerInput & { id: string }>,
  entries: LedgerEntry[]
): { ok: boolean; mismatches: LedgerMismatch[] } {
  const entryByTrade = new Map(entries.map((item) => [item.tradeId, item]));
  const tradeIds = new Set(trades.map((item) => item.id));
  const mismatches: LedgerMismatch[] = [];

  for (const item of trades) {
    const expected = ledgerDeltaFromTrade(item);
    const stored = entryByTrade.get(item.id);
    if (!stored) {
      mismatches.push({ tradeId: item.id, field: "entry", expected: 0, actual: null });
      continue;
    }

    const checks: Array<[string, number, number]> = [
      ["cashDelta", expected.cashDelta, stored.cashDelta],
      ["quantityDelta", expected.quantityDelta, stored.quantityDelta],
      ["costBasisDelta", expected.costBasisDelta, stored.costBasisDelta],
      ["realizedPnlDelta", expected.realizedPnlDelta, stored.realizedPnlDelta],
      ["feeDelta", expected.feeDelta, stored.feeDelta],
    ];

    for (const [field, exp, act] of checks) {
      if (Math.abs(exp - act) > VERIFY_EPSILON) {
        mismatches.push({ tradeId: item.id, field, expected: exp, actual: act });
      }
    }
  }

  for (const item of entries) {
    if (!tradeIds.has(item.tradeId)) {
      mismatches.push({ tradeId: item.tradeId, field: "orphan-entry", expected: 0, actual: null });
    }
  }

  return { ok: mismatches.length === 0, mismatches };
}
