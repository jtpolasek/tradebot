import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getOpenPolymarketPositionsForSettlement } = vi.hoisted(() => ({
  getOpenPolymarketPositionsForSettlement: vi.fn<
    (_: unknown) => Promise<Array<{
      chain: "polygon";
      tokenAddress: string;
      qty: number;
      avgCostUsd: number;
      sourceWalletId: string | null;
      conditionId: string;
      outcomeIndex: number;
    }>>
  >(async () => []),
}));

vi.mock("@tradebot/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tradebot/store")>();
  return {
    ...actual,
    getOpenPolymarketPositionsForSettlement,
  };
});

import { startPolymarketResolutionJob } from "./polymarketResolutionJob.js";

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

const samplePosition = {
  chain: "polygon" as const,
  tokenAddress: "71321045679252212594626385532706912750332728571942532289631379312455583992563",
  qty: 100,
  avgCostUsd: 0.45,
  sourceWalletId: "wallet-1",
  conditionId: "0xcondition",
  outcomeIndex: 1,
  externalUrl: "https://polymarket.com/event/test-event",
};

describe("startPolymarketResolutionJob", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("settles each open polygon position through the engine", async () => {
    vi.mocked(getOpenPolymarketPositionsForSettlement).mockResolvedValueOnce([samplePosition]);
    const engine = { settlePolymarketPosition: vi.fn(async () => "settled" as const) };

    const job = startPolymarketResolutionJob({} as never, engine, { intervalMs: 60_000 });
    await flushMicrotasks();
    job.stop();

    expect(getOpenPolymarketPositionsForSettlement).toHaveBeenCalledWith(expect.anything());
    expect(engine.settlePolymarketPosition).toHaveBeenCalledWith(samplePosition);
  });

  it("does not start a second run while the first one is still in flight", async () => {
    let release = () => {};
    const inFlight = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(getOpenPolymarketPositionsForSettlement).mockResolvedValue([samplePosition]);
    const engine = {
      settlePolymarketPosition: vi.fn(async () => {
        await inFlight;
        return "settled" as const;
      }),
    };

    const job = startPolymarketResolutionJob({} as never, engine, { intervalMs: 5_000 });
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(vi.mocked(getOpenPolymarketPositionsForSettlement)).toHaveBeenCalledTimes(1);

    release();
    await flushMicrotasks();
    job.stop();
  });
});
