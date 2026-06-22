import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the store so the watcher tests never touch a real DB.
const {
  insertSignal,
  upsertToken,
  upsertLastBlock,
  getActiveWallets,
  getPolymarketPollCursors,
  upsertPolymarketPollFailure,
  upsertPolymarketPollSuccess,
} = vi.hoisted(() => ({
  insertSignal: vi.fn(async () => "signal-id"),
  upsertToken: vi.fn(async () => undefined),
  upsertLastBlock: vi.fn(async () => undefined),
  getActiveWallets: vi.fn(async () => [] as { id: string; address: string }[]),
  getPolymarketPollCursors: vi.fn(async () => [] as { walletId: string; cursorTimestamp: number; cursorKeys: string[] }[]),
  upsertPolymarketPollFailure: vi.fn(async () => undefined),
  upsertPolymarketPollSuccess: vi.fn(async () => undefined),
}));
vi.mock("@tradebot/store", () => ({
  insertSignal,
  upsertToken,
  upsertLastBlock,
  getActiveWallets,
  getPolymarketPollCursors,
  upsertPolymarketPollFailure,
  upsertPolymarketPollSuccess,
}));

import { fetchTrades, PolymarketTradeSchema, type PolymarketTrade } from "./client.js";
import { tradeToSignal, PolymarketWatcher, POLYGON_USDC } from "./watcher.js";

const BASE = "https://data-api.polymarket.com";

function sampleTrade(over: Partial<PolymarketTrade> = {}): PolymarketTrade {
  return {
    proxyWallet: "0x1111111111111111111111111111111111111111",
    side: "BUY",
    asset: "71321045679252212594626385532706912750332728571942532289631379312455583992563",
    conditionId: "0xcond",
    size: 100,
    price: 0.62,
    timestamp: 1_700_000_000,
    title: "Will X happen by July?",
    slug: "will-x-happen",
    eventSlug: "will-x-happen-event",
    outcome: "Yes",
    outcomeIndex: 0,
    transactionHash: "0xabc123",
    ...over,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function mockArg<T>(call: unknown[] | undefined, index: number): T {
  return (call as unknown[])[index] as T;
}

describe("PolymarketTradeSchema", () => {
  it("parses a valid trade payload", () => {
    const parsed = PolymarketTradeSchema.parse(sampleTrade());
    expect(parsed.asset).toContain("713210");
    expect(parsed.side).toBe("BUY");
  });

  it("rejects a malformed payload (missing transactionHash)", () => {
    const bad = { ...sampleTrade() } as Record<string, unknown>;
    delete bad["transactionHash"];
    expect(() => PolymarketTradeSchema.parse(bad)).toThrow();
  });
});

describe("fetchTrades", () => {
  it("requests the trades endpoint with the user and parses the result", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([sampleTrade()]));
    const trades = await fetchTrades(BASE, "0xLeader", { limit: 50, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(trades).toHaveLength(1);
    const calledUrl = String((fetchImpl.mock.calls[0] as unknown[])[0]);
    expect(calledUrl).toContain("/trades?user=0xLeader");
    expect(calledUrl).toContain("limit=50");
  });

  it("retries on HTTP 429 then succeeds", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(null, 429))
      .mockResolvedValueOnce(jsonResponse([sampleTrade()]));
    const trades = await fetchTrades(BASE, "0xLeader", { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(trades).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  }, 10_000);

  it("throws on a non-429 error status", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(null, 500));
    await expect(
      fetchTrades(BASE, "0xLeader", { fetchImpl: fetchImpl as unknown as typeof fetch })
    ).rejects.toThrow(/500/);
  });

  it("treats the offset-ceiling 400 as end of history (returns [], no throw)", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 400,
      text: async () => '{"error":"max historical activity offset of 3000 exceeded"}',
    }) as Response);
    const trades = await fetchTrades(BASE, "0xLeader", { offset: 3100, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(trades).toEqual([]);
  });

  it("still throws on an unrelated 400", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 400,
      text: async () => '{"error":"bad request"}',
    }) as Response);
    await expect(
      fetchTrades(BASE, "0xLeader", { fetchImpl: fetchImpl as unknown as typeof fetch })
    ).rejects.toThrow(/400/);
  });
});

describe("tradeToSignal", () => {
  it("maps a BUY: USDC in, outcome shares out (1e6 convention)", () => {
    const sig = tradeToSignal(sampleTrade({ side: "BUY", size: 100, price: 0.62 }), "wallet-1");
    expect(sig.chain).toBe("polygon");
    expect(sig.venue).toBe("polymarket");
    expect(sig.side).toBe("buy");
    expect(sig.decodeStatus).toBe("decoded");
    expect(sig.walletId).toBe("wallet-1");
    expect(sig.tokenIn.address).toBe(POLYGON_USDC);
    expect(sig.tokenOut.address).toBe(sampleTrade().asset);
    expect(sig.tokenOut.symbol).toBe("Yes");
    // usdc = 100 * 0.62 * 1e6 = 62_000_000 ; shares = 100 * 1e6 = 100_000_000
    expect(sig.amountIn).toBe(62_000_000n);
    expect(sig.amountOut).toBe(100_000_000n);
    expect(sig.confirmedAt).toBe(1_700_000_000 * 1000);
    expect(sig.reason).toBeNull();
    expect(sig.externalUrl).toBe("https://polymarket.com/event/will-x-happen-event");
    expect(sig.conditionId).toBe("0xcond");
    expect(sig.outcomeIndex).toBe(0);
  });

  it("maps a SELL: outcome shares in, USDC out", () => {
    const sig = tradeToSignal(sampleTrade({ side: "SELL", outcome: "No", size: 50, price: 0.4 }), "wallet-1");
    expect(sig.side).toBe("sell");
    expect(sig.tokenIn.address).toBe(sampleTrade().asset);
    expect(sig.tokenIn.symbol).toBe("No");
    expect(sig.tokenOut.address).toBe(POLYGON_USDC);
    expect(sig.amountIn).toBe(50_000_000n); // shares
    expect(sig.amountOut).toBe(20_000_000n); // 50 * 0.4 * 1e6
  });

  it("preserves a missing outcomeIndex as null", () => {
    const sig = tradeToSignal(sampleTrade({ outcomeIndex: undefined }), "wallet-1");
    expect(sig.conditionId).toBe("0xcond");
    expect(sig.outcomeIndex).toBeNull();
  });
});

describe("PolymarketWatcher", () => {
  beforeEach(() => {
    insertSignal.mockClear();
    upsertToken.mockClear();
    upsertLastBlock.mockClear();
    getActiveWallets.mockClear();
    getPolymarketPollCursors.mockClear();
    upsertPolymarketPollFailure.mockClear();
    upsertPolymarketPollSuccess.mockClear();
    getPolymarketPollCursors.mockResolvedValue([]);
  });

  it("getHealth() reports the polygon poller shape", () => {
    const w = new PolymarketWatcher({ db: {} as never, pollMs: 1000, baseUrl: BASE });
    const h = w.getHealth();
    expect(h.chain).toBe("polygon");
    expect(h.usingFallback).toBe(false);
    expect(h.backfillCount).toBe(0);
    expect(h.walletCount).toBe(0);
  });

  it("records each new trade once across re-polls (timestamp + trade-key cursor)", async () => {
    getActiveWallets.mockResolvedValue([{ id: "wallet-1", address: "0xLeader" }]);
    const fetchImpl = vi.fn(async () => jsonResponse([sampleTrade()]));
    const w = new PolymarketWatcher({ db: {} as never, pollMs: 1000, baseUrl: BASE, fetchImpl: fetchImpl as unknown as typeof fetch });

    // Manually drive ticks (don't start timers).
    await (w as unknown as { loadWallets: () => Promise<void> }).loadWallets();
    await w.tick();
    await w.tick();

    // Same trade returned twice, but the cursor stops the second insert.
    expect(insertSignal).toHaveBeenCalledTimes(1);
    // Both outcome + USDC token labels upserted for the one recorded trade.
    expect(upsertToken).toHaveBeenCalledTimes(2);
    expect(upsertPolymarketPollSuccess).toHaveBeenCalledTimes(2);
    expect(mockArg(upsertPolymarketPollSuccess.mock.calls[0], 1)).toMatchObject({
      walletId: "wallet-1",
      cursorTimestamp: 1_700_000_000,
      fetchedCount: 1,
      recordedCount: 1,
      duplicateCount: 0,
      pageCount: 1,
    });
    expect(mockArg(upsertPolymarketPollSuccess.mock.calls[1], 1)).toMatchObject({
      walletId: "wallet-1",
      fetchedCount: 1,
      recordedCount: 0,
      duplicateCount: 1,
      pageCount: 1,
    });
    expect(w.getHealth().connectionState).toBe("connected");
  });

  it("seeds the cursor from persisted poll state on wallet reload", async () => {
    getActiveWallets.mockResolvedValue([{ id: "wallet-1", address: "0xLeader" }]);
    const existing = sampleTrade({ timestamp: 100, transactionHash: "0xexisting" });
    getPolymarketPollCursors.mockResolvedValue([{
      walletId: "wallet-1",
      cursorTimestamp: 100,
      cursorKeys: [`${existing.transactionHash.toLowerCase()}:${existing.side}:${existing.asset}`],
    }]);
    const fetchImpl = vi.fn(async () => jsonResponse([existing]));
    const w = new PolymarketWatcher({ db: {} as never, pollMs: 1000, baseUrl: BASE, fetchImpl: fetchImpl as unknown as typeof fetch });

    await (w as unknown as { loadWallets: () => Promise<void> }).loadWallets();
    await w.tick();

    expect(insertSignal).not.toHaveBeenCalled();
    expect(mockArg(upsertPolymarketPollSuccess.mock.calls[0], 1)).toMatchObject({
      cursorTimestamp: 100,
      recordedCount: 0,
      duplicateCount: 1,
    });
  });

  it("continues pagination on a warm cursor so trades past the first page are not dropped", async () => {
    getActiveWallets.mockResolvedValue([{ id: "wallet-1", address: "0xLeader" }]);
    const baseline = sampleTrade({ timestamp: 100, transactionHash: "0xbaseline" });
    const firstPage = Array.from({ length: 100 }, (_, i) =>
      sampleTrade({ timestamp: 200, transactionHash: `0xnew${String(i).padStart(3, "0")}` })
    );
    const extra = sampleTrade({ timestamp: 199, transactionHash: "0xnew-extra" });

    let cold = true;
    const fetchImpl = vi.fn(async (url: string) => {
      if (cold) {
        cold = false;
        return jsonResponse([baseline]);
      }
      const offset = Number(new URL(url).searchParams.get("offset") ?? "0");
      if (offset === 0) return jsonResponse(firstPage);
      if (offset === 100) return jsonResponse([extra, baseline]);
      return jsonResponse([]);
    });
    const w = new PolymarketWatcher({ db: {} as never, pollMs: 1000, baseUrl: BASE, fetchImpl: fetchImpl as unknown as typeof fetch });

    await (w as unknown as { loadWallets: () => Promise<void> }).loadWallets();
    await w.tick();
    insertSignal.mockClear();
    fetchImpl.mockClear();

    await w.tick();

    expect(insertSignal).toHaveBeenCalledTimes(101);
    const urls = fetchImpl.mock.calls.map((call) => String((call as unknown[])[0]));
    expect(urls.some((url) => url.includes("offset=100"))).toBe(true);
  });

  it("stops at the API history-depth ceiling and advances the cursor instead of failing forever", async () => {
    getActiveWallets.mockResolvedValue([{ id: "wallet-1", address: "0xLeader" }]);
    // Warm cursor far in the past; every page returns a full page of trades newer than the cursor, so
    // the walk never reaches it. Without the offset cap this would page past offset 3000 and 400 every
    // poll. With the cap it must stop at offset 3000 (31 pages) and still record forward progress.
    getPolymarketPollCursors.mockResolvedValue([{ walletId: "wallet-1", cursorTimestamp: 100, cursorKeys: ["0xseen:BUY:asset"] }]);
    const fetchImpl = vi.fn(async (url: string) => {
      const offset = Number(new URL(url).searchParams.get("offset") ?? "0");
      const page = Array.from({ length: 100 }, (_, i) =>
        sampleTrade({ timestamp: 200, transactionHash: `0xt${offset}_${i}` })
      );
      return jsonResponse(page);
    });
    const w = new PolymarketWatcher({ db: {} as never, pollMs: 1000, baseUrl: BASE, fetchImpl: fetchImpl as unknown as typeof fetch });

    await (w as unknown as { loadWallets: () => Promise<void> }).loadWallets();
    await w.tick();

    const offsets = fetchImpl.mock.calls.map((call) => Number(new URL(String((call as unknown[])[0])).searchParams.get("offset")));
    expect(Math.max(...offsets)).toBe(3000); // never requests offset 3100
    expect(fetchImpl).toHaveBeenCalledTimes(31); // pages 0..30
    expect(upsertPolymarketPollSuccess).toHaveBeenCalledTimes(1); // forward progress, not a failure
    expect(upsertPolymarketPollFailure).not.toHaveBeenCalled();
    expect(mockArg(upsertPolymarketPollSuccess.mock.calls[0], 1)).toMatchObject({ cursorTimestamp: 200 });
    expect(w.getHealth().connectionState).toBe("connected");
  });

  it("records a new same-timestamp trade that was not seen at the cursor", async () => {
    getActiveWallets.mockResolvedValue([{ id: "wallet-1", address: "0xLeader" }]);
    const first = sampleTrade({ timestamp: 100, transactionHash: "0xfirst" });
    const second = sampleTrade({ timestamp: 100, transactionHash: "0xsecond" });
    let cold = true;
    const fetchImpl = vi.fn(async () => {
      if (cold) {
        cold = false;
        return jsonResponse([first]);
      }
      return jsonResponse([second, first]);
    });
    const w = new PolymarketWatcher({ db: {} as never, pollMs: 1000, baseUrl: BASE, fetchImpl: fetchImpl as unknown as typeof fetch });

    await (w as unknown as { loadWallets: () => Promise<void> }).loadWallets();
    await w.tick();
    insertSignal.mockClear();

    await w.tick();

    expect(insertSignal).toHaveBeenCalledTimes(1);
  });

  it("marks the poller degraded when a fetch fails", async () => {
    getActiveWallets.mockResolvedValue([{ id: "wallet-1", address: "0xLeader" }]);
    const fetchImpl = vi.fn(async () => { throw new Error("network down"); });
    const w = new PolymarketWatcher({ db: {} as never, pollMs: 1000, baseUrl: BASE, fetchImpl: fetchImpl as unknown as typeof fetch });
    await (w as unknown as { loadWallets: () => Promise<void> }).loadWallets();
    await w.tick();
    expect(insertSignal).not.toHaveBeenCalled();
    expect(w.getHealth().connectionState).toBe("reconnecting");
    expect(w.getHealth().connectFailures).toBe(1);
    expect(upsertPolymarketPollFailure).toHaveBeenCalledTimes(1);
    expect(mockArg(upsertPolymarketPollFailure.mock.calls[0], 1)).toMatchObject({
      walletId: "wallet-1",
      error: "network down",
    });
  });
});
