import { eq, and, desc, lte } from "drizzle-orm";
import type { Db } from "../db.js";
import { priceMarks } from "../schema.js";
import type { ChainId } from "@tradebot/core";

export type PriceMarkRow = {
  chain: ChainId;
  tokenAddress: string;
  ts: Date;
  priceUsd: number;
  source: string;
};

export async function insertPriceMark(db: Db, mark: PriceMarkRow): Promise<void> {
  await db.insert(priceMarks).values({
    chain: mark.chain,
    tokenAddress: mark.tokenAddress.toLowerCase(),
    ts: mark.ts,
    priceUsd: String(mark.priceUsd),
    source: mark.source,
  }).onConflictDoNothing();
}

export async function getOpenPositionTokens(db: Db): Promise<Array<{ chain: ChainId; tokenAddress: string }>> {
  const { positions } = await import("../schema.js");
  const rows = await db
    .select({ chain: positions.chain, tokenAddress: positions.tokenAddress })
    .from(positions)
    .where(eq(positions.closedAt, null as unknown as Date));
  return rows.map((r) => ({ chain: r.chain as ChainId, tokenAddress: r.tokenAddress }));
}

export async function markAtOrBefore(
  db: Db,
  chain: ChainId,
  tokenAddress: string,
  ts: Date
): Promise<PriceMarkRow | null> {
  const rows = await db
    .select()
    .from(priceMarks)
    .where(
      and(
        eq(priceMarks.chain, chain),
        eq(priceMarks.tokenAddress, tokenAddress.toLowerCase()),
        lte(priceMarks.ts, ts)
      )
    )
    .orderBy(desc(priceMarks.ts))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    chain: row.chain as ChainId,
    tokenAddress: row.tokenAddress,
    ts: row.ts,
    priceUsd: Number(row.priceUsd),
    source: row.source,
  };
}

export async function latestMark(db: Db, chain: ChainId, tokenAddress: string): Promise<PriceMarkRow | null> {
  const rows = await db
    .select()
    .from(priceMarks)
    .where(and(eq(priceMarks.chain, chain), eq(priceMarks.tokenAddress, tokenAddress.toLowerCase())))
    .orderBy(desc(priceMarks.ts))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    chain: row.chain as ChainId,
    tokenAddress: row.tokenAddress,
    ts: row.ts,
    priceUsd: Number(row.priceUsd),
    source: row.source,
  };
}
