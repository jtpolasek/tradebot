import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import * as schema from "../schema.js";
import {
  upsertProspectEvaluation,
  getRecentlyRejected,
  getProspect,
  getDiscoveryState,
  setDiscoveryState,
} from "./prospects.js";
import {
  insertWallet,
  setWalletActive,
  setWalletAutoCopy,
  markWalletHumanTouched,
  getRetractableAutoLeaders,
  countActivePolygonLeaders,
} from "./wallets.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const url = process.env["TEST_DATABASE_URL"];
if (!url) throw new Error("TEST_DATABASE_URL is not set — run docker compose --profile test up -d db-test");
if (!url.includes("_test")) throw new Error("TEST_DATABASE_URL must point to a database ending in _test");

let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;
type AnyDb = Parameters<typeof upsertProspectEvaluation>[0];

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
  // Clear everything that FK-references wallets before deleting wallets themselves.
  await db.delete(schema.prospects);
  await db.delete(schema.prospectDiscoveryState);
  await db.delete(schema.polymarketPollState);
  await db.delete(schema.paperFills);
  await db.delete(schema.tradeSignals);
  await db.delete(schema.leaderStats);
  await db.delete(schema.positions);
  await db.delete(schema.wallets);
});

const ADDR = "0xabc0000000000000000000000000000000000001";

describe("prospects repository", () => {
  it("upserts an evaluation by address, preserving firstSeenAt across re-evaluation", async () => {
    await upsertProspectEvaluation(db as AnyDb, {
      address: ADDR,
      source: "leaderboard",
      userName: "alice",
      pnlUsd: 50_000,
      volUsd: 100_000,
      pnlPerVol: 0.5,
      verdict: "rejected",
      rejectReason: "too-few-trades",
    });
    const first = await getProspect(db as AnyDb, ADDR);
    expect(first?.verdict).toBe("rejected");
    expect(first?.pnlUsd).toBe(50_000);
    const firstSeenAt = first!.firstSeenAt;

    await new Promise((r) => setTimeout(r, 5));
    await upsertProspectEvaluation(db as AnyDb, {
      address: ADDR,
      source: "leaderboard",
      userName: "alice",
      pnlUsd: 60_000,
      volUsd: 100_000,
      pnlPerVol: 0.6,
      tradeCount: 42,
      score: 0.6,
      verdict: "promoted",
    });
    const second = await getProspect(db as AnyDb, ADDR);
    expect(second?.verdict).toBe("promoted");
    expect(second?.pnlUsd).toBe(60_000);
    expect(second?.tradeCount).toBe(42);
    expect(second?.firstSeenAt.getTime()).toBe(firstSeenAt.getTime());
    expect(second!.lastEvaluatedAt.getTime()).toBeGreaterThanOrEqual(firstSeenAt.getTime());
  });

  it("getRecentlyRejected returns only rejections inside the cooldown window", async () => {
    // Rejected just now — inside the window.
    await upsertProspectEvaluation(db as AnyDb, {
      address: ADDR,
      source: "leaderboard",
      verdict: "rejected",
      rejectReason: "low-pnl",
    });
    // A promoted prospect must never appear in the cooldown set.
    const promotedAddr = "0xabc0000000000000000000000000000000000002";
    await upsertProspectEvaluation(db as AnyDb, {
      address: promotedAddr,
      source: "leaderboard",
      verdict: "promoted",
    });
    // A rejection older than the window (back-date lastEvaluatedAt) is excluded.
    const staleAddr = "0xabc0000000000000000000000000000000000003";
    await upsertProspectEvaluation(db as AnyDb, {
      address: staleAddr,
      source: "leaderboard",
      verdict: "rejected",
      rejectReason: "stale",
    });
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    await db
      .update(schema.prospects)
      .set({ lastEvaluatedAt: tenDaysAgo })
      .where(eq(schema.prospects.address, staleAddr));

    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const recent = await getRecentlyRejected(db as AnyDb, since);
    expect(recent).toContain(ADDR);
    expect(recent).not.toContain(promotedAddr);
    expect(recent).not.toContain(staleAddr);
  });

  it("discovery state is a clearable singleton", async () => {
    expect(await getDiscoveryState(db as AnyDb)).toBeNull();

    // A failed run records lastError without a lastRunAt.
    await setDiscoveryState(db as AnyDb, { lastError: "boom" });
    expect(await getDiscoveryState(db as AnyDb)).toMatchObject({ lastError: "boom", promotedLastRun: 0 });

    // A successful run sets lastRunAt and promotedLastRun and clears the error.
    const ran = new Date();
    await setDiscoveryState(db as AnyDb, { lastRunAt: ran, lastError: null, promotedLastRun: 2 });
    const state = await getDiscoveryState(db as AnyDb);
    expect(state?.lastError).toBeNull();
    expect(state?.promotedLastRun).toBe(2);
    expect(state?.lastRunAt?.getTime()).toBe(ran.getTime());

    // A partial update leaves untouched fields intact (lastRunAt survives).
    await setDiscoveryState(db as AnyDb, { promotedLastRun: 5 });
    const after = await getDiscoveryState(db as AnyDb);
    expect(after?.promotedLastRun).toBe(5);
    expect(after?.lastRunAt?.getTime()).toBe(ran.getTime());
  });
});

describe("retraction-sweep eligibility", () => {
  async function insertPolygonLeader(
    address: string,
    opts: { autoAdded?: boolean; autoCopy?: boolean } = {},
  ) {
    return insertWallet(db as Parameters<typeof insertWallet>[0], {
      chain: "polygon",
      address,
      label: address,
      active: true,
      autoCopy: opts.autoCopy ?? false,
      autoAdded: opts.autoAdded ?? false,
    });
  }

  it("getRetractableAutoLeaders includes only finder-added, untouched, auto-copy-off, active leaders", async () => {
    const eligible = await insertPolygonLeader("0xa00000000000000000000000000000000000000a", { autoAdded: true });

    // Human-added leader (autoAdded false) — never retractable.
    await insertPolygonLeader("0xa00000000000000000000000000000000000000b", { autoAdded: false });
    // Auto-added but auto-copy turned on — a human enabled copying, so excluded.
    await insertPolygonLeader("0xa00000000000000000000000000000000000000c", { autoAdded: true, autoCopy: true });
    // Auto-added but human-touched — sacrosanct.
    const touched = await insertPolygonLeader("0xa00000000000000000000000000000000000000d", { autoAdded: true });
    await markWalletHumanTouched(db as Parameters<typeof markWalletHumanTouched>[0], touched.id);
    // Auto-added but already un-watched (inactive) — frees no slot.
    const inactive = await insertPolygonLeader("0xa00000000000000000000000000000000000000e", { autoAdded: true });
    await setWalletActive(db as Parameters<typeof setWalletActive>[0], inactive.id, false);

    const retractable = await getRetractableAutoLeaders(db as Parameters<typeof getRetractableAutoLeaders>[0]);
    expect(retractable.map((w) => w.id)).toEqual([eligible.id]);
  });

  it("countActivePolygonLeaders counts active polygon wallets only", async () => {
    await insertPolygonLeader("0xa00000000000000000000000000000000000001a", { autoAdded: true });
    const off = await insertPolygonLeader("0xa00000000000000000000000000000000000001b");
    await setWalletActive(db as Parameters<typeof setWalletActive>[0], off.id, false);
    // An EVM leader must not be counted toward the Polygon cap.
    await insertWallet(db as Parameters<typeof insertWallet>[0], {
      chain: "eth",
      address: "0xa00000000000000000000000000000000000001c",
      label: "eth",
      active: true,
    });

    expect(await countActivePolygonLeaders(db as Parameters<typeof countActivePolygonLeaders>[0])).toBe(1);
  });

  it("a human toggling auto-copy on an auto-added leader makes it sacrosanct", async () => {
    const leader = await insertPolygonLeader("0xa00000000000000000000000000000000000002a", { autoAdded: true });
    // Simulate the human/API layer: toggle then mark touched (as the PATCH handler does).
    await setWalletAutoCopy(db as Parameters<typeof setWalletAutoCopy>[0], leader.id, true);
    await markWalletHumanTouched(db as Parameters<typeof markWalletHumanTouched>[0], leader.id);

    const retractable = await getRetractableAutoLeaders(db as Parameters<typeof getRetractableAutoLeaders>[0]);
    expect(retractable.map((w) => w.id)).not.toContain(leader.id);
  });
});
