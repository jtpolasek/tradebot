import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { randomUUID } from "crypto";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import type { RunnerHealthPayload } from "@tradebot/core";
import * as schema from "../schema.js";
import { upsertRunnerHealth, getRunnerHealth, latestSignalAt, latestFillAt } from "./runnerHealth.js";
import { getChainStatesUpdatedAt, upsertLastBlock } from "./chainState.js";
import { insertWallet } from "./wallets.js";
import { insertSignal } from "./signals.js";
import { insertFill } from "./paperFills.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const url = process.env["TEST_DATABASE_URL"];
if (!url) throw new Error("TEST_DATABASE_URL is not set — run docker compose --profile test up -d db-test");
if (!url.includes("_test")) throw new Error("TEST_DATABASE_URL must point to a database ending in _test");

let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;

beforeAll(async () => {
  client = postgres(url, { max: 1 });
  db = drizzle(client, { schema }) as ReturnType<typeof drizzle<typeof schema>>;
  await migrate(db as Parameters<typeof migrate>[0], { migrationsFolder: resolve(__dirname, "../../drizzle") });
});

afterAll(async () => {
  await client.end();
});

beforeEach(async () => {
  await db.delete(schema.runnerHealth);
  await db.delete(schema.chainState);
  await db.delete(schema.paperFills);
  await db.delete(schema.tradeSignals);
  await db.delete(schema.wallets);
});

function samplePayload(): RunnerHealthPayload {
  return {
    pid: 4242,
    uptimeSec: 90,
    rssBytes: 123_456_789,
    heapUsedBytes: 12_345_678,
    chains: [
      { chain: "eth", connectionState: "connected", usingFallback: false, lastEventAt: Date.now(), connectFailures: 0, backfillCount: 1, walletCount: 2 },
    ],
  };
}

describe("runnerHealth repository", () => {
  it("returns null before any heartbeat is written", async () => {
    expect(await getRunnerHealth(db as Parameters<typeof getRunnerHealth>[0])).toBeNull();
  });

  it("upserts a single heartbeat row and reads it back", async () => {
    const payload = samplePayload();
    await upsertRunnerHealth(db as Parameters<typeof upsertRunnerHealth>[0], payload);
    const first = await getRunnerHealth(db as Parameters<typeof getRunnerHealth>[0]);
    expect(first?.payload.pid).toBe(4242);
    expect(first?.payload.chains[0]?.chain).toBe("eth");
    expect(typeof first?.ts).toBe("number");

    // A second write overwrites the same row (single 'runner' id), not appends.
    await upsertRunnerHealth(db as Parameters<typeof upsertRunnerHealth>[0], { ...payload, pid: 9999 });
    const rows = await db.select().from(schema.runnerHealth);
    expect(rows).toHaveLength(1);
    const second = await getRunnerHealth(db as Parameters<typeof getRunnerHealth>[0]);
    expect(second?.payload.pid).toBe(9999);
  });

  it("reads per-chain chain_state freshness", async () => {
    await upsertLastBlock(db as Parameters<typeof upsertLastBlock>[0], "eth", 100);
    const fresh = await getChainStatesUpdatedAt(db as Parameters<typeof getChainStatesUpdatedAt>[0]);
    expect(typeof fresh.eth).toBe("number");
    expect(fresh.base).toBeUndefined();
  });

  it("returns null signal/fill freshness on an empty DB and a timestamp once rows exist", async () => {
    expect(await latestSignalAt(db as Parameters<typeof latestSignalAt>[0])).toBeNull();
    expect(await latestFillAt(db as Parameters<typeof latestFillAt>[0])).toBeNull();

    const wallet = await insertWallet(db as Parameters<typeof insertWallet>[0], {
      chain: "eth",
      address: "0x1212121212121212121212121212121212121212",
      label: "HB leader",
      active: true,
    });
    const now = Date.now();
    const signalId = randomUUID();
    await insertSignal(db as Parameters<typeof insertSignal>[0], {
      id: signalId,
      chain: "eth",
      walletId: wallet.id,
      txHash: `0x${randomUUID().replace(/-/g, "").padEnd(64, "0").slice(0, 64)}`,
      source: "confirmed",
      side: "buy",
      tokenIn: { chain: "eth", address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", symbol: "USDC", decimals: 6 },
      tokenOut: { chain: "eth", address: "0x3434343434343434343434343434343434343434", symbol: "HB", decimals: 18 },
      amountIn: 1n,
      amountOut: 1n,
      venue: "balance-delta",
      observedAt: now,
      confirmedAt: now,
      blockNumber: 1,
      decodeStatus: "decoded",
    });
    await insertFill(db as Parameters<typeof insertFill>[0], {
      id: randomUUID(),
      signalId,
      decidedAt: now,
      decision: "skipped",
      skipReason: "no-liquidity-data",
      side: "buy",
      token: { chain: "eth", address: "0x3434343434343434343434343434343434343434", symbol: "HB", decimals: 18 },
      quoteToken: { chain: "eth", address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", symbol: "USDC", decimals: 6 },
      qty: 0, priceUsd: 0, notionalUsd: 0, feeUsd: 0, slippageBps: 0, latencyMs: 0, provisional: false,
    });

    expect(await latestSignalAt(db as Parameters<typeof latestSignalAt>[0])).not.toBeNull();
    expect(await latestFillAt(db as Parameters<typeof latestFillAt>[0])).not.toBeNull();
  });
});
