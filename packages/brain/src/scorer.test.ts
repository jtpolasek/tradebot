import { describe, expect, it, vi } from "vitest";
import { NATIVE_TOKEN_PLACEHOLDER, WETH } from "@tradebot/core";
import { baselineWeightForTradeCount, resolveQuoteUsdPrice, scoreResultAgainstCohort, tokenDecimalsForScoring } from "./scorer.js";
import type { ScoringResult } from "./scoring.js";

describe("baselineWeightForTradeCount", () => {
  it("uses 0.5 weight while the leader has fewer than five trades", () => {
    expect(baselineWeightForTradeCount(0)).toBe(0.5);
    expect(baselineWeightForTradeCount(4)).toBe(0.5);
  });

  it("uses neutral 1.0 weight once the leader reaches five trades", () => {
    expect(baselineWeightForTradeCount(5)).toBe(1.0);
    expect(baselineWeightForTradeCount(20)).toBe(1.0);
  });
});

describe("scoreResultAgainstCohort", () => {
  function result(overrides: Partial<ScoringResult>): ScoringResult {
    return {
      walletId: "wallet",
      window: "7d",
      trades: 5,
      winRate: 0.5,
      avgReturnPct: 0,
      medianHoldMinutes: 10,
      realizedPnlUsd: 0,
      maxDrawdownPct: 0,
      ...overrides,
    };
  }

  it("computes z-scores from the current run's cohort", () => {
    const target = result({
      walletId: "target",
      realizedPnlUsd: 200,
      winRate: 0.8,
      avgReturnPct: 20,
      maxDrawdownPct: 5,
    });
    const cohort = [
      result({ walletId: "low", realizedPnlUsd: -100, winRate: 0.2, avgReturnPct: -10, maxDrawdownPct: 40 }),
      target,
      result({ walletId: "mid", realizedPnlUsd: 50, winRate: 0.5, avgReturnPct: 5, maxDrawdownPct: 20 }),
    ];

    const scored = scoreResultAgainstCohort(target, cohort);

    expect(scored.score).toBeGreaterThan(0.9);
    expect(scored.weight).toBeGreaterThan(1.4);
  });

  it("keeps the baseline weight until a leader has enough trades", () => {
    expect(scoreResultAgainstCohort(result({ trades: 4 }), [])).toEqual({
      score: null,
      weight: 0.5,
    });
  });
});

describe("resolveQuoteUsdPrice", () => {
  const db = {} as never;
  const rpcClient = { readContract: vi.fn() };
  const baseCbBtc = "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf";

  it("keeps stablecoin quotes fixed at $1", async () => {
    const latestMarkLookup = vi.fn();
    const quotePriceLookup = vi.fn();

    await expect(resolveQuoteUsdPrice({
      db,
      chain: "base",
      address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      latestMarkLookup,
      quotePriceLookup,
    })).resolves.toBe(1);

    expect(latestMarkLookup).not.toHaveBeenCalled();
    expect(quotePriceLookup).not.toHaveBeenCalled();
  });

  it("prices cbBTC through live pricing instead of treating it as $1", async () => {
    const latestMarkLookup = vi.fn().mockResolvedValue(null);
    const quotePriceLookup = vi.fn().mockResolvedValue(102_500);

    await expect(resolveQuoteUsdPrice({
      db,
      chain: "base",
      address: baseCbBtc,
      rpcClient,
      latestMarkLookup,
      quotePriceLookup,
    })).resolves.toBe(102_500);

    expect(quotePriceLookup).toHaveBeenCalledWith("base", baseCbBtc, rpcClient);
  });

  it("uses a WETH mark for native ETH quote placeholders without requiring an open WETH position", async () => {
    const latestMarkLookup = vi.fn().mockResolvedValue({ priceUsd: 3_400 });
    const quotePriceLookup = vi.fn();

    await expect(resolveQuoteUsdPrice({
      db,
      chain: "eth",
      address: NATIVE_TOKEN_PLACEHOLDER,
      latestMarkLookup,
      quotePriceLookup,
    })).resolves.toBe(3_400);

    expect(latestMarkLookup).toHaveBeenCalledWith(db, "eth", WETH.eth);
    expect(quotePriceLookup).not.toHaveBeenCalled();
  });

  it("returns null for non-stable quotes when neither marks nor live pricing are available", async () => {
    await expect(resolveQuoteUsdPrice({
      db,
      chain: "base",
      address: baseCbBtc,
      latestMarkLookup: vi.fn().mockResolvedValue(null),
      quotePriceLookup: vi.fn().mockResolvedValue(null),
    })).resolves.toBeNull();
  });
});

describe("tokenDecimalsForScoring", () => {
  it("uses 18 decimals for native ETH placeholders even when the token table has no row", () => {
    expect(tokenDecimalsForScoring(NATIVE_TOKEN_PLACEHOLDER, undefined, 6)).toBe(18);
  });

  it("uses 18 decimals for WETH even if metadata is missing", () => {
    expect(tokenDecimalsForScoring(WETH.base, undefined, 6)).toBe(18);
  });

  it("uses stored decimals for ordinary tokens", () => {
    expect(tokenDecimalsForScoring("0x1111111111111111111111111111111111111111", 9, 18)).toBe(9);
  });
});
