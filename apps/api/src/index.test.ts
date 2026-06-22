import { randomUUID } from "crypto";
import { beforeAll, afterAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { InjectOptions } from "fastify";

vi.mock("@tradebot/brain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tradebot/brain")>();
  return {
    ...actual,
    runScorerJob: vi.fn(async () => {}),
  };
});

import {
  adaptationLog,
  chainState,
  closeDb,
  getDb,
  insertFill,
  insertSignal,
  insertSnapshot,
  insertWallet,
  insertPriceMark,
  upsertLeaderStats,
  upsertPosition,
  upsertToken,
  leaderStats,
  paperFills,
  polymarketPollState,
  portfolioSnapshots,
  positions,
  runnerHealth,
  setCandidateReviewStatus,
  settings,
  tokens,
  tradeSignals,
  upsertLastBlock,
  upsertPolymarketPollSuccess,
  upsertRunnerHealth,
  wallets,
} from "@tradebot/store";
import { BrainWeightProvider, runScorerJob } from "@tradebot/brain";
import { createApiApp } from "./app.js";

const url = process.env["TEST_DATABASE_URL"];
if (!url) throw new Error("TEST_DATABASE_URL is not set — run docker compose --profile test up -d db-test");
if (!url.includes("_test")) throw new Error("TEST_DATABASE_URL must point to a database ending in _test");

const testApiConfig = {
  API_KEY: "test-api-key",
  API_PORT: 3001,
  CORS_ORIGIN: "http://localhost:3000",
  LOG_LEVEL: "error",
} as const;

const healthThresholds = {
  heartbeatStaleSec: 30,
  chainStaleSecByChain: { eth: 60, base: 30, polygon: 120 },
  rssSoftLimitBytes: 1536 * 1024 * 1024,
} as const;

let db: ReturnType<typeof getDb>;
let app: Awaited<ReturnType<typeof createApiApp>> | null = null;
type TestMethod = "GET" | "POST" | "PATCH" | "DELETE";
type InjectResponse = {
  statusCode: number;
  body: string;
  headers: Record<string, string | string[] | number | undefined>;
};

beforeAll(async () => {
  db = getDb(url);
  process.env["MIGRATE_URL"] = url;
  const migrateUrl = new URL("../../../packages/store/src/migrate.ts", import.meta.url).href;
  await import(migrateUrl);
  delete process.env["MIGRATE_URL"];
});

afterAll(async () => {
  await app?.close();
  await closeDb();
});

beforeEach(async () => {
  await db.delete(chainState);
  await db.delete(polymarketPollState);
  await db.delete(runnerHealth);
  await db.delete(paperFills);
  await db.delete(tradeSignals);
  await db.delete(leaderStats);
  await db.delete(positions);
  await db.delete(portfolioSnapshots);
  await db.delete(adaptationLog);
  await db.delete(settings);
  await db.delete(wallets);
  await db.delete(tokens);

  app = await createApiApp({
    db: db as Parameters<typeof createApiApp>[0]["db"],
    apiConfig: testApiConfig,
    healthThresholds,
    rpcClients: undefined,
    manualWeightProvider: new BrainWeightProvider(),
    enableStreamPolling: false,
  });
});

afterEach(async () => {
  vi.useRealTimers();
  vi.clearAllMocks();
  await app?.close();
  app = null;
});

describe("candidate review API", () => {
  it("requires X-Api-Key for candidate routes", async () => {
    const res = await app!.inject({ method: "GET", url: "/candidates" });
    expect(res.statusCode).toBe(401);
    expect(json(res)).toEqual({ error: "Unauthorized" });
  });

  it("lists candidates with filters and bigint serialization", async () => {
    const pendingId = await insertCandidate();
    const requestedId = await insertCandidate({
      tokenOut: { chain: "eth", address: "0x2222222222222222222222222222222222222222", symbol: "REQ", decimals: 18 },
      reviewStatus: "copy-requested",
    });
    const dismissedId = await insertCandidate({
      tokenOut: { chain: "polygon", address: "0x3333333333333333333333333333333333333333", symbol: "NOPE", decimals: 6 },
      chain: "polygon",
      venue: "polymarket",
      reviewStatus: "dismissed",
    });

    const res = await authed("GET", "/candidates?chain=eth&status=open");

    expect(res.statusCode).toBe(200);
    const body = json<{ candidates: Array<{ id: string; amountIn: string; reviewStatus: string | null; chain: string }> }>(res);
    expect(body.candidates.map((candidate) => candidate.id)).toEqual([requestedId, pendingId]);
    expect(body.candidates.every((candidate) => typeof candidate.amountIn === "string")).toBe(true);
    expect(body.candidates.find((candidate) => candidate.id === pendingId)?.reviewStatus).toBe("pending");
    expect(body.candidates.map((candidate) => candidate.id)).not.toContain(dismissedId);
  });

  it("rejects invalid candidate query params", async () => {
    const res = await authed("GET", "/candidates?status=broken");
    expect(res.statusCode).toBe(400);
    expect(json<{ error: string }>(res).error).toMatch(/Invalid enum value/);
  });

  it("returns the candidate triage summary", async () => {
    const older = new Date("2026-06-20T12:00:00.000Z").getTime();
    await insertCandidate({ observedAt: older, confirmedAt: older });
    const requestedId = await insertCandidate({
      tokenOut: { chain: "eth", address: "0x4444444444444444444444444444444444444444", symbol: "REQ", decimals: 18 },
      venue: "uniswap-v4",
      observedAt: older + 1_000,
      confirmedAt: older + 1_000,
      reviewStatus: "copy-requested",
    });
    await insertCandidate({
      chain: "polygon",
      venue: "polymarket",
      tokenIn: { chain: "polygon", address: "0x0000000000000000000000000000000000000001", symbol: "USDC", decimals: 6 },
      tokenOut: { chain: "polygon", address: "0x0000000000000000000000000000000000000002", symbol: "YES", decimals: 6 },
      observedAt: older + 2_000,
      confirmedAt: older + 2_000,
      reviewStatus: "copy-failed",
    });
    await insertCandidate({
      tokenOut: { chain: "eth", address: "0x5555555555555555555555555555555555555555", symbol: "DONE", decimals: 18 },
      reviewStatus: "dismissed",
    });

    const res = await authed("GET", "/candidates/summary");

    expect(res.statusCode).toBe(200);
    const body = json<{ summary: { totalOpen: number; groups: Array<{ chain: string; venue: string; status: string; count: number }> } }>(res);
    expect(body.summary.totalOpen).toBe(3);
    expect(body.summary.groups).toContainEqual(expect.objectContaining({ chain: "eth", venue: "balance-delta", status: "pending", count: 1 }));
    expect(body.summary.groups).toContainEqual(expect.objectContaining({ chain: "eth", venue: "uniswap-v4", status: "copy-requested", count: 1 }));
    expect(body.summary.groups).toContainEqual(expect.objectContaining({ chain: "polygon", venue: "polymarket", status: "copy-failed", count: 1 }));
    expect(body.summary.groups.some((group) => group.count === 1 && group.status === "dismissed")).toBe(false);
    expect(requestedId).toBeTruthy();
  });

  it("copies a pending EVM candidate and blocks non-EVM manual-review candidates", async () => {
    const evmId = await insertCandidate();
    const polygonId = await insertCandidate({
      chain: "polygon",
      venue: "polymarket",
      tokenIn: { chain: "polygon", address: "0x0000000000000000000000000000000000000001", symbol: "USDC", decimals: 6 },
      tokenOut: { chain: "polygon", address: "0x0000000000000000000000000000000000000002", symbol: "YES", decimals: 6 },
    });

    const copied = await authed("POST", `/candidates/${evmId}/copy`);
    expect(copied.statusCode).toBe(200);
    expect(json<{ candidate: { reviewStatus: string } }>(copied).candidate.reviewStatus).toBe("copy-requested");

    const blocked = await authed("POST", `/candidates/${polygonId}/copy`);
    expect(blocked.statusCode).toBe(400);
    expect(json<{ error: string }>(blocked).error).toMatch(/manual review flow/);
  });

  it("dismisses pending candidates and rejects queued ones", async () => {
    const pendingId = await insertCandidate();
    const requestedId = await insertCandidate({
      tokenOut: { chain: "eth", address: "0x6666666666666666666666666666666666666666", symbol: "REQ", decimals: 18 },
      reviewStatus: "copy-requested",
    });

    const dismissed = await authed("POST", `/candidates/${pendingId}/dismiss`);
    expect(dismissed.statusCode).toBe(200);
    expect(json<{ candidate: { reviewStatus: string } }>(dismissed).candidate.reviewStatus).toBe("dismissed");

    const conflict = await authed("POST", `/candidates/${requestedId}/dismiss`);
    expect(conflict.statusCode).toBe(409);
    expect(json<{ error: string }>(conflict).error).toContain("copy-requested");
  });

  it("resets queued candidates back to pending and rejects non-queued ones", async () => {
    const requestedId = await insertCandidate({ reviewStatus: "copy-requested" });
    const pendingId = await insertCandidate({
      tokenOut: { chain: "eth", address: "0x7777777777777777777777777777777777777777", symbol: "PEND", decimals: 18 },
    });

    const reset = await authed("POST", `/candidates/${requestedId}/reset`);
    expect(reset.statusCode).toBe(200);
    expect(json<{ candidate: { reviewStatus: string } }>(reset).candidate.reviewStatus).toBe("pending");

    const conflict = await authed("POST", `/candidates/${pendingId}/reset`);
    expect(conflict.statusCode).toBe(409);
    expect(json<{ error: string }>(conflict).error).toContain("only queued candidates can be reset");
  });

  it("marks copying candidates failed and rejects non-queued ones", async () => {
    const copyingId = await insertCandidate({ reviewStatus: "copying" });
    const failedId = await insertCandidate({
      tokenOut: { chain: "eth", address: "0x8888888888888888888888888888888888888888", symbol: "FAIL", decimals: 18 },
      reviewStatus: "copy-failed",
    });

    const failed = await authed("POST", `/candidates/${copyingId}/fail`);
    expect(failed.statusCode).toBe(200);
    expect(json<{ candidate: { reviewStatus: string } }>(failed).candidate.reviewStatus).toBe("copy-failed");

    const conflict = await authed("POST", `/candidates/${failedId}/fail`);
    expect(conflict.statusCode).toBe(409);
    expect(json<{ error: string }>(conflict).error).toContain("only queued candidates can be marked failed");
  });
});

describe("wallet API", () => {
  it("lists wallets and adds CORS headers for the configured origin", async () => {
    const wallet = await insertWallet(db as Parameters<typeof insertWallet>[0], {
      chain: "eth",
      address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      label: "Existing wallet",
      active: true,
      autoCopy: true,
    });

    const res = await authed("GET", "/wallets", { origin: testApiConfig.CORS_ORIGIN });

    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe(testApiConfig.CORS_ORIGIN);
    const body = json<{ wallets: Array<{ id: string; label: string }> }>(res);
    expect(body.wallets).toContainEqual(expect.objectContaining({ id: wallet.id, label: "Existing wallet" }));
  });

  it("creates, updates, and soft-deletes wallets", async () => {
    const created = await authed("POST", "/wallets", undefined, {
      chain: "eth",
      address: "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB",
      label: "New wallet",
    });
    expect(created.statusCode).toBe(201);
    const wallet = json<{ wallet: { id: string; address: string; autoCopy: boolean; active: boolean } }>(created).wallet;
    expect(wallet.address).toBe("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    expect(wallet.autoCopy).toBe(true);
    expect(wallet.active).toBe(true);

    const updated = await authed("PATCH", `/wallets/${wallet.id}`, undefined, { autoCopy: false });
    expect(updated.statusCode).toBe(200);
    expect(json<{ wallet: { autoCopy: boolean } }>(updated).wallet.autoCopy).toBe(false);

    const deleted = await authed("DELETE", `/wallets/${wallet.id}`);
    expect(deleted.statusCode).toBe(200);
    expect(json<{ ok: boolean }>(deleted)).toEqual({ ok: true });

    const listed = await authed("GET", "/wallets");
    expect(json<{ wallets: Array<{ id: string; active: boolean }> }>(listed).wallets).toContainEqual(
      expect.objectContaining({ id: wallet.id, active: false })
    );
  });

  it("rejects invalid wallet input", async () => {
    const res = await authed("POST", "/wallets", undefined, {
      chain: "eth",
      address: "vein",
      label: "Bad wallet",
    });

    expect(res.statusCode).toBe(400);
    expect(json<{ error: string }>(res).error).toContain("Enter a valid Ethereum address");
  });
});

describe("health and metrics API", () => {
  it("exposes unauthenticated health and reports down when no heartbeat exists", async () => {
    const res = await app!.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(503);
    expect(json<{ status: string }>({ body: res.body }).status).toBe("down");
  });

  it("returns authenticated metrics with heartbeat, CU budget, and polymarket poll detail", async () => {
    const polygonWallet = await insertWallet(db as Parameters<typeof insertWallet>[0], {
      chain: "polygon",
      address: "0x9999999999999999999999999999999999999999",
      label: "Poly watch",
      active: true,
      autoCopy: true,
    });
    await upsertLastBlock(db as Parameters<typeof upsertLastBlock>[0], "eth", 20_000_000);
    await upsertLastBlock(db as Parameters<typeof upsertLastBlock>[0], "base", 30_000_000);
    await upsertRunnerHealth(db as Parameters<typeof upsertRunnerHealth>[0], {
      pid: 1234,
      uptimeSec: 42,
      rssBytes: 128 * 1024 * 1024,
      heapUsedBytes: 64 * 1024 * 1024,
      version: "test-sha",
      chains: [
        { chain: "eth", connectionState: "connected", usingFallback: false, lastEventAt: Date.now(), connectFailures: 0, backfillCount: 0, walletCount: 2 },
        { chain: "base", connectionState: "connected", usingFallback: false, lastEventAt: Date.now(), connectFailures: 0, backfillCount: 0, walletCount: 1 },
      ],
    });
    await upsertPolymarketPollSuccess(db as Parameters<typeof upsertPolymarketPollSuccess>[0], {
      walletId: polygonWallet.id,
      lastPolledAt: Date.now(),
      cursorTimestamp: 1_717_171_717,
      cursorKeys: ["one", "two"],
      fetchedCount: 12,
      recordedCount: 9,
      duplicateCount: 3,
      pageCount: 2,
      durationMs: 250,
    });

    const res = await authed("GET", "/metrics");

    expect(res.statusCode).toBe(200);
    const body = json<{
      status: string;
      checks: Array<{ name: string; status: string }>;
      cuBudget: Array<{ chain: string; walletCount: number }>;
      input: { heartbeat: { payload: { version?: string } } | null; polymarketPolls: Array<{ walletId: string; recordedCount: number; cursorKeyCount: number }> };
    }>(res);
    expect(body.status).toBe("ok");
    expect(body.checks).toContainEqual(expect.objectContaining({ name: "runner", status: "ok" }));
    expect(body.cuBudget).toEqual(expect.arrayContaining([
      expect.objectContaining({ chain: "eth", walletCount: 2 }),
      expect.objectContaining({ chain: "base", walletCount: 1 }),
    ]));
    expect(body.input.heartbeat?.payload.version).toBe("test-sha");
    expect(body.input.polymarketPolls).toContainEqual(expect.objectContaining({
      walletId: polygonWallet.id,
      recordedCount: 9,
      cursorKeyCount: 2,
    }));
  });
});

describe("leader refresh and stream API", () => {
  it("requires auth for leader refresh and de-dupes concurrent refresh runs", async () => {
    const unauthenticated = await app!.inject({ method: "POST", url: "/leaders/refresh" });
    expect(unauthenticated.statusCode).toBe(401);
    expect(json<{ error: string }>({ body: unauthenticated.body }).error).toBe("Unauthorized");

    const leaderRefreshGate: { resolve: () => void } = {
      resolve: () => {
        throw new Error("leader refresh mock did not enter the in-flight state");
      },
    };
    const inFlightRun = new Promise<void>((resolve) => {
      leaderRefreshGate.resolve = resolve;
    });
    const runScorerJobMock = vi.mocked(runScorerJob);
    runScorerJobMock.mockImplementation(() => inFlightRun);

    const first = authed("POST", "/leaders/refresh");
    const second = authed("POST", "/leaders/refresh");

    await vi.waitFor(() => {
      expect(runScorerJobMock).toHaveBeenCalledTimes(1);
    });
    expect(runScorerJobMock).toHaveBeenCalledWith(db, expect.any(BrainWeightProvider), undefined);

    leaderRefreshGate.resolve();

    const [firstRes, secondRes] = await Promise.all([first, second]);
    expect(firstRes.statusCode).toBe(200);
    expect(secondRes.statusCode).toBe(200);
    expect(json<{ ok: boolean }>(firstRes)).toEqual({ ok: true });
    expect(json<{ ok: boolean }>(secondRes)).toEqual({ ok: true });

    const thirdRes = await authed("POST", "/leaders/refresh");
    expect(thirdRes.statusCode).toBe(200);
    expect(runScorerJobMock).toHaveBeenCalledTimes(2);
  });

  it("returns 500 and clears the in-flight gate when the scorer throws", async () => {
    const runScorerJobMock = vi.mocked(runScorerJob);
    const scorerError = new Error("scorer exploded");
    runScorerJobMock.mockRejectedValueOnce(scorerError);

    const failed = await authed("POST", "/leaders/refresh");
    expect(failed.statusCode).toBe(500);

    // The failed run must release the single-flight gate so a later request can retry.
    runScorerJobMock.mockResolvedValueOnce();
    const retried = await authed("POST", "/leaders/refresh");
    expect(retried.statusCode).toBe(200);
    expect(runScorerJobMock).toHaveBeenCalledTimes(2);
  });

  it("requires auth for the websocket stream and sends heartbeat pings", async () => {
    await app!.ready();
    await expect(app!.injectWS("/stream")).rejects.toThrow("Unexpected server response: 401");

    const ws = await app!.injectWS("/stream", {
      headers: { "x-api-key": testApiConfig.API_KEY },
    });

    const [pingMessage] = await collectWsMessages(ws, 1, 17_000);
    expect(pingMessage).toEqual({ type: "ping" });

    ws.terminate();
  }, 20_000);

  it("broadcasts recent trade-signal and paper-fill events over the websocket stream", async () => {
    await app?.close();
    app = await createApiApp({
      db: db as Parameters<typeof createApiApp>[0]["db"],
      apiConfig: testApiConfig,
      healthThresholds,
      rpcClients: undefined,
      manualWeightProvider: new BrainWeightProvider(),
      enableStreamPolling: true,
    });
    await app.ready();

    const ws = await app.injectWS("/stream", {
      headers: { "x-api-key": testApiConfig.API_KEY },
    });

    const baseTs = Date.now();
    const signalId = await insertDecodedSignal({
      observedAt: baseTs + 1_000,
      confirmedAt: baseTs + 1_000,
    });
    await insertFill(db as Parameters<typeof insertFill>[0], {
      id: randomUUID(),
      signalId,
      decidedAt: baseTs + 1_500,
      decision: "copied",
      side: "buy",
      token: { chain: "eth", address: "0x1111111111111111111111111111111111111111", symbol: "TEST", decimals: 18 },
      quoteToken: { chain: "eth", address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", symbol: "USDC", decimals: 6 },
      qty: 1,
      priceUsd: 1,
      notionalUsd: 1,
      feeUsd: 0.01,
      slippageBps: 3,
      latencyMs: 25,
      provisional: false,
    });

    const received = await collectWsMessages(ws, 2, 7_000, (message) => message.type !== "ping");

    expect(received.map((message) => message.type)).toEqual(["trade-signal", "paper-fill"]);
    expect(received[0]).toEqual(expect.objectContaining({
      type: "trade-signal",
      data: expect.objectContaining({
        id: signalId,
        amountIn: "100000000",
        amountOut: "1000000000000000000",
      }),
    }));
    expect(received[1]).toEqual(expect.objectContaining({
      type: "paper-fill",
      data: expect.objectContaining({
        signalId,
        decision: "copied",
      }),
    }));

    ws.terminate();
  }, 10_000);

  it("cleans up the stream polling timer on app close without leaking broadcasts", async () => {
    await app?.close();
    app = await createApiApp({
      db: db as Parameters<typeof createApiApp>[0]["db"],
      apiConfig: testApiConfig,
      healthThresholds,
      rpcClients: undefined,
      manualWeightProvider: new BrainWeightProvider(),
      enableStreamPolling: true,
    });
    await app.ready();

    const streamApp = app;
    // A client connects, receives the heartbeat window, then disconnects.
    const ws = await streamApp.injectWS("/stream", {
      headers: { "x-api-key": testApiConfig.API_KEY },
    });
    await collectWsMessages(ws, 1, 17_000);
    expect(streamApp.websocketServer.clients.size).toBe(1);
    ws.terminate();
    await vi.waitFor(() => {
      expect(streamApp.websocketServer.clients.size).toBe(0);
    });

    // Closing the app must clear the 2s polling timer; a clean close (no throw)
    // and zero remaining clients is the observable proof of lifecycle cleanup.
    await expect(streamApp.close()).resolves.toBeUndefined();
    expect(streamApp.websocketServer.clients.size).toBe(0);
  }, 20_000);
});

describe("settings API", () => {
  it("lists, updates, and deletes settings", async () => {
    const empty = await authed("GET", "/settings");
    expect(empty.statusCode).toBe(200);
    expect(json<{ settings: Record<string, unknown> }>(empty).settings).toEqual({});

    const patched = await authed("PATCH", "/settings", undefined, {
      key: "min_liquidity_usd",
      value: 250000,
    });
    expect(patched.statusCode).toBe(200);
    expect(json<{ ok: boolean }>(patched)).toEqual({ ok: true });

    const listed = await authed("GET", "/settings");
    expect(json<{ settings: Record<string, unknown> }>(listed).settings).toEqual({
      min_liquidity_usd: 250000,
    });

    const deleted = await authed("DELETE", "/settings/min_liquidity_usd");
    expect(deleted.statusCode).toBe(200);
    expect(json<{ ok: boolean }>(deleted)).toEqual({ ok: true });

    const afterDelete = await authed("GET", "/settings");
    expect(json<{ settings: Record<string, unknown> }>(afterDelete).settings).toEqual({});
  });

  it("rejects invalid settings payloads", async () => {
    const res = await authed("PATCH", "/settings", undefined, { key: "", value: 1 });
    expect(res.statusCode).toBe(400);
    expect(json<{ error: string }>(res).error).toMatch(/String must contain at least 1 character/);
  });
});

describe("signals and fills API", () => {
  it("lists recent signals with hydrated token metadata and bigint serialization", async () => {
    const olderTs = new Date("2026-06-20T09:00:00.000Z").getTime();
    const newerTs = new Date("2026-06-20T10:00:00.000Z").getTime();

    await seedToken({
      chain: "eth",
      address: "0x1010101010101010101010101010101010101010",
      symbol: "ALPHA",
      name: "Alpha Token",
      decimals: 18,
    });

    await insertDecodedSignal({
      observedAt: olderTs,
      confirmedAt: olderTs,
      tokenOut: { chain: "eth", address: "0x1111111111111111111111111111111111111111", symbol: "OLD", decimals: 18 },
    });
    const newestId = await insertDecodedSignal({
      observedAt: newerTs,
      confirmedAt: newerTs,
      tokenOut: { chain: "eth", address: "0x1010101010101010101010101010101010101010", symbol: "", decimals: 18 },
    });

    const res = await authed("GET", `/signals?since=${new Date(olderTs + 500).toISOString()}&limit=5`);

    expect(res.statusCode).toBe(200);
    const body = json<{
      signals: Array<{
        id: string;
        amountIn: string;
        amountOut: string;
        tokenOut: { symbol: string; name?: string };
      }>;
    }>(res);
    expect(body.signals).toHaveLength(1);
    expect(body.signals[0]).toEqual(expect.objectContaining({
      id: newestId,
      amountIn: "100000000",
      amountOut: "1000000000000000000",
      tokenOut: expect.objectContaining({ symbol: "ALPHA", name: "Alpha Token" }),
    }));
  });

  it("rejects invalid signals query params", async () => {
    const res = await authed("GET", "/signals?since=not-a-date");
    expect(res.statusCode).toBe(400);
    expect(json<{ error: string }>(res).error).toMatch(/Invalid datetime/);
  });

  it("lists fills with hydrated token metadata", async () => {
    const decidedAt = new Date("2026-06-20T11:00:00.000Z").getTime();
    await seedToken({
      chain: "eth",
      address: "0x2020202020202020202020202020202020202020",
      symbol: "BETA",
      name: "Beta Token",
      decimals: 18,
    });
    await seedToken({
      chain: "eth",
      address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      symbol: "USDC",
      name: "USD Coin",
      decimals: 6,
    });
    const signalId = await insertDecodedSignal({
      tokenOut: { chain: "eth", address: "0x2020202020202020202020202020202020202020", symbol: "", decimals: 18 },
    });
    await insertFill(db as Parameters<typeof insertFill>[0], {
      id: randomUUID(),
      signalId,
      decidedAt,
      decision: "copied",
      side: "buy",
      token: { chain: "eth", address: "0x2020202020202020202020202020202020202020", symbol: "", decimals: 18 },
      quoteToken: { chain: "eth", address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", symbol: "", decimals: 6 },
      qty: 12,
      priceUsd: 1.25,
      notionalUsd: 15,
      feeUsd: 0.15,
      slippageBps: 8,
      latencyMs: 220,
      provisional: false,
      priceSource: "mark",
      priceVenue: "uniswap-v3",
      liquidityUsd: 125000,
    });

    const res = await authed("GET", `/fills?since=${new Date(decidedAt - 1_000).toISOString()}&limit=5`);

    expect(res.statusCode).toBe(200);
    const body = json<{
      fills: Array<{
        decision: string;
        token: { symbol: string; name?: string };
        quoteToken: { symbol: string };
        liquidityUsd?: number;
        priceVenue?: string;
      }>;
    }>(res);
    expect(body.fills).toHaveLength(1);
    expect(body.fills[0]).toEqual(expect.objectContaining({
      decision: "copied",
      token: expect.objectContaining({ symbol: "BETA", name: "Beta Token" }),
      quoteToken: expect.objectContaining({ symbol: "USDC" }),
      liquidityUsd: 125000,
      priceVenue: "uniswap-v3",
    }));
  });

  it("rejects invalid fills query params", async () => {
    const res = await authed("GET", "/fills?limit=0");
    expect(res.statusCode).toBe(400);
    expect(json<{ error: string }>(res).error).toMatch(/Number must be greater than or equal to 1/);
  });
});

describe("portfolio, analytics, leaders, and adaptations API", () => {
  it("returns portfolio snapshots, open positions with marks, and source wallet details", async () => {
    const wallet = await insertWallet(db as Parameters<typeof insertWallet>[0], {
      chain: "eth",
      address: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
      label: "Lead wallet",
      active: true,
      autoCopy: true,
    });
    await seedToken({
      chain: "eth",
      address: "0x3030303030303030303030303030303030303030",
      symbol: "GAMMA",
      name: "Gamma Token",
      decimals: 18,
    });
    await upsertPosition(db as Parameters<typeof upsertPosition>[0], {
      chain: "eth",
      tokenAddress: "0x3030303030303030303030303030303030303030",
      qty: 4,
      avgCostUsd: 2.5,
      realizedPnlUsd: 1.25,
      sourceWalletId: wallet.id,
    });
    await insertPriceMark(db as Parameters<typeof insertPriceMark>[0], {
      chain: "eth",
      tokenAddress: "0x3030303030303030303030303030303030303030",
      ts: new Date("2026-06-20T12:00:00.000Z"),
      priceUsd: 3.75,
      source: "unit-test",
    });
    await insertSnapshot(db as Parameters<typeof insertSnapshot>[0], {
      ts: new Date("2026-06-20T11:00:00.000Z"),
      equityUsd: 1000,
      cashUsd: 700,
      positionsValueUsd: 300,
      dailyPnlUsd: 25,
    });
    await insertSnapshot(db as Parameters<typeof insertSnapshot>[0], {
      ts: new Date("2026-06-20T12:00:00.000Z"),
      equityUsd: 1025,
      cashUsd: 710,
      positionsValueUsd: 315,
      dailyPnlUsd: 30,
    });

    const res = await authed("GET", "/portfolio");

    expect(res.statusCode).toBe(200);
    const body = json<{
      snapshot: { equityUsd: number };
      positions: Array<{
        currentPriceUsd: number | null;
        token?: { symbol: string };
        sourceWallet: { id: string; label: string } | null;
      }>;
      snapshots: Array<{ equityUsd: number }>;
    }>(res);
    expect(body.snapshot?.equityUsd).toBe(1025);
    expect(body.snapshots.map((snapshot) => snapshot.equityUsd)).toEqual([1000, 1025]);
    expect(body.positions).toContainEqual(expect.objectContaining({
      currentPriceUsd: 3.75,
      token: expect.objectContaining({ symbol: "GAMMA" }),
      sourceWallet: expect.objectContaining({ id: wallet.id, label: "Lead wallet" }),
    }));
  });

  it("returns portfolio analytics aggregates", async () => {
    await seedToken({
      chain: "eth",
      address: "0x4040404040404040404040404040404040404040",
      symbol: "DELTA",
      name: "Delta Token",
      decimals: 18,
    });
    await db.insert(positions).values([
      {
        chain: "eth",
        tokenAddress: "0x4040404040404040404040404040404040404040",
        qty: "0",
        avgCostUsd: "2",
        openedAt: new Date("2026-06-20T08:00:00.000Z"),
        closedAt: new Date("2026-06-20T10:00:00.000Z"),
        realizedPnlUsd: "15",
      },
      {
        chain: "eth",
        tokenAddress: "0x4040404040404040404040404040404040404040",
        qty: "5",
        avgCostUsd: "3",
        openedAt: new Date("2026-06-20T11:00:00.000Z"),
        realizedPnlUsd: "-2",
      },
    ]);

    const signalId = await insertDecodedSignal({
      tokenOut: { chain: "eth", address: "0x4040404040404040404040404040404040404040", symbol: "", decimals: 18 },
    });
    await insertFill(db as Parameters<typeof insertFill>[0], {
      id: randomUUID(),
      signalId,
      decidedAt: new Date("2026-06-20T11:05:00.000Z").getTime(),
      decision: "copied",
      side: "buy",
      token: { chain: "eth", address: "0x4040404040404040404040404040404040404040", symbol: "", decimals: 18 },
      quoteToken: { chain: "eth", address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", symbol: "USDC", decimals: 6 },
      qty: 5,
      priceUsd: 3,
      notionalUsd: 15,
      feeUsd: 0.3,
      slippageBps: 5,
      latencyMs: 100,
      provisional: false,
    });
    await insertFill(db as Parameters<typeof insertFill>[0], {
      id: randomUUID(),
      signalId,
      decidedAt: new Date("2026-06-20T11:06:00.000Z").getTime(),
      decision: "skipped",
      skipReason: "liq",
      side: "buy",
      token: { chain: "eth", address: "0x4040404040404040404040404040404040404040", symbol: "", decimals: 18 },
      quoteToken: { chain: "eth", address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", symbol: "USDC", decimals: 6 },
      qty: 0,
      priceUsd: 3,
      notionalUsd: 0,
      feeUsd: 0,
      slippageBps: 0,
      latencyMs: 50,
      provisional: false,
    });

    const res = await authed("GET", "/analytics");

    expect(res.statusCode).toBe(200);
    const body = json<{
      analytics: {
        closedTrades: number;
        winningTrades: number;
        realizedPnlUsd: number;
        totalFeesUsd: number;
        totalNotionalUsd: number;
        averageHoldHours: number | null;
        openExposureUsd: number;
        copiedFills: number;
        skippedFills: number;
        byToken: Array<{ symbol: string; realizedPnlUsd: number; closedTrades: number }>;
      };
    }>(res);
    expect(body.analytics).toEqual(expect.objectContaining({
      closedTrades: 1,
      winningTrades: 1,
      realizedPnlUsd: 13,
      totalFeesUsd: 0.3,
      totalNotionalUsd: 15,
      averageHoldHours: 2,
      openExposureUsd: 15,
      copiedFills: 1,
      skippedFills: 1,
    }));
    expect(body.analytics.byToken).toContainEqual(expect.objectContaining({
      symbol: "DELTA",
      realizedPnlUsd: 13,
      closedTrades: 1,
    }));
  });

  it("returns leaders for active and inactive wallets grouped by window", async () => {
    const activeWallet = await insertWallet(db as Parameters<typeof insertWallet>[0], {
      chain: "eth",
      address: "0x5050505050505050505050505050505050505050",
      label: "Active leader",
      active: true,
      autoCopy: true,
    });
    const inactiveWallet = await insertWallet(db as Parameters<typeof insertWallet>[0], {
      chain: "eth",
      address: "0x6060606060606060606060606060606060606060",
      label: "Inactive leader",
      active: false,
      autoCopy: true,
    });

    await upsertLeaderStats(db as Parameters<typeof upsertLeaderStats>[0], {
      walletId: activeWallet.id,
      window: "7d",
      trades: 4,
      winRate: 0.75,
      avgReturnPct: 0.12,
      medianHoldMinutes: 90,
      realizedPnlUsd: 120,
      maxDrawdownPct: -0.08,
      score: 1.5,
      weight: 1.4,
    });
    await upsertLeaderStats(db as Parameters<typeof upsertLeaderStats>[0], {
      walletId: activeWallet.id,
      window: "30d",
      trades: 10,
      winRate: 0.6,
      avgReturnPct: 0.08,
      medianHoldMinutes: 120,
      realizedPnlUsd: 250,
      maxDrawdownPct: -0.15,
      score: 1.1,
      weight: 1.2,
    });
    await upsertLeaderStats(db as Parameters<typeof upsertLeaderStats>[0], {
      walletId: activeWallet.id,
      window: "all",
      trades: 20,
      winRate: 0.55,
      avgReturnPct: 0.05,
      medianHoldMinutes: 150,
      realizedPnlUsd: 400,
      maxDrawdownPct: -0.2,
      score: 0.9,
      weight: 1.1,
    });
    await upsertLeaderStats(db as Parameters<typeof upsertLeaderStats>[0], {
      walletId: inactiveWallet.id,
      window: "7d",
      trades: 2,
      winRate: 0.5,
      avgReturnPct: 0.03,
      medianHoldMinutes: 45,
      realizedPnlUsd: 20,
      maxDrawdownPct: -0.05,
      score: 0.2,
      weight: 0.8,
    });

    const res = await authed("GET", "/leaders");

    expect(res.statusCode).toBe(200);
    const body = json<{
      leaders: Array<{
        wallet: { id: string; label: string; active: boolean };
        stats: Record<string, { trades: number; weight: number }>;
      }>;
    }>(res);
    expect(body.leaders).toContainEqual(expect.objectContaining({
      wallet: expect.objectContaining({ id: activeWallet.id, label: "Active leader", active: true }),
      stats: expect.objectContaining({
        "7d": expect.objectContaining({ trades: 4, weight: 1.4 }),
        "30d": expect.objectContaining({ trades: 10, weight: 1.2 }),
        all: expect.objectContaining({ trades: 20, weight: 1.1 }),
      }),
    }));
    expect(body.leaders).toContainEqual(expect.objectContaining({
      wallet: expect.objectContaining({ id: inactiveWallet.id, label: "Inactive leader", active: false }),
      stats: expect.objectContaining({
        "7d": expect.objectContaining({ trades: 2, weight: 0.8 }),
      }),
    }));
  });

  it("lists adaptation logs by most recent first and validates limit", async () => {
    await db.insert(adaptationLog).values([
      {
        ts: new Date("2026-06-20T09:00:00.000Z"),
        rule: "liquidity-notch",
        oldValue: "150000",
        newValue: "175000",
        evidenceJson: { reason: "spread" },
      },
      {
        ts: new Date("2026-06-20T10:00:00.000Z"),
        rule: "leader-mute",
        oldValue: "off",
        newValue: "on",
        evidenceJson: { wallet: "0x1" },
      },
    ]);

    const listed = await authed("GET", "/adaptations?limit=1");

    expect(listed.statusCode).toBe(200);
    const body = json<{ entries: Array<{ rule: string; newValue: string }> }>(listed);
    expect(body.entries).toEqual([
      expect.objectContaining({ rule: "leader-mute", newValue: "on" }),
    ]);

    const invalid = await authed("GET", "/adaptations?limit=0");
    expect(invalid.statusCode).toBe(400);
    expect(json<{ error: string }>(invalid).error).toMatch(/Number must be greater than or equal to 1/);
  });
});

async function insertCandidate(
  overrides: Partial<Parameters<typeof insertSignal>[1]> = {},
) {
  const chain = overrides.chain ?? "eth";
  const wallet = await insertWallet(db as Parameters<typeof insertWallet>[0], {
    chain,
    address: `0x${randomUUID().replace(/-/g, "").padEnd(40, "0").slice(0, 40)}`,
    label: "Candidate wallet",
    active: true,
    autoCopy: true,
  });

  const observedAt = overrides.observedAt ?? Date.now();
  const id = await insertSignal(db as Parameters<typeof insertSignal>[0], {
    id: randomUUID(),
    chain,
    walletId: wallet.id,
    txHash: `0x${randomUUID().replace(/-/g, "").padEnd(64, "0").slice(0, 64)}`,
    source: "confirmed",
    side: "buy",
    tokenIn: overrides.tokenIn ?? {
      chain,
      address: chain === "polygon" ? "0x0000000000000000000000000000000000000001" : "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      symbol: "USDC",
      decimals: 6,
    },
    tokenOut: overrides.tokenOut ?? {
      chain,
      address: chain === "polygon" ? "0x0000000000000000000000000000000000000002" : "0x1111111111111111111111111111111111111111",
      symbol: "TEST",
      decimals: 18,
    },
    amountIn: 100_000_000n,
    amountOut: 1_000_000_000_000_000_000n,
    venue: overrides.venue ?? (chain === "polygon" ? "polymarket" : "balance-delta"),
    observedAt,
    confirmedAt: overrides.confirmedAt ?? observedAt,
    blockNumber: overrides.blockNumber ?? 1,
    decodeStatus: "candidate",
    confidence: overrides.confidence ?? 0.52,
    reason: overrides.reason ?? "review before copying",
    reviewStatus: overrides.reviewStatus ?? "pending",
    externalUrl: overrides.externalUrl ?? null,
    poolId: overrides.poolId ?? null,
  });

  const reviewStatus = overrides.reviewStatus;
  if (reviewStatus && reviewStatus !== "pending") {
    await setCandidateReviewStatus(db as Parameters<typeof setCandidateReviewStatus>[0], id, reviewStatus);
  }
  return id;
}

async function insertDecodedSignal(
  overrides: Partial<Parameters<typeof insertSignal>[1]> = {},
) {
  const chain = overrides.chain ?? "eth";
  const wallet = await insertWallet(db as Parameters<typeof insertWallet>[0], {
    chain,
    address: `0x${randomUUID().replace(/-/g, "").padEnd(40, "0").slice(0, 40)}`,
    label: "Decoded wallet",
    active: true,
    autoCopy: true,
  });

  const observedAt = overrides.observedAt ?? Date.now();
  return insertSignal(db as Parameters<typeof insertSignal>[0], {
    id: randomUUID(),
    chain,
    walletId: wallet.id,
    txHash: `0x${randomUUID().replace(/-/g, "").padEnd(64, "0").slice(0, 64)}`,
    source: "confirmed",
    side: overrides.side ?? "buy",
    tokenIn: overrides.tokenIn ?? {
      chain,
      address: chain === "polygon" ? "0x0000000000000000000000000000000000000001" : "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      symbol: "USDC",
      decimals: 6,
    },
    tokenOut: overrides.tokenOut ?? {
      chain,
      address: chain === "polygon" ? "0x0000000000000000000000000000000000000002" : "0x1111111111111111111111111111111111111111",
      symbol: "TEST",
      decimals: 18,
    },
    amountIn: overrides.amountIn ?? 100_000_000n,
    amountOut: overrides.amountOut ?? 1_000_000_000_000_000_000n,
    venue: overrides.venue ?? (chain === "polygon" ? "polymarket" : "balance-delta"),
    observedAt,
    confirmedAt: overrides.confirmedAt ?? observedAt,
    blockNumber: overrides.blockNumber ?? 1,
    decodeStatus: "decoded",
    confidence: overrides.confidence ?? 0.88,
    reason: overrides.reason ?? null,
    reviewStatus: null,
    externalUrl: overrides.externalUrl ?? null,
    poolId: overrides.poolId ?? null,
  });
}

async function seedToken(
  token: Omit<Parameters<typeof upsertToken>[1], "isBlocked"> & Partial<Pick<Parameters<typeof upsertToken>[1], "isBlocked">>
) {
  await upsertToken(db as Parameters<typeof upsertToken>[0], {
    ...token,
    isBlocked: token.isBlocked ?? false,
  });
}

async function authed(method: TestMethod, url: string, extraHeaders?: Record<string, string>, body?: unknown): Promise<InjectResponse> {
  const options: InjectOptions = {
    method,
    url,
    headers: { "x-api-key": testApiConfig.API_KEY, ...extraHeaders },
  };
  if (body !== undefined && body !== null) {
    options.payload = body as Exclude<InjectOptions["payload"], undefined>;
  }
  const res = await app!.inject(options);
  return { statusCode: res.statusCode, body: res.body, headers: res.headers };
}

function json<T>(res: Pick<InjectResponse, "body">): T {
  return JSON.parse(res.body) as T;
}

type StreamMessage = { type: string; data?: Record<string, unknown> };
type MessageSocket = {
  on: (event: "message", listener: (chunk: Buffer) => void) => void;
  removeListener: (event: "message", listener: (chunk: Buffer) => void) => void;
};

function collectWsMessages(
  ws: MessageSocket,
  count: number,
  timeoutMs: number,
  predicate: (message: StreamMessage) => boolean = () => true,
): Promise<StreamMessage[]> {
  return new Promise((resolve, reject) => {
    const messages: StreamMessage[] = [];
    const timer = setTimeout(() => {
      ws.removeListener("message", onMessage);
      reject(new Error(`Timed out waiting for ${count} websocket messages`));
    }, timeoutMs);

    const onMessage = (chunk: Buffer) => {
      const message = JSON.parse(chunk.toString()) as StreamMessage;
      if (!predicate(message)) return;
      messages.push(message);
      if (messages.length >= count) {
        clearTimeout(timer);
        ws.removeListener("message", onMessage);
        resolve(messages);
      }
    };

    ws.on("message", onMessage);
  });
}
