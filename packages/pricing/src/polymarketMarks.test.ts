import { afterEach, describe, expect, it, vi } from "vitest";

const { getOpenPositionTokens, insertPriceMark, getPolymarketPrice } = vi.hoisted(() => ({
  getOpenPositionTokens: vi.fn(),
  insertPriceMark: vi.fn(),
  getPolymarketPrice: vi.fn(),
}));

vi.mock("@tradebot/store", () => ({ getOpenPositionTokens, insertPriceMark }));
vi.mock("./polymarket.js", () => ({ getPolymarketPrice }));

import { startPolymarketMarksJob } from "./polymarketMarks.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  getOpenPositionTokens.mockReset();
  insertPriceMark.mockReset();
  getPolymarketPrice.mockReset();
});

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("startPolymarketMarksJob re-entrancy guard", () => {
  it("does not start a second tick while the previous one is still running", async () => {
    vi.useFakeTimers();
    getOpenPositionTokens.mockResolvedValue([{ chain: "polygon", tokenAddress: "0xtoken" }]);

    // First price read hangs so the initial tick stays in-flight across the next interval.
    const gate = deferred<{ bestBid: number; bestAsk: number }>();
    getPolymarketPrice.mockReturnValueOnce(gate.promise);

    const db = {} as never;
    const job = startPolymarketMarksJob(db, { intervalMs: 1_000 });

    // Let the immediate tick advance to its first await (the hanging price read).
    await Promise.resolve();
    await Promise.resolve();
    expect(getPolymarketPrice).toHaveBeenCalledTimes(1);

    // Fire the interval while the first tick is still pending — the guard must skip it.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(getPolymarketPrice).toHaveBeenCalledTimes(1);

    // Release the first tick; a subsequent interval is then free to run again.
    gate.resolve({ bestBid: 0.4, bestAsk: 0.6 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(getPolymarketPrice).toHaveBeenCalledTimes(2);

    job.stop();
  });
});
