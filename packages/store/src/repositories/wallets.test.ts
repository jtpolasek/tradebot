import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import * as schema from "../schema.js";
import { insertWallet, getActiveWallets, setWalletActive } from "./wallets.js";
import { getLastBlock, upsertLastBlock } from "./chainState.js";

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
});

describe("wallets repository", () => {
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
