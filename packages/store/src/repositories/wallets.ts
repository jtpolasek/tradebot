import { eq, and } from "drizzle-orm";
import type { Db } from "../db.js";
import { wallets } from "../schema.js";
import type { TrackedWallet, ChainId } from "@tradebot/core";

export async function insertWallet(
  db: Db,
  wallet: Omit<TrackedWallet, "id" | "addedAt">
): Promise<TrackedWallet> {
  const rows = await db
    .insert(wallets)
    .values({
      chain: wallet.chain,
      address: wallet.address.toLowerCase(),
      label: wallet.label,
      active: wallet.active,
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
  return rows.map(rowToWallet);
}

export async function getWalletById(db: Db, id: string): Promise<TrackedWallet | null> {
  const rows = await db.select().from(wallets).where(eq(wallets.id, id));
  return rows[0] ? rowToWallet(rows[0]) : null;
}

export async function setWalletActive(db: Db, id: string, active: boolean): Promise<void> {
  await db.update(wallets).set({ active }).where(eq(wallets.id, id));
}

export async function getAllWallets(db: Db): Promise<TrackedWallet[]> {
  const rows = await db.select().from(wallets);
  return rows.map(rowToWallet);
}

function rowToWallet(row: typeof wallets.$inferSelect): TrackedWallet {
  return {
    id: row.id,
    chain: row.chain as ChainId,
    address: row.address,
    label: row.label,
    active: row.active,
    addedAt: row.addedAt,
  };
}
