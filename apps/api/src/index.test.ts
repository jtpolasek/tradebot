import { randomUUID } from "crypto";
import { beforeAll, afterAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import {
  adaptationLog,
  chainState,
  closeDb,
  getDb,
  insertSignal,
  insertWallet,
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
  wallets,
} from "@tradebot/store";
import { BrainWeightProvider } from "@tradebot/brain";
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
type TestMethod = "GET" | "POST";
type InjectResponse = { statusCode: number; body: string };

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

  it("copies a pending EVM candidate and blocks record-only candidates", async () => {
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
    expect(json<{ error: string }>(blocked).error).toMatch(/record only/);
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

async function authed(method: TestMethod, url: string): Promise<InjectResponse> {
  const res = await app!.inject({
    method,
    url,
    headers: { "x-api-key": testApiConfig.API_KEY },
  });
  return { statusCode: res.statusCode, body: res.body };
}

function json<T>(res: Pick<InjectResponse, "body">): T {
  return JSON.parse(res.body) as T;
}
