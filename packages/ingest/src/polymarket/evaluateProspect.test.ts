import { describe, expect, it, vi } from "vitest";
import { evaluateProspect, type EvaluateProspectOptions } from "./evaluateProspect.js";
import type { PolymarketTrade } from "./client.js";
import type { Nomination } from "./nominator.js";

const BASE = "https://data-api.polymarket.com";
const NOW_MS = Date.UTC(2026, 5, 28);
const DAY_MS = 86_400_000;

const defaultNomination: Nomination = {
  address: "0xAAA1111111111111111111111111111111111111",
  source: "leaderboard",
  userName: "alice",
  xUsername: "alice_x",
  pnlUsd: 10_000,
  volUsd: 100_000,
};

const defaultOpts: EvaluateProspectOptions = {
  baseUrl: BASE,
  minPnlUsd: 10_000,
  minPnlPerVol: 0.03,
  minTrades: 20,
  recencyDays: 14,
  nowMs: NOW_MS,
};

function nomination(overrides: Partial<Nomination> = {}): Nomination {
  return { ...defaultNomination, ...overrides };
}

function trade(overrides: Partial<PolymarketTrade> = {}): PolymarketTrade {
  return {
    proxyWallet: defaultNomination.address,
    side: "BUY",
    asset: "123",
    conditionId: "0xcondition",
    size: 10,
    price: 0.5,
    timestamp: Math.floor(NOW_MS / 1000),
    title: "Will test pass?",
    slug: "will-test-pass",
    eventSlug: "test-event",
    outcome: "Yes",
    outcomeIndex: 0,
    transactionHash: "0xtx",
    ...overrides,
  };
}

function trades(count: number, newestTsMs = NOW_MS): PolymarketTrade[] {
  return Array.from({ length: count }, (_, i) =>
    trade({ timestamp: Math.floor((newestTsMs - i * 1000) / 1000) })
  );
}

describe("evaluateProspect", () => {
  it("accepts a prospect at every gate boundary", async () => {
    const fetchTradesFn = vi.fn(async () => trades(20, NOW_MS - 14 * DAY_MS));
    const result = await evaluateProspect(nomination({ pnlUsd: 10_000, volUsd: 333_333.3333333333 }), {
      ...defaultOpts,
      fetchTradesFn,
    });

    expect(result).toMatchObject({
      address: defaultNomination.address.toLowerCase(),
      verdict: "promoted",
      rejectReason: null,
      tradeCount: 20,
      lastTradeTs: NOW_MS - 14 * DAY_MS,
    });
    expect(result.pnlPerVol).toBeCloseTo(0.03);
    expect(fetchTradesFn).toHaveBeenCalledWith(BASE, defaultNomination.address.toLowerCase(), { limit: 100 });
  });

  it("rejects below the pnl floor without fetching trades", async () => {
    const fetchTradesFn = vi.fn(async () => trades(20));
    const result = await evaluateProspect(nomination({ pnlUsd: 9_999 }), {
      ...defaultOpts,
      fetchTradesFn,
    });

    expect(result.verdict).toBe("rejected");
    expect(result.rejectReason).toBe("pnl_below_min");
    expect(result.tradeCount).toBeNull();
    expect(fetchTradesFn).not.toHaveBeenCalled();
  });

  it("rejects below the pnl-per-volume floor without fetching trades", async () => {
    const fetchTradesFn = vi.fn(async () => trades(20));
    const result = await evaluateProspect(nomination({ pnlUsd: 10_000, volUsd: 400_000 }), {
      ...defaultOpts,
      fetchTradesFn,
    });

    expect(result.verdict).toBe("rejected");
    expect(result.rejectReason).toBe("pnl_per_vol_below_min");
    expect(result.pnlPerVol).toBe(0.025);
    expect(fetchTradesFn).not.toHaveBeenCalled();
  });

  it("uses max(volume, 1) for the pnl-per-volume denominator", async () => {
    const fetchTradesFn = vi.fn(async () => trades(20));
    const result = await evaluateProspect(nomination({ pnlUsd: 10_000, volUsd: 0 }), {
      ...defaultOpts,
      fetchTradesFn,
    });

    expect(result.verdict).toBe("promoted");
    expect(result.pnlPerVol).toBe(10_000);
  });

  it("rejects below the minimum trade sample", async () => {
    const fetchTradesFn = vi.fn(async () => trades(19));
    const result = await evaluateProspect(nomination(), {
      ...defaultOpts,
      fetchTradesFn,
    });

    expect(result.verdict).toBe("rejected");
    expect(result.rejectReason).toBe("trade_count_below_min");
    expect(result.tradeCount).toBe(19);
  });

  it("rejects when newest trade is older than the recency window", async () => {
    const oldTs = NOW_MS - 14 * DAY_MS - 1000;
    const fetchTradesFn = vi.fn(async () => trades(20, oldTs));
    const result = await evaluateProspect(nomination(), {
      ...defaultOpts,
      fetchTradesFn,
    });

    expect(result.verdict).toBe("rejected");
    expect(result.rejectReason).toBe("last_trade_too_old");
    expect(result.lastTradeTs).toBe(oldTs);
  });

  it("sorts out-of-order trades by newest timestamp", async () => {
    const newer = NOW_MS - 60_000;
    const older = NOW_MS - 120_000;
    const fetchTradesFn = vi.fn(async () => [
      trade({ timestamp: older / 1000 }),
      ...trades(18, older - 1000),
      trade({ timestamp: newer / 1000 }),
    ]);
    const result = await evaluateProspect(nomination(), {
      ...defaultOpts,
      fetchTradesFn,
    });

    expect(result.verdict).toBe("promoted");
    expect(result.lastTradeTs).toBe(newer);
  });

  it("adds a corroboration score boost without changing gates", async () => {
    const fetchTradesFn = vi.fn(async () => trades(20));
    const plain = await evaluateProspect(nomination({ corroborated: false }), {
      ...defaultOpts,
      fetchTradesFn,
    });
    const boosted = await evaluateProspect(nomination({ corroborated: true }), {
      ...defaultOpts,
      fetchTradesFn,
    });

    expect(boosted.verdict).toBe("promoted");
    expect(boosted.score).toBeCloseTo(plain.score * 1.1);
  });

  it("only fetches trades, so flat positions/value responses cannot reject", async () => {
    const seenUrls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      seenUrls.push(url);
      return { ok: true, status: 200, json: async () => trades(20) } as Response;
    });
    const result = await evaluateProspect(nomination(), {
      ...defaultOpts,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.verdict).toBe("promoted");
    expect(seenUrls).toHaveLength(1);
    expect(seenUrls[0]).toContain("/trades?");
    expect(seenUrls[0]).not.toContain("/positions");
    expect(seenUrls[0]).not.toContain("/value");
  });
});