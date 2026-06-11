import { describe, expect, it } from "vitest";
import { ledgerDeltaFromTrade, derivePortfolioTotals, derivePositions, verifyLedger } from "./ledger.js";
import type { TradeLedgerInput, LedgerEntry } from "./ledger.js";

function entry(overrides: Partial<LedgerEntry>): LedgerEntry {
  return {
    id: "e",
    tradeId: "t",
    tokenAddress: "0xtoken",
    chain: "eth",
    entryType: "buy",
    cashDelta: 0,
    quantityDelta: 0,
    costBasisDelta: 0,
    realizedPnlDelta: 0,
    feeDelta: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("derivePortfolioTotals", () => {
  it("sums cash, realized pnl, and fees onto starting cash", () => {
    const totals = derivePortfolioTotals(
      [
        entry({ cashDelta: -106, feeDelta: 6 }),
        entry({ cashDelta: 56, realizedPnlDelta: 16, feeDelta: 4 }),
      ],
      10_000
    );
    expect(totals).toEqual({ cashUsd: 9_950, realizedPnlUsd: 16, feesPaidUsd: 10 });
  });
});

describe("derivePositions", () => {
  it("aggregates per token and computes average entry", () => {
    const positions = derivePositions([
      entry({ tokenAddress: "0xa", quantityDelta: 10, costBasisDelta: 106, feeDelta: 6, createdAt: "2026-01-01T00:00:00.000Z" }),
      entry({ tokenAddress: "0xa", quantityDelta: 5, costBasisDelta: 83, feeDelta: 8, createdAt: "2026-01-02T00:00:00.000Z" }),
    ]);
    expect(positions).toHaveLength(1);
    expect(positions[0]).toMatchObject({
      tokenAddress: "0xa",
      quantity: 15,
      costBasisUsd: 189,
      feesPaidUsd: 14,
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
    expect(positions[0]!.averageEntryUsd).toBeCloseTo(12.6);
  });

  it("omits fully closed positions", () => {
    const positions = derivePositions([
      entry({ tokenAddress: "0xa", quantityDelta: 100, costBasisDelta: 200 }),
      entry({ tokenAddress: "0xa", quantityDelta: -100, costBasisDelta: -200, realizedPnlDelta: -200, entryType: "total_loss" }),
    ]);
    expect(positions).toHaveLength(0);
  });

  it("produces independent aggregates for two different token addresses", () => {
    const positions = derivePositions([
      entry({ tokenAddress: "0xa", quantityDelta: 10, costBasisDelta: 100, createdAt: "2026-01-03T00:00:00.000Z" }),
      entry({ tokenAddress: "0xa", quantityDelta: 5, costBasisDelta: 50, createdAt: "2026-01-04T00:00:00.000Z" }),
      entry({ tokenAddress: "0xb", quantityDelta: 20, costBasisDelta: 400, createdAt: "2026-01-02T00:00:00.000Z" }),
    ]);
    expect(positions).toHaveLength(2);
    // 0xa has the latest updatedAt so it sorts first (descending)
    expect(positions[0]).toMatchObject({ tokenAddress: "0xa", quantity: 15, costBasisUsd: 150 });
    expect(positions[1]).toMatchObject({ tokenAddress: "0xb", quantity: 20, costBasisUsd: 400 });
  });
});

function trade(overrides: Partial<TradeLedgerInput>): TradeLedgerInput {
  return {
    side: "buy",
    quantity: 10,
    priceUsd: 10,
    notionalUsd: 100,
    gasUsd: 5,
    slippageUsd: 1,
    dexFeeUsd: 0,
    totalCostUsd: 106,
    realizedPnlUsd: 0,
    ...overrides,
  };
}

describe("ledgerDeltaFromTrade", () => {
  it("derives a buy delta with fees folded into cost basis", () => {
    expect(ledgerDeltaFromTrade(trade({}))).toEqual({
      entryType: "buy",
      cashDelta: -106,
      quantityDelta: 10,
      costBasisDelta: 106,
      realizedPnlDelta: 0,
      feeDelta: 6,
    });
  });

  it("derives a sell delta with proceeds net of fees", () => {
    const delta = ledgerDeltaFromTrade(
      trade({ side: "sell", quantity: 4, notionalUsd: 60, gasUsd: 3, slippageUsd: 1, dexFeeUsd: 0, totalCostUsd: 4, realizedPnlUsd: 16 })
    );
    expect(delta).toEqual({
      entryType: "sell",
      cashDelta: 56,
      quantityDelta: -4,
      costBasisDelta: -40,
      realizedPnlDelta: 16,
      feeDelta: 4,
    });
  });

  it("classifies a zero-price sell as a total loss", () => {
    const delta = ledgerDeltaFromTrade(
      trade({ side: "sell", quantity: 100, priceUsd: 0, notionalUsd: 0, gasUsd: 0, slippageUsd: 0, dexFeeUsd: 0, totalCostUsd: 0, realizedPnlUsd: -200 })
    );
    expect(delta).toEqual({
      entryType: "total_loss",
      cashDelta: 0,
      quantityDelta: -100,
      costBasisDelta: -200,
      realizedPnlDelta: -200,
      feeDelta: 0,
    });
  });
});

describe("verifyLedger", () => {
  const buyTrade = { id: "t1", ...trade({}) };

  it("passes when each trade has a matching entry", () => {
    const entries = [entry({ tradeId: "t1", cashDelta: -106, quantityDelta: 10, costBasisDelta: 106, realizedPnlDelta: 0, feeDelta: 6 })];
    const result = verifyLedger([buyTrade], entries);
    expect(result.ok).toBe(true);
    expect(result.mismatches).toEqual([]);
  });

  it("flags a missing entry", () => {
    const result = verifyLedger([buyTrade], []);
    expect(result.ok).toBe(false);
    expect(result.mismatches).toContainEqual({ tradeId: "t1", field: "entry", expected: 0, actual: null });
  });

  it("flags a tampered delta", () => {
    const entries = [entry({ tradeId: "t1", cashDelta: -999, quantityDelta: 10, costBasisDelta: 106, realizedPnlDelta: 0, feeDelta: 6 })];
    const result = verifyLedger([buyTrade], entries);
    expect(result.ok).toBe(false);
    expect(result.mismatches).toContainEqual({ tradeId: "t1", field: "cashDelta", expected: -106, actual: -999 });
  });

  it("flags an orphan entry with no trade", () => {
    const entries = [entry({ tradeId: "ghost", cashDelta: 1 })];
    const result = verifyLedger([], entries);
    expect(result.ok).toBe(false);
    expect(result.mismatches).toContainEqual({ tradeId: "ghost", field: "orphan-entry", expected: 0, actual: null });
  });
});
