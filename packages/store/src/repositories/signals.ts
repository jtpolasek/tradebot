import { eq, and, gte, desc } from "drizzle-orm";
import type { Db } from "../db.js";
import { tradeSignals } from "../schema.js";
import type { TradeSignal, ChainId } from "@tradebot/core";

export async function insertSignal(db: Db, signal: TradeSignal): Promise<string> {
  const rows = await db.insert(tradeSignals).values({
    id: signal.id,
    chain: signal.chain,
    walletId: signal.walletId,
    txHash: signal.txHash,
    source: signal.source,
    side: signal.side,
    tokenIn: signal.tokenIn.address,
    tokenOut: signal.tokenOut.address,
    amountIn: String(signal.amountIn),
    amountOut: String(signal.amountOut),
    venue: signal.venue,
    observedAt: new Date(signal.observedAt),
    confirmedAt: signal.confirmedAt !== null ? new Date(signal.confirmedAt) : undefined,
    blockNumber: signal.blockNumber ?? undefined,
  }).onConflictDoNothing().returning({ id: tradeSignals.id });

  const inserted = rows[0];
  if (inserted) return inserted.id;

  const existing = await db
    .select({ id: tradeSignals.id })
    .from(tradeSignals)
    .where(and(
      eq(tradeSignals.chain, signal.chain),
      eq(tradeSignals.txHash, signal.txHash),
      eq(tradeSignals.tokenIn, signal.tokenIn.address),
      eq(tradeSignals.tokenOut, signal.tokenOut.address),
      eq(tradeSignals.side, signal.side),
    ))
    .limit(1);

  const row = existing[0];
  if (!row) {
    throw new Error(`trade signal insert conflicted but no existing row was found for ${signal.chain}:${signal.txHash}`);
  }
  return row.id;
}

export async function upsertSignal(db: Db, signal: TradeSignal): Promise<void> {
  await db.insert(tradeSignals).values({
    id: signal.id,
    chain: signal.chain,
    walletId: signal.walletId,
    txHash: signal.txHash,
    source: signal.source,
    side: signal.side,
    tokenIn: signal.tokenIn.address,
    tokenOut: signal.tokenOut.address,
    amountIn: String(signal.amountIn),
    amountOut: String(signal.amountOut),
    venue: signal.venue,
    observedAt: new Date(signal.observedAt),
    confirmedAt: signal.confirmedAt !== null ? new Date(signal.confirmedAt) : undefined,
    blockNumber: signal.blockNumber ?? undefined,
  }).onConflictDoUpdate({
    target: [tradeSignals.chain, tradeSignals.txHash, tradeSignals.tokenIn, tradeSignals.tokenOut, tradeSignals.side],
    set: {
      source: signal.source,
      amountIn: String(signal.amountIn),
      amountOut: String(signal.amountOut),
      confirmedAt: signal.confirmedAt !== null ? new Date(signal.confirmedAt) : undefined,
      blockNumber: signal.blockNumber ?? undefined,
    },
  });
}

export async function getSignalById(db: Db, id: string): Promise<TradeSignal | null> {
  const rows = await db.select().from(tradeSignals).where(eq(tradeSignals.id, id)).limit(1);
  const row = rows[0];
  if (!row) return null;
  return rowToSignal(row);
}

export async function getSignalsByWallet(
  db: Db,
  walletId: string,
  since: Date | null
): Promise<TradeSignal[]> {
  const conditions = [eq(tradeSignals.walletId, walletId)];
  if (since !== null) conditions.push(gte(tradeSignals.observedAt, since));
  const rows = await db.select().from(tradeSignals).where(and(...conditions));
  return rows.map(rowToSignal);
}

export async function getRecentSignals(db: Db, since: Date, limit: number): Promise<TradeSignal[]> {
  const rows = await db
    .select()
    .from(tradeSignals)
    .where(gte(tradeSignals.observedAt, since))
    .orderBy(desc(tradeSignals.observedAt))
    .limit(limit);
  return rows.map(rowToSignal);
}

function rowToSignal(row: typeof tradeSignals.$inferSelect): TradeSignal {
  return {
    id: row.id,
    chain: row.chain as ChainId,
    walletId: row.walletId,
    txHash: row.txHash,
    source: row.source as "mempool" | "confirmed",
    side: row.side as "buy" | "sell",
    tokenIn: { chain: row.chain as ChainId, address: row.tokenIn, symbol: "", decimals: 18 },
    tokenOut: { chain: row.chain as ChainId, address: row.tokenOut, symbol: "", decimals: 18 },
    amountIn: BigInt(row.amountIn),
    amountOut: BigInt(row.amountOut),
    venue: row.venue,
    observedAt: row.observedAt.getTime(),
    confirmedAt: row.confirmedAt ? row.confirmedAt.getTime() : null,
    blockNumber: row.blockNumber ?? null,
  };
}
