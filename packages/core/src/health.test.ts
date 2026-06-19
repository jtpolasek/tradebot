import { describe, it, expect } from "vitest";
import { deriveHealth, type HealthInput, type HealthThresholds, type PolymarketPollHealth, type RunnerHealthPayload } from "./health.js";

const NOW = 1_000_000_000_000;

const thresholds: HealthThresholds = {
  heartbeatStaleSec: 30,
  chainStaleSecByChain: { eth: 60, base: 30, polygon: 120 },
  rssSoftLimitBytes: 1536 * 1024 * 1024,
};

function payload(over: Partial<RunnerHealthPayload> = {}): RunnerHealthPayload {
  return {
    pid: 123,
    uptimeSec: 100,
    rssBytes: 200 * 1024 * 1024,
    heapUsedBytes: 100 * 1024 * 1024,
    chains: [
      { chain: "eth", connectionState: "connected", usingFallback: false, lastEventAt: NOW, connectFailures: 0, backfillCount: 0, walletCount: 3 },
      { chain: "base", connectionState: "connected", usingFallback: false, lastEventAt: NOW, connectFailures: 0, backfillCount: 0, walletCount: 3 },
    ],
    ...over,
  };
}

function input(over: Partial<HealthInput> = {}): HealthInput {
  return {
    dbReachable: true,
    heartbeat: { ts: NOW - 5_000, payload: payload() },
    chainStateUpdatedAt: { eth: NOW - 10_000, base: NOW - 5_000 },
    ...over,
  };
}

function polymarketPoll(over: Partial<PolymarketPollHealth> = {}): PolymarketPollHealth {
  return {
    walletId: "wallet-1",
    walletAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    walletLabel: "Poly leader",
    lastPolledAt: NOW - 5_000,
    lastSuccessAt: NOW - 5_000,
    lastErrorAt: null,
    lastError: null,
    cursorTimestamp: 1_700_000_000,
    cursorKeyCount: 1,
    fetchedCount: 2,
    recordedCount: 1,
    duplicateCount: 1,
    pageCount: 1,
    durationMs: 120,
    consecutiveFailures: 0,
    updatedAt: NOW - 5_000,
    ...over,
  };
}

describe("deriveHealth", () => {
  it("reports ok when everything is fresh and connected", () => {
    const report = deriveHealth(input(), NOW, thresholds);
    expect(report.status).toBe("ok");
    expect(report.checks.every((c) => c.status === "ok")).toBe(true);
  });

  it("is down when the database is unreachable", () => {
    const report = deriveHealth(input({ dbReachable: false, heartbeat: null }), NOW, thresholds);
    expect(report.status).toBe("down");
    expect(report.checks.find((c) => c.name === "database")?.status).toBe("down");
  });

  it("is down when no heartbeat has been written", () => {
    const report = deriveHealth(input({ heartbeat: null }), NOW, thresholds);
    expect(report.status).toBe("down");
    expect(report.checks.find((c) => c.name === "runner")?.detail).toMatch(/no heartbeat/);
  });

  it("is down when the heartbeat is stale (runner dead/blocked)", () => {
    const report = deriveHealth(input({ heartbeat: { ts: NOW - 31_000, payload: payload() } }), NOW, thresholds);
    expect(report.status).toBe("down");
    expect(report.checks.find((c) => c.name === "runner")?.status).toBe("down");
  });

  it("is degraded when a chain watcher is on the fallback endpoint", () => {
    const chains = payload().chains.map((c) => (c.chain === "eth" ? { ...c, usingFallback: true } : c));
    const report = deriveHealth(input({ heartbeat: { ts: NOW - 5_000, payload: payload({ chains }) } }), NOW, thresholds);
    expect(report.status).toBe("degraded");
    expect(report.checks.find((c) => c.name === "ws:eth")?.status).toBe("degraded");
  });

  it("is degraded when a chain stops advancing past its threshold", () => {
    const report = deriveHealth(input({ chainStateUpdatedAt: { eth: NOW - 120_000, base: NOW - 5_000 } }), NOW, thresholds);
    expect(report.status).toBe("degraded");
    expect(report.checks.find((c) => c.name === "chain:eth")?.status).toBe("degraded");
    expect(report.checks.find((c) => c.name === "chain:base")?.status).toBe("ok");
  });

  it("is degraded when RSS exceeds the soft limit", () => {
    const report = deriveHealth(
      input({ heartbeat: { ts: NOW - 5_000, payload: payload({ rssBytes: 2_000 * 1024 * 1024 }) } }),
      NOW,
      thresholds,
    );
    expect(report.status).toBe("degraded");
    expect(report.checks.find((c) => c.name === "memory")?.status).toBe("degraded");
  });

  it("does not fault on a chain with no chain_state row yet", () => {
    const report = deriveHealth(input({ chainStateUpdatedAt: { base: NOW - 5_000 } }), NOW, thresholds);
    expect(report.checks.find((c) => c.name === "chain:eth")).toBeUndefined();
    expect(report.status).toBe("ok");
  });

  it("reports ok for a fresh Polymarket poll row", () => {
    const report = deriveHealth(input({ polymarketPolls: [polymarketPoll()] }), NOW, thresholds);
    expect(report.status).toBe("ok");
    expect(report.checks.find((c) => c.name === "polymarket:Poly leader")?.status).toBe("ok");
  });

  it("is degraded when a Polymarket wallet has no successful poll", () => {
    const report = deriveHealth(input({ polymarketPolls: [polymarketPoll({ lastPolledAt: null, lastSuccessAt: null })] }), NOW, thresholds);
    expect(report.status).toBe("degraded");
    expect(report.checks.find((c) => c.name === "polymarket:Poly leader")?.detail).toMatch(/no poll/);
  });

  it("is degraded when a Polymarket poll is stale", () => {
    const report = deriveHealth(input({ polymarketPolls: [polymarketPoll({ lastSuccessAt: NOW - 121_000 })] }), NOW, thresholds);
    expect(report.status).toBe("degraded");
    expect(report.checks.find((c) => c.name === "polymarket:Poly leader")?.detail).toMatch(/last success/);
  });

  it("is degraded when a Polymarket wallet has consecutive failures", () => {
    const report = deriveHealth(input({ polymarketPolls: [polymarketPoll({ consecutiveFailures: 2, lastError: "network down" })] }), NOW, thresholds);
    expect(report.status).toBe("degraded");
    expect(report.checks.find((c) => c.name === "polymarket:Poly leader")?.detail).toContain("network down");
  });

  it("down outranks degraded in the rollup", () => {
    const chains = payload().chains.map((c) => ({ ...c, usingFallback: true }));
    const report = deriveHealth(input({ dbReachable: false, heartbeat: { ts: NOW - 5_000, payload: payload({ chains }) } }), NOW, thresholds);
    expect(report.status).toBe("down");
  });
});
