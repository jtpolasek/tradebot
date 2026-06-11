import { eq, and } from "drizzle-orm";
import type { Db } from "../db.js";
import { paperFills } from "../schema.js";
import type { PaperFill, TokenRef, ChainId } from "@tradebot/core";

export type StoredFill = PaperFill & { voided: boolean };

export async function insertFill(db: Db, fill: PaperFill): Promise<void> {
  await db.insert(paperFills).values({
    id: fill.id,
    signalId: fill.signalId,
    decidedAt: new Date(fill.decidedAt),
    decision: fill.decision,
    ...(fill.skipReason !== undefined ? { skipReason: fill.skipReason } : {}),
    side: fill.side,
    tokenAddress: fill.token.address,
    quoteAddress: fill.quoteToken.address,
    qty: String(fill.qty),
    priceUsd: String(fill.priceUsd),
    notionalUsd: String(fill.notionalUsd),
    feeUsd: String(fill.feeUsd),
    slippageBps: fill.slippageBps,
    latencyMs: fill.latencyMs,
    provisional: fill.provisional,
    voided: false,
  });
}

export async function updateFill(
  db: Db,
  id: string,
  updates: { priceUsd: number; notionalUsd: number; provisional: boolean }
): Promise<void> {
  await db.update(paperFills).set({
    priceUsd: String(updates.priceUsd),
    notionalUsd: String(updates.notionalUsd),
    provisional: updates.provisional,
  }).where(eq(paperFills.id, id));
}

export async function voidFill(db: Db, id: string): Promise<void> {
  await db.update(paperFills).set({ voided: true, provisional: false }).where(eq(paperFills.id, id));
}

export async function getFill(db: Db, id: string): Promise<StoredFill | null> {
  const rows = await db.select().from(paperFills).where(eq(paperFills.id, id)).limit(1);
  const row = rows[0];
  if (!row) return null;
  return rowToFill(row);
}

export type CopiedFillRow = {
  id: string;
  side: "buy" | "sell";
  tokenAddress: string;
  walletId: string | null;
  qty: number;
  priceUsd: number;
  notionalUsd: number;
  decidedAt: Date;
};

export async function getCopiedFills(db: Db): Promise<CopiedFillRow[]> {
  const { tradeSignals } = await import("../schema.js");
  const rows = await db
    .select({
      id: paperFills.id,
      side: paperFills.side,
      tokenAddress: paperFills.tokenAddress,
      walletId: tradeSignals.walletId,
      qty: paperFills.qty,
      priceUsd: paperFills.priceUsd,
      notionalUsd: paperFills.notionalUsd,
      decidedAt: paperFills.decidedAt,
    })
    .from(paperFills)
    .innerJoin(tradeSignals, eq(paperFills.signalId, tradeSignals.id))
    .where(and(eq(paperFills.decision, "copied"), eq(paperFills.voided, false)));

  return rows.map((r) => ({
    id: r.id,
    side: r.side as "buy" | "sell",
    tokenAddress: r.tokenAddress,
    walletId: r.walletId,
    qty: Number(r.qty),
    priceUsd: Number(r.priceUsd),
    notionalUsd: Number(r.notionalUsd),
    decidedAt: r.decidedAt,
  }));
}

function rowToFill(row: typeof paperFills.$inferSelect): StoredFill {
  const chain: ChainId = "eth";
  const token: TokenRef = { chain, address: row.tokenAddress, symbol: "", decimals: 18 };
  const quoteToken: TokenRef = { chain, address: row.quoteAddress, symbol: "", decimals: 6 };
  return {
    id: row.id,
    signalId: row.signalId,
    decidedAt: row.decidedAt.getTime(),
    decision: row.decision as "copied" | "skipped",
    ...(row.skipReason !== null ? { skipReason: row.skipReason } : {}),
    side: row.side as "buy" | "sell",
    token,
    quoteToken,
    qty: Number(row.qty),
    priceUsd: Number(row.priceUsd),
    notionalUsd: Number(row.notionalUsd),
    feeUsd: Number(row.feeUsd),
    slippageBps: row.slippageBps,
    latencyMs: row.latencyMs,
    provisional: row.provisional,
    voided: row.voided,
  };
}
