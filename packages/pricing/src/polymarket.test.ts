import { beforeEach, describe, expect, it, vi } from "vitest";
import { __polymarketCacheSize, clearPolymarketPriceCache, getPolymarketPrice } from "./polymarket.js";

const BASE = "https://clob.polymarket.com";
const TOKEN_ID = "71321045679252212594626385532706912750332728571942532289631379312455583992563";

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
