import { eq } from "drizzle-orm";
import type { Db } from "../db.js";
import { chainState } from "../schema.js";
import type { ChainId } from "@tradebot/core";

export async function getLastBlock(db: Db, chain: ChainId): Promise<number | null> {
  const rows = await db.select().from(chainState).where(eq(chainState.chain, chain));
  return rows[0]?.lastBlock ?? null;
}

export async function upsertLastBlock(db: Db, chain: ChainId, block: number): Promise<void> {
  await db
    .insert(chainState)
    .values({ chain, lastBlock: block })
    .onConflictDoUpdate({
      target: chainState.chain,
      set: { lastBlock: block, updatedAt: new Date() },
    });
}
