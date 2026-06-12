import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { randomUUID } from "crypto";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import * as schema from "../schema.js";
import { insertWallet, getActiveWallets, setWalletActive } from "./wallets.js";
import { getLastBlock, upsertLastBlock } from "./chainState.js";
import { closeDb, getDb } from "../db.js";
import {
  insertSignal,
  getRecentSignals,
  getCandidateSignals,
  getCopyRequestedCandidates,
  setCandidateReviewStatus,
} from "./signals.js";
import { insertFill, getRecentFills } from "./paperFills.js";
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
    const wallet = await insertWallet(db as Parameters<typeof insertWallet>[0], {
      chain: "eth",
      address: `0x${Math.random().toString(16).slice(2).padEnd(40, "0").slice(0, 40)}`,
      label: "Review leader",
      active: true,
    });
    const now = Date.now();
    return insertSignal(db as Parameters<typeof insertSignal>[0], {
      id: randomUUID(),
      chain: "eth",
      walletId: wallet.id,
      txHash: `0x${randomUUID().replace(/-/g, "").padEnd(64, "0").slice(0, 64)}`,
      source: "confirmed",
      side: "buy",
      tokenIn: { chain: "eth", address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", symbol: "USDC", decimals: 6 },
      tokenOut: { chain: "eth", address: "0x1111111111111111111111111111111111111111", symbol: "TEST", decimals: 18 },
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

  it("moves candidates into the copy-requested queue", async () => {
    const id = await insertTestSignal();
    const updated = await setCandidateReviewStatus(db as Parameters<typeof setCandidateReviewStatus>[0], id, "copy-requested");
    expect(updated?.reviewStatus).toBe("copy-requested");

    const requested = await getCopyRequestedCandidates(db as Parameters<typeof getCopyRequestedCandidates>[0], 10);
    expect(requested).toHaveLength(1);
    expect(requested[0]?.id).toBe(id);
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
  });
});
