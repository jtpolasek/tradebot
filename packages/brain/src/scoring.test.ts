import { describe, it, expect } from "vitest";
import { fifoRoundTrips, computeScoringResult } from "./scoring.js";
import type { TradeRow } from "./scoring.js";

const BASE_DATE = new Date("2024-01-01T00:00:00Z");
function minutesLater(m: number): Date {
  return new Date(BASE_DATE.getTime() + m * 60_000);
}

function row(
  side: "buy" | "sell",
  qty: number,
  priceUsd: number,
  minuteOffset: number
): TradeRow {
  return {
    side,
    tokenAddress: "0xtoken",
    chain: "eth",
    qty,
    priceUsd,
    observedAt: minutesLater(minuteOffset),
  };
}

describe("fifoRoundTrips", () => {
  it("simple single round trip", () => {
    const trades: TradeRow[] = [
      row("buy", 100, 10, 0),
      row("sell", 100, 12, 60),
    ];
    const rts = fifoRoundTrips(trades);
    expect(rts).toHaveLength(1);
    const rt = rts[0]!;
    expect(rt.entryQty).toBeCloseTo(100);
    expect(rt.entryPriceUsd).toBe(10);
    expect(rt.exitPriceUsd).toBe(12);
    expect(rt.returnPct).toBeCloseTo(20);
    expect(rt.pnlUsd).toBeCloseTo(200);
    expect(rt.holdMinutes).toBeCloseTo(60);
  });

  it("partial sell — only matched portion becomes a round trip", () => {
    const trades: TradeRow[] = [
      row("buy", 100, 10, 0),
      row("sell", 40, 15, 30),
    ];
    const rts = fifoRoundTrips(trades);
    expect(rts).toHaveLength(1);
    expect(rts[0]!.entryQty).toBeCloseTo(40);
    expect(rts[0]!.pnlUsd).toBeCloseTo(40 * (15 - 10)); // 200
  });

  it("multiple lots — FIFO order respected", () => {
    // Lot 1: buy 100 @ $10, Lot 2: buy 50 @ $12
    // Sell 120 @ $11 → consumes all of lot 1 (100) + 20 from lot 2
    const trades: TradeRow[] = [
      row("buy", 100, 10, 0),
      row("buy", 50, 12, 10),
      row("sell", 120, 11, 120),
    ];
    const rts = fifoRoundTrips(trades);
    expect(rts).toHaveLength(2);

    // Lot 1: 100 @ $10 → sold @ $11 → +$100, return 10%
    const rt1 = rts[0]!;
    expect(rt1.entryQty).toBeCloseTo(100);
    expect(rt1.entryPriceUsd).toBe(10);
    expect(rt1.exitPriceUsd).toBe(11);
    expect(rt1.returnPct).toBeCloseTo(10);
    expect(rt1.pnlUsd).toBeCloseTo(100);

    // Lot 2 partial: 20 @ $12 → sold @ $11 → -$20, return -8.33%
    const rt2 = rts[1]!;
    expect(rt2.entryQty).toBeCloseTo(20);
    expect(rt2.entryPriceUsd).toBe(12);
    expect(rt2.exitPriceUsd).toBe(11);
    expect(rt2.returnPct).toBeCloseTo(-8.333, 2);
    expect(rt2.pnlUsd).toBeCloseTo(-20);
  });

  it("open remainder marked at current price", () => {
    const trades: TradeRow[] = [
      row("buy", 100, 10, 0),
    ];
    const markPrices = new Map([["eth:0xtoken", 15]]);
    const rts = fifoRoundTrips(trades, markPrices);
    expect(rts).toHaveLength(1);
    expect(rts[0]!.entryQty).toBeCloseTo(100);
    expect(rts[0]!.exitPriceUsd).toBe(15);
    expect(rts[0]!.returnPct).toBeCloseTo(50);
    expect(rts[0]!.pnlUsd).toBeCloseTo(500);
  });

  it("no mark price for open lot → no round trip", () => {
    const trades: TradeRow[] = [
      row("buy", 100, 10, 0),
    ];
    const rts = fifoRoundTrips(trades); // no markPrices
    expect(rts).toHaveLength(0);
  });

  it("multiple tokens tracked independently", () => {
    const tradesA: TradeRow[] = [
      { side: "buy", tokenAddress: "0xaaa", chain: "eth", qty: 50, priceUsd: 1, observedAt: minutesLater(0) },
      { side: "sell", tokenAddress: "0xaaa", chain: "eth", qty: 50, priceUsd: 2, observedAt: minutesLater(60) },
    ];
    const tradesB: TradeRow[] = [
      { side: "buy", tokenAddress: "0xbbb", chain: "eth", qty: 10, priceUsd: 5, observedAt: minutesLater(5) },
      { side: "sell", tokenAddress: "0xbbb", chain: "eth", qty: 10, priceUsd: 4, observedAt: minutesLater(65) },
    ];
    const rts = fifoRoundTrips([...tradesA, ...tradesB]);
    expect(rts).toHaveLength(2);
    const pnls = rts.map((r) => r.pnlUsd).sort((a, b) => a - b);
    expect(pnls[0]).toBeCloseTo(-10); // token B lost $10
    expect(pnls[1]).toBeCloseTo(50);  // token A gained $50
  });
});

describe("computeScoringResult", () => {
  it("zero trades → all nulls", () => {
    const result = computeScoringResult("wallet1", "7d", []);
    expect(result.trades).toBe(0);
    expect(result.winRate).toBeNull();
    expect(result.realizedPnlUsd).toBeNull();
  });

  it("computes metrics from round trips", () => {
    // 3 wins, 1 loss
    const rts = [
      { tokenAddress: "0xt", chain: "eth" as const, entryQty: 100, entryPriceUsd: 10, exitPriceUsd: 12, openedAt: minutesLater(0), closedAt: minutesLater(60), holdMinutes: 60, returnPct: 20, pnlUsd: 200 },
      { tokenAddress: "0xt", chain: "eth" as const, entryQty: 100, entryPriceUsd: 10, exitPriceUsd: 11, openedAt: minutesLater(60), closedAt: minutesLater(120), holdMinutes: 60, returnPct: 10, pnlUsd: 100 },
      { tokenAddress: "0xt", chain: "eth" as const, entryQty: 100, entryPriceUsd: 10, exitPriceUsd: 13, openedAt: minutesLater(120), closedAt: minutesLater(240), holdMinutes: 120, returnPct: 30, pnlUsd: 300 },
      { tokenAddress: "0xt", chain: "eth" as const, entryQty: 100, entryPriceUsd: 10, exitPriceUsd: 8,  openedAt: minutesLater(240), closedAt: minutesLater(300), holdMinutes: 60, returnPct: -20, pnlUsd: -200 },
    ];

    const result = computeScoringResult("wallet1", "30d", rts);
    expect(result.trades).toBe(4);
    expect(result.winRate).toBeCloseTo(0.75);
    expect(result.avgReturnPct).toBeCloseTo((20 + 10 + 30 - 20) / 4); // 10
    expect(result.realizedPnlUsd).toBeCloseTo(400);
    // median of [60, 60, 60, 120] sorted = [60, 60, 60, 120] → (60+60)/2 = 60
    expect(result.medianHoldMinutes).toBeCloseTo(60);
  });

  it("computes max drawdown correctly", () => {
    // cumPnl series: 100, 200, 50, 150
    // peak goes: 100, 200, 200, 200
    // drawdown: 0, 0, (200-50)/200*100=75%, (200-150)/200*100=25%
    const rts = [
      { tokenAddress: "0xt", chain: "eth" as const, entryQty: 1, entryPriceUsd: 1, exitPriceUsd: 2, openedAt: minutesLater(0), closedAt: minutesLater(10), holdMinutes: 10, returnPct: 100, pnlUsd: 100 },
      { tokenAddress: "0xt", chain: "eth" as const, entryQty: 1, entryPriceUsd: 1, exitPriceUsd: 2, openedAt: minutesLater(10), closedAt: minutesLater(20), holdMinutes: 10, returnPct: 100, pnlUsd: 100 },
      { tokenAddress: "0xt", chain: "eth" as const, entryQty: 1, entryPriceUsd: 2, exitPriceUsd: 0.75, openedAt: minutesLater(20), closedAt: minutesLater(30), holdMinutes: 10, returnPct: -62.5, pnlUsd: -150 },
      { tokenAddress: "0xt", chain: "eth" as const, entryQty: 1, entryPriceUsd: 1, exitPriceUsd: 2, openedAt: minutesLater(30), closedAt: minutesLater(40), holdMinutes: 10, returnPct: 100, pnlUsd: 100 },
    ];
    const result = computeScoringResult("wallet1", "all", rts);
    expect(result.maxDrawdownPct).toBeCloseTo(75);
  });
});
