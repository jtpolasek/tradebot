import { describe, it, expect } from "vitest";
import { derivePortfolioAnalytics, type AnalyticsPosition, type FillAggregate } from "./analytics.js";

const HOUR = 3_600_000;
const base = new Date("2026-06-01T00:00:00Z").getTime();

function pos(overrides: Partial<AnalyticsPosition> & { tokenAddress: string }): AnalyticsPosition {
  return {
    chain: "eth",
    symbol: "TKN",
    qty: 0,
    avgCostUsd: 0,
    realizedPnlUsd: 0,
    openedAt: new Date(base),
    closedAt: null,
    ...overrides,
  };
}

describe("derivePortfolioAnalytics", () => {
  it("computes win rate, realized PnL, hold time and exposure from positions", () => {
    const positions: AnalyticsPosition[] = [
      // closed winner: held 2h
      pos({ tokenAddress: "0xa", symbol: "AAA", realizedPnlUsd: 100, openedAt: new Date(base), closedAt: new Date(base + 2 * HOUR) }),
      // closed loser: held 4h
      pos({ tokenAddress: "0xb", symbol: "BBB", realizedPnlUsd: -40, openedAt: new Date(base), closedAt: new Date(base + 4 * HOUR) }),
      // open position with partial realized PnL + exposure (qty 10 @ $5 = $50 cost basis)
      pos({ tokenAddress: "0xc", symbol: "CCC", realizedPnlUsd: 10, qty: 10, avgCostUsd: 5, closedAt: null }),
    ];
    const fills: FillAggregate = { copiedFills: 8, skippedFills: 2, totalFeesUsd: 30, totalNotionalUsd: 1000 };

    const a = derivePortfolioAnalytics(positions, fills);

    expect(a.closedTrades).toBe(2);
    expect(a.winningTrades).toBe(1);
    expect(a.losingTrades).toBe(1);
    expect(a.winRate).toBe(0.5);
    expect(a.realizedPnlUsd).toBe(70); // 100 - 40 + 10
    expect(a.averageHoldHours).toBe(3); // (2 + 4) / 2
    expect(a.openExposureUsd).toBe(50);
    expect(a.feeDrag).toBeCloseTo(0.03, 10); // 30 / 1000
    expect(a.skipRate).toBeCloseTo(0.2, 10); // 2 / 10
    expect(a.copiedFills).toBe(8);
  });

  it("rolls realized PnL up by token, sorted best-first", () => {
    const positions: AnalyticsPosition[] = [
      pos({ tokenAddress: "0xa", symbol: "AAA", realizedPnlUsd: 30, closedAt: new Date(base + HOUR) }),
      pos({ tokenAddress: "0xa", symbol: "AAA", realizedPnlUsd: -10, closedAt: new Date(base + HOUR) }),
      pos({ tokenAddress: "0xb", symbol: "BBB", realizedPnlUsd: 50, closedAt: new Date(base + HOUR) }),
    ];
    const a = derivePortfolioAnalytics(positions, { copiedFills: 0, skippedFills: 0, totalFeesUsd: 0, totalNotionalUsd: 0 });

    expect(a.byToken).toHaveLength(2);
    expect(a.byToken[0]).toMatchObject({ symbol: "BBB", realizedPnlUsd: 50, closedTrades: 1 });
    expect(a.byToken[1]).toMatchObject({ symbol: "AAA", realizedPnlUsd: 20, closedTrades: 2 });
  });

  it("returns null ratios when there is no data", () => {
    const a = derivePortfolioAnalytics([], { copiedFills: 0, skippedFills: 0, totalFeesUsd: 0, totalNotionalUsd: 0 });
    expect(a.winRate).toBeNull();
    expect(a.feeDrag).toBeNull();
    expect(a.skipRate).toBeNull();
    expect(a.averageHoldHours).toBeNull();
    expect(a.byToken).toEqual([]);
  });
});
