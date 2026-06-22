import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { randomUUID } from "crypto";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import * as schema from "../schema.js";
import { insertWallet, getActiveWallets, getAllWallets, setWalletActive, setWalletAutoCopy } from "./wallets.js";
import { getLastBlock, upsertLastBlock } from "./chainState.js";
import { closeDb, getDb } from "../db.js";
import {
  insertSignal,
  getSignalById,
  getRecentSignals,
  getCandidateSignals,
  getCandidateTriageSummary,
  getCopyRequestedCandidates,
  setCandidateReviewStatus,
  transitionCandidateReviewStatus,
  getV4MarketHintForToken,
} from "./signals.js";
import { insertFill, getRecentFills } from "./paperFills.js";
import { upsertPosition, closePositionByKey } from "./positions.js";
import { getPortfolioAnalytics } from "./analytics.js";
import { upsertToken } from "./tokens.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const url = process.env["TEST_DATABASE_URL"];
if (!url) throw new Error("TEST_DATABASE_URL is not set — run docker compose --profile test up -d db-test");
if (!url.includes("_test")) throw new Error("TEST_DATABASE_URL must point to a database ending in _test");

let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;

beforeAll(async () => {
  client = postgres(url, { max: 1 });
  db = drizzle(client, { schema }) as ReturnType<typeof drizzle<typeof schema>>;
  await migrate(db as Parameters<typeof migrate>[0], {
    migrationsFolder: resolve(__dirname, "../../drizzle"),
  });
});

afterAll(async () => {
  await client.end();
});

beforeEach(async () => {
  await db.delete(schema.chainState);
  await db.delete(schema.polymarketPollState);
  await db.delete(schema.paperFills);
  await db.delete(schema.tradeSignals);
  await db.delete(schema.leaderStats);
  await db.delete(schema.positions);
  await db.delete(schema.portfolioSnapshots);
  await db.delete(schema.wallets);
  await db.delete(schema.tokens);
});

describe("wallets repository", () => {
  it("rejects switching singleton database URLs without closeDb", async () => {
    const first = getDb(url);
    expect(getDb(url)).toBe(first);

    const otherUrl = url.replace("tradebot_test", "tradebot_other_test");
    expect(() => getDb(otherUrl)).toThrow(/different URL/);
    await closeDb();
  });

  it("inserts and retrieves a wallet", async () => {
    const inserted = await insertWallet(db as Parameters<typeof insertWallet>[0], {
      chain: "eth",
      address: "0xc5a6bd7693e41b33f7f6fd6de3d82bd8b124ad8d",
      label: "Test Wallet",
      active: true,
    });
    expect(inserted.id).toBeTruthy();
    expect(inserted.address).toBe("0xc5a6bd7693e41b33f7f6fd6de3d82bd8b124ad8d");
    expect(inserted.chain).toBe("eth");
  });

  it("rejects invalid wallet addresses before they can reach ingest", async () => {
    await expect(insertWallet(db as Parameters<typeof insertWallet>[0], {
      chain: "eth",
      address: "vein",
      label: "Bad input",
      active: true,
    })).rejects.toThrow("Enter a valid Ethereum address.");
  });

  it("getActiveWallets filters by chain", async () => {
    await insertWallet(db as Parameters<typeof insertWallet>[0], {
      chain: "eth",
      address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      label: "ETH wallet",
      active: true,
    });
    await insertWallet(db as Parameters<typeof insertWallet>[0], {
      chain: "base",
      address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      label: "Base wallet",
      active: true,
    });

    const ethWallets = await getActiveWallets(db as Parameters<typeof getActiveWallets>[0], "eth");
    expect(ethWallets).toHaveLength(1);
    expect(ethWallets[0]?.chain).toBe("eth");
  });

  it("setWalletActive deactivates a wallet", async () => {
    const inserted = await insertWallet(db as Parameters<typeof insertWallet>[0], {
      chain: "eth",
      address: "0xcccccccccccccccccccccccccccccccccccccccc",
      label: "Deactivate me",
      active: true,
    });
    await setWalletActive(db as Parameters<typeof setWalletActive>[0], inserted.id, false);
    const active = await getActiveWallets(db as Parameters<typeof getActiveWallets>[0]);
    expect(active.find((w) => w.id === inserted.id)).toBeUndefined();
  });

  it("defaults auto-copy on and setWalletAutoCopy toggles it", async () => {
    const inserted = await insertWallet(db as Parameters<typeof insertWallet>[0], {
      chain: "eth",
      address: "0xdddddddddddddddddddddddddddddddddddddddd",
      label: "Auto-copy wallet",
      active: true,
    });
    expect(inserted.autoCopy).toBe(true);

    await setWalletAutoCopy(db as Parameters<typeof setWalletAutoCopy>[0], inserted.id, false);
    const all = await getAllWallets(db as Parameters<typeof getAllWallets>[0]);
    const reloaded = all.find((w) => w.id === inserted.id);
    expect(reloaded?.autoCopy).toBe(false);
    // Auto-copy off must not affect watching: the wallet is still active/scored.
    expect(reloaded?.active).toBe(true);
  });
});

describe("chainState repository", () => {
  it("returns null when no state exists", async () => {
    const block = await getLastBlock(db as Parameters<typeof getLastBlock>[0], "eth");
    expect(block).toBeNull();
  });

  it("upserts and retrieves last block", async () => {
    await upsertLastBlock(db as Parameters<typeof upsertLastBlock>[0], "eth", 19_000_000);
    expect(await getLastBlock(db as Parameters<typeof getLastBlock>[0], "eth")).toBe(19_000_000);
    await upsertLastBlock(db as Parameters<typeof upsertLastBlock>[0], "eth", 19_000_001);
    expect(await getLastBlock(db as Parameters<typeof getLastBlock>[0], "eth")).toBe(19_000_001);
  });
});

describe("candidate review repositories", () => {
  async function insertTestSignal(overrides: Partial<Parameters<typeof insertSignal>[1]> = {}) {
    const chain = overrides.chain ?? "eth";
    const wallet = await insertWallet(db as Parameters<typeof insertWallet>[0], {
      chain,
      address: `0x${Math.random().toString(16).slice(2).padEnd(40, "0").slice(0, 40)}`,
      label: "Review leader",
      active: true,
    });
    const now = Date.now();
    return insertSignal(db as Parameters<typeof insertSignal>[0], {
      id: randomUUID(),
      chain,
      walletId: wallet.id,
      txHash: `0x${randomUUID().replace(/-/g, "").padEnd(64, "0").slice(0, 64)}`,
      source: "confirmed",
      side: "buy",
      tokenIn: { chain, address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", symbol: "USDC", decimals: 6 },
      tokenOut: { chain, address: "0x1111111111111111111111111111111111111111", symbol: "TEST", decimals: 18 },
      amountIn: 100_000_000n,
      amountOut: 1_000_000_000_000_000_000n,
      venue: "balance-delta",
      observedAt: now,
      confirmedAt: now,
      blockNumber: 1,
      decodeStatus: "candidate",
      confidence: 0.52,
      reason: "review before copying",
      ...overrides,
    });
  }

  it("defaults candidates to pending and lists only open review statuses", async () => {
    const pendingId = await insertTestSignal();
    const dismissedId = await insertTestSignal({ tokenOut: { chain: "eth", address: "0x2222222222222222222222222222222222222222", symbol: "DONE", decimals: 18 } });
    await insertTestSignal({ decodeStatus: "decoded" });

    await setCandidateReviewStatus(db as Parameters<typeof setCandidateReviewStatus>[0], dismissedId, "dismissed");

    const candidates = await getCandidateSignals(db as Parameters<typeof getCandidateSignals>[0], 10);
    expect(candidates.map((signal) => signal.id)).toContain(pendingId);
    expect(candidates.map((signal) => signal.id)).not.toContain(dismissedId);
    expect(candidates.find((signal) => signal.id === pendingId)?.reviewStatus).toBe("pending");
  });

  it("filters candidates by chain and venue", async () => {
    const evmId = await insertTestSignal({ venue: "balance-delta" });
    const polymarketId = await insertTestSignal({
      chain: "polygon",
      venue: "polymarket",
      tokenIn: { chain: "polygon", address: "0x0000000000000000000000000000000000000001", symbol: "USDC", decimals: 6 },
      tokenOut: { chain: "polygon", address: "0x0000000000000000000000000000000000000002", symbol: "YES", decimals: 6 },
    });

    const polygon = await getCandidateSignals(db as Parameters<typeof getCandidateSignals>[0], 10, { chain: "polygon" });
    expect(polygon.map((signal) => signal.id)).toEqual([polymarketId]);

    const polymarket = await getCandidateSignals(db as Parameters<typeof getCandidateSignals>[0], 10, { venue: "polymarket" });
    expect(polymarket.map((signal) => signal.id)).toEqual([polymarketId]);

    const eth = await getCandidateSignals(db as Parameters<typeof getCandidateSignals>[0], 10, { chain: "eth" });
    expect(eth.map((signal) => signal.id)).toEqual([evmId]);
  });

  it("filters candidates by review status", async () => {
    const pendingId = await insertTestSignal();
    const legacyPendingId = await insertTestSignal({ tokenOut: { chain: "eth", address: "0x3333333333333333333333333333333333333333", symbol: "OLD", decimals: 18 } });
    const requestedId = await insertTestSignal({ tokenOut: { chain: "eth", address: "0x4444444444444444444444444444444444444444", symbol: "REQ", decimals: 18 } });
    const dismissedId = await insertTestSignal({ tokenOut: { chain: "eth", address: "0x5555555555555555555555555555555555555555", symbol: "NOPE", decimals: 18 } });

    await db
      .update(schema.tradeSignals)
      .set({ reviewStatus: null })
      .where(eq(schema.tradeSignals.id, legacyPendingId));
    await setCandidateReviewStatus(db as Parameters<typeof setCandidateReviewStatus>[0], requestedId, "copy-requested");
    await setCandidateReviewStatus(db as Parameters<typeof setCandidateReviewStatus>[0], dismissedId, "dismissed");

    const pending = await getCandidateSignals(db as Parameters<typeof getCandidateSignals>[0], 10, { status: "pending" });
    expect(pending.map((signal) => signal.id)).toEqual(expect.arrayContaining([pendingId, legacyPendingId]));
    expect(pending.map((signal) => signal.id)).not.toContain(requestedId);

    const requested = await getCandidateSignals(db as Parameters<typeof getCandidateSignals>[0], 10, { status: "copy-requested" });
    expect(requested.map((signal) => signal.id)).toEqual([requestedId]);

    const dismissed = await getCandidateSignals(db as Parameters<typeof getCandidateSignals>[0], 10, { status: "dismissed" });
    expect(dismissed.map((signal) => signal.id)).toEqual([dismissedId]);
  });

  it("summarizes open candidate triage by chain, venue, and status", async () => {
    const older = new Date("2026-06-19T12:00:00.000Z").getTime();
    const newer = new Date("2026-06-19T12:05:00.000Z").getTime();
    await insertTestSignal({ observedAt: older, confirmedAt: older });
    const legacyPendingId = await insertTestSignal({
      tokenOut: { chain: "eth", address: "0x6666666666666666666666666666666666666666", symbol: "LEGACY", decimals: 18 },
      observedAt: newer,
      confirmedAt: newer,
    });
    const requestedId = await insertTestSignal({
      tokenOut: { chain: "eth", address: "0x7777777777777777777777777777777777777777", symbol: "REQ", decimals: 18 },
      venue: "uniswap-v4",
      observedAt: older + 1_000,
      confirmedAt: older + 1_000,
    });
    const failedId = await insertTestSignal({
      chain: "polygon",
      venue: "polymarket",
      tokenIn: { chain: "polygon", address: "0x0000000000000000000000000000000000000001", symbol: "USDC", decimals: 6 },
      tokenOut: { chain: "polygon", address: "0x0000000000000000000000000000000000000002", symbol: "YES", decimals: 6 },
      observedAt: older + 2_000,
      confirmedAt: older + 2_000,
    });
    const dismissedId = await insertTestSignal({
      tokenOut: { chain: "eth", address: "0x8888888888888888888888888888888888888888", symbol: "DONE", decimals: 18 },
      observedAt: older + 3_000,
      confirmedAt: older + 3_000,
    });

    await db
      .update(schema.tradeSignals)
      .set({ reviewStatus: null })
      .where(eq(schema.tradeSignals.id, legacyPendingId));
    await setCandidateReviewStatus(db as Parameters<typeof setCandidateReviewStatus>[0], requestedId, "copy-requested");
    await setCandidateReviewStatus(db as Parameters<typeof setCandidateReviewStatus>[0], failedId, "copy-failed");
    await setCandidateReviewStatus(db as Parameters<typeof setCandidateReviewStatus>[0], dismissedId, "dismissed");

    const summary = await getCandidateTriageSummary(db as Parameters<typeof getCandidateTriageSummary>[0]);

    expect(summary.totalOpen).toBe(4);
    expect(summary.groups).toHaveLength(3);
    expect(summary.groups).toContainEqual({
      chain: "eth",
      venue: "balance-delta",
      status: "pending",
      count: 2,
      oldestObservedAt: older,
      newestObservedAt: newer,
    });
    expect(summary.groups).toContainEqual({
      chain: "eth",
      venue: "uniswap-v4",
      status: "copy-requested",
      count: 1,
      oldestObservedAt: older + 1_000,
      newestObservedAt: older + 1_000,
    });
    expect(summary.groups).toContainEqual({
      chain: "polygon",
      venue: "polymarket",
      status: "copy-failed",
      count: 1,
      oldestObservedAt: older + 2_000,
      newestObservedAt: older + 2_000,
    });
  });

  it("moves candidates into the copy-requested queue", async () => {
    const id = await insertTestSignal();
    const updated = await setCandidateReviewStatus(db as Parameters<typeof setCandidateReviewStatus>[0], id, "copy-requested");
    expect(updated?.reviewStatus).toBe("copy-requested");

    const requested = await getCopyRequestedCandidates(db as Parameters<typeof getCopyRequestedCandidates>[0], 10);
    expect(requested).toHaveLength(1);
    expect(requested[0]?.id).toBe(id);
  });

  it("guards candidate review status transitions by current status", async () => {
    const id = await insertTestSignal();
    await setCandidateReviewStatus(db as Parameters<typeof setCandidateReviewStatus>[0], id, "copy-requested");

    const wrongCurrent = await transitionCandidateReviewStatus(
      db as Parameters<typeof transitionCandidateReviewStatus>[0],
      id,
      ["copying"],
      "pending",
    );
    expect(wrongCurrent).toBeNull();
    expect((await getSignalById(db as Parameters<typeof getSignalById>[0], id))?.reviewStatus).toBe("copy-requested");

    const claimed = await transitionCandidateReviewStatus(
      db as Parameters<typeof transitionCandidateReviewStatus>[0],
      id,
      ["copy-requested"],
      "copying",
    );
    expect(claimed?.reviewStatus).toBe("copying");

    const staleFinal = await transitionCandidateReviewStatus(
      db as Parameters<typeof transitionCandidateReviewStatus>[0],
      id,
      ["copy-requested"],
      "copied",
    );
    expect(staleFinal).toBeNull();

    const failed = await transitionCandidateReviewStatus(
      db as Parameters<typeof transitionCandidateReviewStatus>[0],
      id,
      ["copying"],
      "copy-failed",
    );
    expect(failed?.reviewStatus).toBe("copy-failed");
  });

  it("preserves candidate external URLs", async () => {
    const id = await insertTestSignal({ externalUrl: "https://polymarket.com/event/test-market" });
    const signal = await getSignalById(db as Parameters<typeof getSignalById>[0], id);
    expect(signal?.externalUrl).toBe("https://polymarket.com/event/test-market");
  });

  it("round-trips persisted Polymarket condition metadata", async () => {
    const id = await insertTestSignal({
      chain: "polygon",
      venue: "polymarket",
      tokenIn: { chain: "polygon", address: "0x0000000000000000000000000000000000000001", symbol: "USDC", decimals: 6 },
      tokenOut: { chain: "polygon", address: "0x0000000000000000000000000000000000000002", symbol: "YES", decimals: 6 },
      conditionId: "0xcondition",
      outcomeIndex: 1,
    });
    const signal = await getSignalById(db as Parameters<typeof getSignalById>[0], id);
    expect(signal?.conditionId).toBe("0xcondition");
    expect(signal?.outcomeIndex).toBe(1);
  });

  it("hydrates signal token names from stored token metadata", async () => {
    await upsertToken(db as Parameters<typeof upsertToken>[0], {
      chain: "eth",
      address: "0x1111111111111111111111111111111111111111",
      symbol: "TEST",
      name: "Test Token",
      decimals: 18,
      isBlocked: false,
    });
    const id = await insertTestSignal();

    const signals = await getRecentSignals(db as Parameters<typeof getRecentSignals>[0], new Date(Date.now() - 60_000), 10);
    const signal = signals.find((row) => row.id === id);
    expect(signal?.tokenOut.symbol).toBe("TEST");
    expect(signal?.tokenOut.name).toBe("Test Token");
  });

  it("hydrates native placeholder signal tokens as ETH", async () => {
    const wallet = await insertWallet(db as Parameters<typeof insertWallet>[0], {
      chain: "base",
      address: "0x7777777777777777777777777777777777777777",
      label: "Native candidate",
      active: true,
    });
    await insertSignal(db as Parameters<typeof insertSignal>[0], {
      id: "77777777-7777-4777-8777-777777777777",
      chain: "base",
      walletId: wallet.id,
      txHash: "0x7777777777777777777777777777777777777777777777777777777777777777",
      source: "confirmed",
      side: "buy",
      tokenIn: { chain: "base", address: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", symbol: "", decimals: 18 },
      tokenOut: { chain: "base", address: "0x6faa000000000000000000000000000000001ba3", symbol: "SLAY", decimals: 18 },
      amountIn: 1n,
      amountOut: 1n,
      venue: "balance-delta",
      observedAt: Date.now(),
      confirmedAt: Date.now(),
      blockNumber: 1,
      decodeStatus: "candidate",
    });

    const signal = await getSignalById(db as Parameters<typeof getSignalById>[0], "77777777-7777-4777-8777-777777777777");

    expect(signal?.tokenIn.symbol).toBe("ETH");
    expect(signal?.tokenIn.name).toBe("Ether");
  });
});

describe("paperFills repository", () => {
  it("preserves the signal chain when reading fills", async () => {
    const wallet = await insertWallet(db as Parameters<typeof insertWallet>[0], {
      chain: "base",
      address: "0x1111111111111111111111111111111111111111",
      label: "Base leader",
      active: true,
    });

    const observedAt = Date.now();
    await upsertToken(db as Parameters<typeof upsertToken>[0], {
      chain: "base",
      address: "0x4b9834edf361f5b7a2b7ac7aed3687304ba1aba3",
      symbol: "cbBTC",
      name: "Coinbase Wrapped BTC",
      decimals: 8,
      isBlocked: false,
    });
    await insertSignal(db as Parameters<typeof insertSignal>[0], {
      id: "11111111-1111-4111-8111-111111111111",
      chain: "base",
      walletId: wallet.id,
      txHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      source: "confirmed",
      side: "buy",
      tokenIn: { chain: "base", address: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", symbol: "", decimals: 18 },
      tokenOut: { chain: "base", address: "0x4b9834edf361f5b7a2b7ac7aed3687304ba1aba3", symbol: "", decimals: 18 },
      amountIn: 1n,
      amountOut: 1n,
      venue: "balance-delta",
      observedAt,
      confirmedAt: observedAt,
      blockNumber: 1,
      decodeStatus: "decoded",
    });

    await insertFill(db as Parameters<typeof insertFill>[0], {
      id: "22222222-2222-4222-8222-222222222222",
      signalId: "11111111-1111-4111-8111-111111111111",
      decidedAt: observedAt,
      decision: "skipped",
      skipReason: "no-liquidity-data",
      side: "buy",
      token: { chain: "base", address: "0x4b9834edf361f5b7a2b7ac7aed3687304ba1aba3", symbol: "", decimals: 18 },
      quoteToken: { chain: "base", address: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", symbol: "", decimals: 18 },
      qty: 0,
      priceUsd: 0,
      notionalUsd: 0,
      feeUsd: 0,
      slippageBps: 0,
      latencyMs: 0,
      provisional: false,
    });

    const fills = await getRecentFills(db as Parameters<typeof getRecentFills>[0], new Date(observedAt - 1_000), 10);
    expect(fills).toHaveLength(1);
    expect(fills[0]?.token.chain).toBe("base");
    expect(fills[0]?.token.symbol).toBe("cbBTC");
    expect(fills[0]?.token.name).toBe("Coinbase Wrapped BTC");
    expect(fills[0]?.quoteToken.chain).toBe("base");
    expect(fills[0]?.quoteToken.symbol).toBe("ETH");
    expect(fills[0]?.quoteToken.name).toBe("Ether");
  });
});

describe("analytics repository", () => {
  it("aggregates fills and positions into portfolio analytics", async () => {
    const wallet = await insertWallet(db as Parameters<typeof insertWallet>[0], {
      chain: "eth",
      address: "0x9999999999999999999999999999999999999999",
      label: "Analytics leader",
      active: true,
    });
    const now = Date.now();
    await insertSignal(db as Parameters<typeof insertSignal>[0], {
      id: "33333333-3333-4333-8333-333333333333",
      chain: "eth",
      walletId: wallet.id,
      txHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      source: "confirmed",
      side: "buy",
      tokenIn: { chain: "eth", address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", symbol: "USDC", decimals: 6 },
      tokenOut: { chain: "eth", address: "0xaaaa000000000000000000000000000000000001", symbol: "AAA", decimals: 18 },
      amountIn: 1n,
      amountOut: 1n,
      venue: "balance-delta",
      observedAt: now,
      confirmedAt: now,
      blockNumber: 1,
      decodeStatus: "decoded",
    });

    // One copied fill ($1000 notional, $30 fees) and one skipped fill.
    await insertFill(db as Parameters<typeof insertFill>[0], {
      id: "44444444-4444-4444-8444-444444444444",
      signalId: "33333333-3333-4333-8333-333333333333",
      decidedAt: now,
      decision: "copied",
      side: "buy",
      token: { chain: "eth", address: "0xaaaa000000000000000000000000000000000001", symbol: "AAA", decimals: 18 },
      quoteToken: { chain: "eth", address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", symbol: "USDC", decimals: 6 },
      qty: 100, priceUsd: 10, notionalUsd: 1000, feeUsd: 30, slippageBps: 40, latencyMs: 10, provisional: false,
    });
    await insertFill(db as Parameters<typeof insertFill>[0], {
      id: "55555555-5555-4555-8555-555555555555",
      signalId: "33333333-3333-4333-8333-333333333333",
      decidedAt: now,
      decision: "skipped",
      skipReason: "below-min-liquidity",
      side: "buy",
      token: { chain: "eth", address: "0xaaaa000000000000000000000000000000000001", symbol: "AAA", decimals: 18 },
      quoteToken: { chain: "eth", address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", symbol: "USDC", decimals: 6 },
      qty: 0, priceUsd: 0, notionalUsd: 0, feeUsd: 0, slippageBps: 0, latencyMs: 0, provisional: false,
    });

    // One open position (cost basis $50) and one closed winner (+$100).
    await upsertPosition(db as Parameters<typeof upsertPosition>[0], {
      chain: "eth", tokenAddress: "0xaaaa000000000000000000000000000000000001",
      qty: 10, avgCostUsd: 5, realizedPnlUsd: 0, sourceWalletId: wallet.id,
    });
    await upsertPosition(db as Parameters<typeof upsertPosition>[0], {
      chain: "eth", tokenAddress: "0xbbbb000000000000000000000000000000000002",
      qty: 5, avgCostUsd: 4, realizedPnlUsd: 0, sourceWalletId: wallet.id,
    });
    await closePositionByKey(db as Parameters<typeof closePositionByKey>[0], {
      chain: "eth", tokenAddress: "0xbbbb000000000000000000000000000000000002",
      sourceWalletId: wallet.id, realizedPnlUsd: 100,
    });

    const a = await getPortfolioAnalytics(db as Parameters<typeof getPortfolioAnalytics>[0]);
    expect(a.copiedFills).toBe(1);
    expect(a.skippedFills).toBe(1);
    expect(a.skipRate).toBeCloseTo(0.5, 10);
    expect(a.totalFeesUsd).toBeCloseTo(30, 10);
    expect(a.feeDrag).toBeCloseTo(0.03, 10);
    expect(a.closedTrades).toBe(1);
    expect(a.winningTrades).toBe(1);
    expect(a.realizedPnlUsd).toBeCloseTo(100, 10);
    expect(a.openExposureUsd).toBeCloseTo(50, 10);
    expect(a.byToken[0]).toMatchObject({ tokenAddress: "0xbbbb000000000000000000000000000000000002", realizedPnlUsd: 100 });
  });
});

describe("getV4MarketHintForToken", () => {
  const WETH = "0x4200000000000000000000000000000000000006";
  const V4_TOKEN = "0xb4b4000000000000000000000000000000000004";
  const POOL_ID = "0xabc1230000000000000000000000000000000000000000000000000000000000";

  async function insertV4Signal(side: "buy" | "sell") {
    const wallet = await insertWallet(db as Parameters<typeof insertWallet>[0], {
      chain: "base",
      address: `0x${Math.random().toString(16).slice(2).padEnd(40, "0").slice(0, 40)}`,
      label: "V4 leader",
      active: true,
    });
    const now = Date.now();
    // On a buy the traded token is tokenOut and the counter (quote) is tokenIn; reversed on a sell.
    const token = { chain: "base" as const, address: V4_TOKEN, symbol: "V4T", decimals: 18 };
    const weth = { chain: "base" as const, address: WETH, symbol: "WETH", decimals: 18 };
    await insertSignal(db as Parameters<typeof insertSignal>[0], {
      id: randomUUID(),
      chain: "base",
      walletId: wallet.id,
      txHash: `0x${randomUUID().replace(/-/g, "").padEnd(64, "0").slice(0, 64)}`,
      source: "confirmed",
      side,
      tokenIn: side === "buy" ? weth : token,
      tokenOut: side === "buy" ? token : weth,
      amountIn: 1_000_000_000_000_000_000n,
      amountOut: 1_000_000_000_000_000_000n,
      venue: "uniswap-v4",
      observedAt: now,
      confirmedAt: now,
      blockNumber: 1,
      decodeStatus: "decoded",
      poolId: POOL_ID,
    });
  }

  it("recovers the poolId and counter currency from a V4 buy signal", async () => {
    await insertV4Signal("buy");
    const hint = await getV4MarketHintForToken(db as Parameters<typeof getV4MarketHintForToken>[0], "base", V4_TOKEN);
    expect(hint).toEqual({ poolId: POOL_ID, counterCurrency: WETH });
  });

  it("recovers the hint from a V4 sell signal (counter on the other leg)", async () => {
    await insertV4Signal("sell");
    const hint = await getV4MarketHintForToken(db as Parameters<typeof getV4MarketHintForToken>[0], "base", V4_TOKEN);
    expect(hint).toEqual({ poolId: POOL_ID, counterCurrency: WETH });
  });

  it("returns null for a token with no poolId-bearing signal", async () => {
    await insertV4Signal("buy");
    const hint = await getV4MarketHintForToken(db as Parameters<typeof getV4MarketHintForToken>[0], "base", "0xdead000000000000000000000000000000000000");
    expect(hint).toBeNull();
  });
});
