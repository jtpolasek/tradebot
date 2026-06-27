import { eq, and, sql } from "drizzle-orm";
import type { Db } from "../db.js";
import { wallets } from "../schema.js";
import type { TrackedWallet, ChainId } from "@tradebot/core";
import { normalizeAddress } from "@tradebot/core";

export async function insertWallet(
  db: Db,
  // `autoAdded` is set only by the prospect-discovery finder; a human-added leader leaves it false
  // (the default), which keeps it out of the retraction sweep regardless of humanTouched.
  wallet: Omit<TrackedWallet, "id" | "addedAt" | "autoCopy"> & { autoCopy?: boolean; autoAdded?: boolean }
): Promise<TrackedWallet> {
  const rows = await db
    .insert(wallets)
    .values({
      chain: wallet.chain,
      address: normalizeAddress(wallet.address),
      label: wallet.label,
      active: wallet.active,
      autoCopy: wallet.autoCopy ?? true,
      autoAdded: wallet.autoAdded ?? false,
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error("Insert failed");
  return rowToWallet(row);
}

export async function getActiveWallets(db: Db, chain?: ChainId): Promise<TrackedWallet[]> {
  const rows = chain
    ? await db.select().from(wallets).where(and(eq(wallets.active, true), eq(wallets.chain, chain)))
    : await db.select().from(wallets).where(eq(wallets.active, true));
  return rows.map(rowToWallet).filter((wallet) => isValidAddress(wallet.address));
}

export async function getWalletById(db: Db, id: string): Promise<TrackedWallet | null> {
  const rows = await db.select().from(wallets).where(eq(wallets.id, id));
  return rows[0] ? rowToWallet(rows[0]) : null;
}

export async function setWalletActive(db: Db, id: string, active: boolean): Promise<void> {
  await db.update(wallets).set({ active }).where(eq(wallets.id, id));
}

export async function setWalletAutoCopy(db: Db, id: string, autoCopy: boolean): Promise<void> {
  await db.update(wallets).set({ autoCopy }).where(eq(wallets.id, id));
}

/**
 * Mark a leader as human-touched, making it sacrosanct to the discovery retraction sweep. Call this
 * from the human/API layer only (route handlers), never inside setWalletActive/setWalletAutoCopy —
 * the retraction sweep calls those to un-watch its own promotions and must not flag them touched.
 */
export async function markWalletHumanTouched(db: Db, id: string): Promise<void> {
  await db.update(wallets).set({ humanTouched: true }).where(eq(wallets.id, id));
}

export async function getAllWallets(db: Db): Promise<TrackedWallet[]> {
  const rows = await db.select().from(wallets);
  return rows.map(rowToWallet);
}

/**
 * Active Polygon leaders eligible for the discovery retraction sweep: finder-added, never
 * human-touched, auto-copy still off (observe-first). Human-added or human-touched leaders are
 * sacrosanct and excluded. The sweep un-watches the weakest of these to free capacity (ADR 0005 §8).
 */
export async function getRetractableAutoLeaders(db: Db): Promise<TrackedWallet[]> {
  const rows = await db
    .select()
    .from(wallets)
    .where(
      and(
        eq(wallets.chain, "polygon"),
        eq(wallets.active, true),
        eq(wallets.autoAdded, true),
        eq(wallets.humanTouched, false),
        eq(wallets.autoCopy, false),
      ),
    );
  return rows.map(rowToWallet);
}

/** Count of active Polygon leaders — the discovery cap (`PROSPECT_MAX_LEADERS`) is measured against this. */
export async function countActivePolygonLeaders(db: Db): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(wallets)
    .where(and(eq(wallets.chain, "polygon"), eq(wallets.active, true)));
  return rows[0]?.count ?? 0;
}

function rowToWallet(row: typeof wallets.$inferSelect): TrackedWallet {
  return {
    id: row.id,
    chain: row.chain as ChainId,
    address: row.address,
    label: row.label,
    active: row.active,
    autoCopy: row.autoCopy,
    addedAt: row.addedAt,
  };
}

function isValidAddress(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}
