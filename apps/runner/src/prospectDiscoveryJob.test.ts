import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Nominator, Nomination, ProspectEvaluationSnapshot } from "@tradebot/ingest";

const storeMocks = vi.hoisted(() => ({
  countActivePolygonLeaders: vi.fn(async () => 0),
  getAllWallets: vi.fn(async () => []),
  getDiscoveryState: vi.fn(async () => null),
  getProspect: vi.fn(async () => null),
  getRecentlyRejected: vi.fn(async () => []),
  getRetractableAutoLeaders: vi.fn(async () => []),
  insertWallet: vi.fn(async (_db: unknown, wallet: { address: string }) => ({
    id: `wallet-${wallet.address.slice(-4)}`,
    chain: "polygon",
    address: wallet.address,
    label: wallet.address,
    active: true,
    autoCopy: false,
    addedAt: new Date(0),
  })),
  setDiscoveryState: vi.fn(async () => undefined),
  setWalletActive: vi.fn(async () => undefined),
  upsertProspectEvaluation: vi.fn(async () => undefined),
}));

const ingestMocks = vi.hoisted(() => ({
  createLeaderboardNominator: vi.fn(),
  evaluateProspect: vi.fn(),
}));

vi.mock("@tradebot/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tradebot/store")>();
  return { ...actual, ...storeMocks };
});

vi.mock("@tradebot/ingest", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tradebot/ingest")>();
  return { ...actual, ...ingestMocks };
});

import {
  countActivePolygonLeaders,
  getAllWallets,
  getDiscoveryState,
  getProspect,
  getRecentlyRejected,
  getRetractableAutoLeaders,
  insertWallet,
  setDiscoveryState,
  setWalletActive,
  upsertProspectEvaluation,
} from "@tradebot/store";
import { evaluateProspect } from "@tradebot/ingest";
import { startProspectDiscoveryJob } from "./prospectDiscoveryJob.js";

const NOW_MS = Date.UTC(2026, 5, 28);

const testConfig = {
  PROSPECT_DISCOVERY_ENABLED: true,
  PROSPECT_DISCOVERY_INTERVAL_MS: 86_400_000,
  PROSPECT_LEADERBOARD_WINDOW: "MONTH" as const,
  PROSPECT_CORROBORATE_ALL: true,
  PROSPECT_MIN_PNL_USD: 10_000,
  PROSPECT_MIN_PNL_PER_VOL: 0.03,
  PROSPECT_MIN_TRADES: 20,
  PROSPECT_RECENCY_DAYS: 14,
  PROSPECT_MAX_LEADERS: 25,
  PROSPECT_MAX_PROMOTIONS_PER_CYCLE: 3,
  PROSPECT_REJECT_COOLDOWN_DAYS: 7,
  POLYMARKET_DATA_API_URL: "https://data-api.polymarket.com",
};

const nominations: Nomination[] = [
  nomination("0x0000000000000000000000000000000000000001", 50_000),
  nomination("0x0000000000000000000000000000000000000002", 40_000),
  nomination("0x0000000000000000000000000000000000000003", 30_000),
  nomination("0x0000000000000000000000000000000000000004", 20_000),
];

function nomination(address: string, pnlUsd: number): Nomination {
  return {
    address,
    source: "leaderboard",
    userName: `user-${address.slice(-1)}`,
    pnlUsd,
    volUsd: 100_000,
  };
}

function evaluation(n: Nomination, score: number, verdict: "promoted" | "rejected" = "promoted"): ProspectEvaluationSnapshot {
  return {
    address: n.address,
    source: n.source,
    userName: n.userName ?? null,
    xUsername: null,
    pnlUsd: n.pnlUsd,
    volUsd: n.volUsd,
    pnlPerVol: n.pnlUsd / n.volUsd,
    tradeCount: 20,
    lastTradeTs: NOW_MS,
    score,
    verdict,
    rejectReason: verdict === "rejected" ? "test_reject" : null,
  };
}

function nominator(rows = nominations): Nominator {
  return { nominate: vi.fn(async () => rows) };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    await Promise.resolve();
  }
}

describe("startProspectDiscoveryJob", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    (ingestMocks.evaluateProspect as any).mockImplementation(async (n: Nomination) => evaluation(n, n.pnlUsd / n.volUsd));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does nothing when discovery is disabled", async () => {
    const job = startProspectDiscoveryJob({} as never, {
      config: { ...testConfig, PROSPECT_DISCOVERY_ENABLED: false },
      nominator: nominator(),
      now: () => NOW_MS,
    });
    await flush();
    job.stop();

    expect(storeMocks.getDiscoveryState).not.toHaveBeenCalled();
    expect(ingestMocks.evaluateProspect).not.toHaveBeenCalled();
  });

  it("skips a boot run when the persisted last run is inside the interval", async () => {
    (storeMocks.getDiscoveryState as any).mockResolvedValueOnce({
      lastRunAt: new Date(NOW_MS - 60_000),
      lastError: null,
      promotedLastRun: 1,
    });

    const job = startProspectDiscoveryJob({} as never, {
      config: testConfig,
      nominator: nominator(),
      now: () => NOW_MS,
    });
    await flush();
    job.stop();

    expect(ingestMocks.evaluateProspect).not.toHaveBeenCalled();
    expect(storeMocks.setDiscoveryState).not.toHaveBeenCalled();
  });

  it("respects max leader capacity and inserts observe-first leaders", async () => {
    (storeMocks.countActivePolygonLeaders as any).mockResolvedValueOnce(23);

    const job = startProspectDiscoveryJob({} as never, {
      config: testConfig,
      nominator: nominator(),
      now: () => NOW_MS,
    });
    await flush();
    job.stop();

    expect(storeMocks.insertWallet).toHaveBeenCalledTimes(2);
    expect(storeMocks.insertWallet).toHaveBeenNthCalledWith(1, expect.anything(), expect.objectContaining({
      chain: "polygon",
      address: nominations[0]!.address,
      autoCopy: false,
      autoAdded: true,
      active: true,
    }));
    expect(storeMocks.insertWallet).toHaveBeenNthCalledWith(2, expect.anything(), expect.objectContaining({
      address: nominations[1]!.address,
      autoCopy: false,
      autoAdded: true,
    }));
    expect(storeMocks.setDiscoveryState).toHaveBeenLastCalledWith(expect.anything(), {
      lastRunAt: new Date(NOW_MS),
      lastError: null,
      promotedLastRun: 2,
    });
  });

  it("respects the per-cycle promotion limit", async () => {
    const job = startProspectDiscoveryJob({} as never, {
      config: testConfig,
      nominator: nominator(),
      now: () => NOW_MS,
    });
    await flush();
    job.stop();

    expect(storeMocks.insertWallet).toHaveBeenCalledTimes(3);
    expect(storeMocks.insertWallet).toHaveBeenNthCalledWith(3, expect.anything(), expect.objectContaining({
      address: nominations[2]!.address,
      autoCopy: false,
      autoAdded: true,
    }));
  });
  it("drops existing leaders and recently rejected prospects before evaluation", async () => {
    (storeMocks.getAllWallets as any).mockResolvedValueOnce([
      { id: "existing", chain: "polygon", address: nominations[0]!.address, label: "existing", active: true, autoCopy: true, addedAt: new Date(0) },
    ]);
    (storeMocks.getRecentlyRejected as any).mockResolvedValueOnce([nominations[1]!.address]);

    const job = startProspectDiscoveryJob({} as never, {
      config: testConfig,
      nominator: nominator(nominations.slice(0, 3)),
      now: () => NOW_MS,
    });
    await flush();
    job.stop();

    expect(ingestMocks.evaluateProspect).toHaveBeenCalledTimes(1);
    expect(ingestMocks.evaluateProspect).toHaveBeenCalledWith(nominations[2], expect.objectContaining({
      minPnlUsd: testConfig.PROSPECT_MIN_PNL_USD,
      minPnlPerVol: testConfig.PROSPECT_MIN_PNL_PER_VOL,
      minTrades: testConfig.PROSPECT_MIN_TRADES,
      recencyDays: testConfig.PROSPECT_RECENCY_DAYS,
      nowMs: NOW_MS,
    }));
  });

  it("retracts only eligible weak auto leaders to free promotion slots", async () => {
    (storeMocks.countActivePolygonLeaders as any).mockResolvedValueOnce(25);
    (storeMocks.getRetractableAutoLeaders as any).mockResolvedValueOnce([
      { id: "weak", chain: "polygon", address: "0x1000000000000000000000000000000000000000", label: "weak", active: true, autoCopy: false, addedAt: new Date(0) },
      { id: "strong", chain: "polygon", address: "0x2000000000000000000000000000000000000000", label: "strong", active: true, autoCopy: false, addedAt: new Date(0) },
    ]);
    (storeMocks.getProspect as any).mockImplementation(async (_db: unknown, address: string) => ({
      address,
      source: "leaderboard",
      pnlUsd: null,
      volUsd: null,
      pnlPerVol: null,
      tradeCount: null,
      lastTradeTs: null,
      score: address.startsWith("0x1") ? 0.01 : 0.9,
      verdict: "promoted",
      rejectReason: null,
      promotedWalletId: null,
      firstSeenAt: new Date(0),
      lastEvaluatedAt: new Date(0),
    }));

    const job = startProspectDiscoveryJob({} as never, {
      config: testConfig,
      nominator: nominator(nominations.slice(0, 1)),
      now: () => NOW_MS,
    });
    await flush();
    job.stop();

    expect(storeMocks.setWalletActive).toHaveBeenCalledTimes(1);
    expect(storeMocks.setWalletActive).toHaveBeenCalledWith(expect.anything(), "weak", false);
    expect(storeMocks.insertWallet).toHaveBeenCalledTimes(1);
  });

  it("records lastError when the cycle fails", async () => {
    (ingestMocks.evaluateProspect as any).mockRejectedValueOnce(new Error("data api down"));

    const job = startProspectDiscoveryJob({} as never, {
      config: testConfig,
      nominator: nominator(nominations.slice(0, 1)),
      now: () => NOW_MS,
    });
    await flush();
    job.stop();

    expect(storeMocks.setDiscoveryState).toHaveBeenCalledWith(expect.anything(), { lastError: "data api down" });
  });
});





