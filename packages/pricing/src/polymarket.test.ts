import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __polymarketCacheSize,
  __polymarketMarketStatusCacheSize,
  clearPolymarketPriceCache,
  getPolymarketMarketStatus,
  getPolymarketMarketStatusByEventSlug,
  getPolymarketPrice,
  getPolymarketResolutionPayout,
} from "./polymarket.js";

const BASE = "https://clob.polymarket.com";
const GAMMA_BASE = "https://gamma-api.polymarket.com";
const TOKEN_ID = "71321045679252212594626385532706912750332728571942532289631379312455583992563";
const CONDITION_ID = "0x" + "ab".repeat(32);

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function calledUrl(fetchImpl: ReturnType<typeof vi.fn>, index: number): string {
  return String((fetchImpl.mock.calls[index] as unknown[])[0]);
}

describe("getPolymarketPrice", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    clearPolymarketPriceCache();
  });

  it("returns best ask for buys and best bid for sells from the two /price sides", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      const side = new URL(url).searchParams.get("side");
      return jsonResponse(side === "BUY" ? { price: 0.45 } : { price: 0.46 });
    });

    const buy = await getPolymarketPrice(TOKEN_ID, "buy", {
      baseUrl: BASE,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxSpreadBps: 500,
    });
    const sell = await getPolymarketPrice(TOKEN_ID, "sell", {
      baseUrl: BASE,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxSpreadBps: 500,
    });

    expect(buy).toMatchObject({
      tokenId: TOKEN_ID,
      side: "buy",
      source: "polymarket-clob",
      price: 0.46,
      bestBid: 0.45,
      bestAsk: 0.46,
      maxSpreadBps: 500,
    });
    expect(buy?.spread).toBeCloseTo(0.01, 12);
    expect(buy?.spreadBps).toBeCloseTo((0.01 / 0.455) * 10_000, 6);
    expect(sell?.price).toBe(0.45);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("normalizes the token id and sends token_id + side query params", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      const side = new URL(url).searchParams.get("side");
      return jsonResponse({ price: side === "BUY" ? 0.12 : 0.13 });
    });

    await getPolymarketPrice(TOKEN_ID.toUpperCase(), "buy", { baseUrl: BASE, fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(calledUrl(fetchImpl, 0)).toContain(`/price?token_id=${TOKEN_ID}&side=BUY`);
    expect(calledUrl(fetchImpl, 1)).toContain(`/price?token_id=${TOKEN_ID}&side=SELL`);
  });

  it("returns null and logs when the response body is malformed", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      const side = new URL(url).searchParams.get("side");
      return jsonResponse(side === "BUY" ? { price: 0.45 } : { nope: true });
    });

    const result = await getPolymarketPrice(TOKEN_ID, "buy", { baseUrl: BASE, fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(result).toBeNull();
  });

  it("returns null on a non-200 response", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "nope" }, 500));

    const result = await getPolymarketPrice(TOKEN_ID, "buy", { baseUrl: BASE, fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(result).toBeNull();
  });

  it("reuses a fresh cached quote for repeated lookups of the same token", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      const side = new URL(url).searchParams.get("side");
      return jsonResponse(side === "BUY" ? { price: 0.30 } : { price: 0.31 });
    });

    await getPolymarketPrice(TOKEN_ID, "buy", { baseUrl: BASE, fetchImpl: fetchImpl as unknown as typeof fetch });
    await getPolymarketPrice(TOKEN_ID, "sell", { baseUrl: BASE, fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(__polymarketCacheSize()).toBe(1);
  });

  it("caps the quote cache and evicts the oldest token", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      const side = new URL(url).searchParams.get("side");
      return jsonResponse(side === "BUY" ? { price: 0.40 } : { price: 0.41 });
    });

    const total = 5_005;
    for (let i = 0; i < total; i++) {
      await getPolymarketPrice(`token-${i}`, "buy", { baseUrl: BASE, fetchImpl: fetchImpl as unknown as typeof fetch });
    }

    expect(__polymarketCacheSize()).toBe(5_000);

    fetchImpl.mockClear();
    await getPolymarketPrice("token-0", "buy", { baseUrl: BASE, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    fetchImpl.mockClear();
    await getPolymarketPrice(`token-${total - 1}`, "sell", { baseUrl: BASE, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("getPolymarketMarketStatus", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    clearPolymarketPriceCache();
  });

  it("parses a matching market row from Gamma and normalizes the status flags", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([{
      conditionId: CONDITION_ID.toUpperCase(),
      active: false,
      closed: true,
      resolved: true,
      accepting_orders: false,
      outcomes: "[\"Yes\",\"No\"]",
      outcomePrices: "[\"1\",\"0\"]",
      clobTokenIds: "[\"yes-token\",\"no-token\"]",
    }]));

    const result = await getPolymarketMarketStatus(CONDITION_ID, {
      baseUrl: GAMMA_BASE,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toMatchObject({
      conditionId: CONDITION_ID,
      source: "polymarket-gamma",
      active: false,
      closed: true,
      resolved: true,
      acceptingOrders: false,
      outcomes: ["Yes", "No"],
      outcomePrices: [1, 0],
      clobTokenIds: ["yes-token", "no-token"],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String((fetchImpl.mock.calls[0] as unknown[])[0])).toContain(`/markets?condition_id=${encodeURIComponent(CONDITION_ID)}`);
  });

  it("falls back to the alternate query param when the first Gamma query misses", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: "not found" }, 404))
      .mockResolvedValueOnce(jsonResponse({
        data: [{ condition_id: CONDITION_ID, active: "true", closed: "false", resolved: "false" }],
      }));

    const result = await getPolymarketMarketStatus(CONDITION_ID, {
      baseUrl: GAMMA_BASE,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toMatchObject({
      conditionId: CONDITION_ID,
      active: true,
      closed: false,
      resolved: false,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String((fetchImpl.mock.calls[1] as unknown[])[0])).toContain(`conditionId=${encodeURIComponent(CONDITION_ID)}`);
  });

  it("reuses the cached market status for repeated reads of the same condition", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([{ conditionId: CONDITION_ID, active: true, closed: false, resolved: false }]));

    await getPolymarketMarketStatus(CONDITION_ID, {
      baseUrl: GAMMA_BASE,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await getPolymarketMarketStatus(CONDITION_ID, {
      baseUrl: GAMMA_BASE,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(__polymarketMarketStatusCacheSize()).toBe(1);
  });

  it("does not use an unrelated Gamma market when the condition filter is ignored", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([
      { conditionId: "0x0000000000000000000000000000000000000000000000000000000000000000", active: true, closed: false, resolved: false },
    ]));

    const result = await getPolymarketMarketStatus(CONDITION_ID, {
      baseUrl: GAMMA_BASE,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toBeNull();
  });

  it("finds a matching condition inside a Gamma event slug response", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      slug: "event-slug",
      markets: [
        { conditionId: "0xother", active: true, closed: false, resolved: false },
        {
          conditionId: CONDITION_ID,
          active: true,
          closed: true,
          resolved: false,
          outcomes: "[\"Yes\",\"No\"]",
          outcomePrices: "[\"0\",\"1\"]",
          clobTokenIds: "[\"yes-token\",\"no-token\"]",
        },
      ],
    }));

    const result = await getPolymarketMarketStatusByEventSlug(CONDITION_ID, "event-slug", {
      baseUrl: GAMMA_BASE,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toMatchObject({
      conditionId: CONDITION_ID,
      closed: true,
      outcomePrices: [0, 1],
      clobTokenIds: ["yes-token", "no-token"],
    });
    expect(calledUrl(fetchImpl, 0)).toContain("/events?slug=event-slug");
  });
});

describe("getPolymarketResolutionPayout", () => {
  it("returns the terminal payout for a settled outcome", () => {
    expect(getPolymarketResolutionPayout({
      closed: true,
      resolved: false,
      outcomePrices: [1, 0],
    }, 0)).toBe(1);
    expect(getPolymarketResolutionPayout({
      closed: true,
      resolved: false,
      outcomePrices: [1, 0],
    }, 1)).toBe(0);
  });

  it("returns null for ambiguous or non-terminal markets", () => {
    expect(getPolymarketResolutionPayout({
      closed: true,
      resolved: false,
      outcomePrices: [0.5, 0.5],
    }, 0)).toBeNull();
    expect(getPolymarketResolutionPayout({
      closed: false,
      resolved: false,
      outcomePrices: [1, 0],
    }, 0)).toBeNull();
  });
});
