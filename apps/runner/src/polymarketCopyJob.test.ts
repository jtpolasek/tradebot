import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TradeSignal } from "@tradebot/core";

const { getPendingPolymarketSignals } = vi.hoisted(() => ({
  getPendingPolymarketSignals: vi.fn<(_: unknown, limit: number) => Promise<TradeSignal[]>>(async () => []),
}));

vi.mock("@tradebot/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tradebot/store")>();
  return {
    ...actual,
    getPendingPolymarketSignals,
  };
});

import { startPolymarketCopyJob } from "./polymarketCopyJob.js";

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

const sampleSignal: TradeSignal = {
  id: "signal-1",
  chain: "polygon" as const,
  walletId: "wallet-1",
  txHash: "0xabc",
  source: "confirmed" as const,
  side: "buy" as const,
  tokenIn: { chain: "polygon" as const, address: "0x1", symbol: "USDC", decimals: 6 },
  tokenOut: { chain: "polygon" as const, address: "123", symbol: "YES", decimals: 6 },
  amountIn: 1n,
  amountOut: 1n,
  venue: "polymarket",
  observedAt: Date.now(),
  confirmedAt: Date.now(),
  blockNumber: null,
  decodeStatus: "decoded" as const,
  confidence: 1,
  reason: null,
  reviewStatus: null,
  externalUrl: null,
  poolId: null,
  conditionId: "0xcondition",
  outcomeIndex: 0,
};

describe("startPolymarketCopyJob", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("executes each pending polygon signal through the engine", async () => {
    vi.mocked(getPendingPolymarketSignals).mockResolvedValueOnce([sampleSignal]);
    const engine = { executePolymarketSignal: vi.fn(async () => undefined) };

    const job = startPolymarketCopyJob({} as never, engine, { intervalMs: 60_000 });
    await flushMicrotasks();
    job.stop();

    expect(getPendingPolymarketSignals).toHaveBeenCalledWith(expect.anything(), 25);
    expect(engine.executePolymarketSignal).toHaveBeenCalledWith(sampleSignal);
  });

  it("does not start a second run while the first one is still in flight", async () => {
    let release = () => {};
    const inFlight = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(getPendingPolymarketSignals).mockResolvedValue([sampleSignal]);
    const engine = {
      executePolymarketSignal: vi.fn(async () => {
        await inFlight;
      }),
    };

    const job = startPolymarketCopyJob({} as never, engine, { intervalMs: 5_000 });
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(vi.mocked(getPendingPolymarketSignals)).toHaveBeenCalledTimes(1);

    release();
    await flushMicrotasks();
    job.stop();
  });
});
