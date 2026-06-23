import { eq, and, isNull, desc, isNotNull, or } from "drizzle-orm";
import type { Db, DbOrTx } from "../db.js";
import { positions, tradeSignals } from "../schema.js";
import type { ChainId, TokenRef } from "@tradebot/core";
import { getToken } from "./tokens.js";

export type PositionRow = {
  id: string;
  chain: ChainId;
  tokenAddress: string;
  qty: number;
  avgCostUsd: number;
  openedAt: Date;
  closedAt: Date | null;
  realizedPnlUsd: number;
  sourceWalletId: string | null;
  token?: TokenRef;
};

export type OpenPolymarketPositionForSettlement = Omit<PositionRow, "chain"> & {
  chain: "polygon";
  conditionId: string;
  outcomeIndex: number;
};

export async function upsertPosition(db: DbOrTx, pos: Omit<PositionRow, "id" | "openedAt" | "closedAt">): Promise<void> {
  const existing = await db
    .select()
    .from(positions)
    .where(
      and(
        eq(positions.chain, pos.chain),
        eq(positions.tokenAddress, pos.tokenAddress.toLowerCase()),
        isNull(positions.closedAt),
        ...(pos.sourceWalletId !== null
          ? [eq(positions.sourceWalletId, pos.sourceWalletId)]
          : [isNull(positions.sourceWalletId)])
      )
    )
    .limit(1);

  if (existing[0]) {
    await db.update(positions).set({
      qty: String(pos.qty),
      avgCostUsd: String(pos.avgCostUsd),
      realizedPnlUsd: String(pos.realizedPnlUsd),
    }).where(eq(positions.id, existing[0].id));
  } else {
    await db.insert(positions).values({
      chain: pos.chain,
      tokenAddress: pos.tokenAddress.toLowerCase(),
      qty: String(pos.qty),
      avgCostUsd: String(pos.avgCostUsd),
      realizedPnlUsd: String(pos.realizedPnlUsd),
      ...(pos.sourceWalletId !== null ? { sourceWalletId: pos.sourceWalletId } : {}),
    });
  }
}

export async function getPosition(
  db: Db,
  chain: ChainId,
  tokenAddress: string,
  sourceWalletId: string | null
): Promise<PositionRow | null> {
  const rows = await db
    .select()
    .from(positions)
    .where(
      and(
        eq(positions.chain, chain),
        eq(positions.tokenAddress, tokenAddress.toLowerCase()),
        isNull(positions.closedAt),
        ...(sourceWalletId !== null
          ? [eq(positions.sourceWalletId, sourceWalletId)]
          : [isNull(positions.sourceWalletId)])
      )
    )
    .limit(1);
  return rows[0] ? rowToPosition(rows[0]) : null;
}

export async function getOpenPositions(db: Db): Promise<PositionRow[]> {
  const rows = await db.select().from(positions).where(isNull(positions.closedAt));
  return Promise.all(rows.map((row) => hydratePosition(db, rowToPosition(row))));
}

/**
 * Open copied Polymarket positions with the condition/outcome metadata needed for resolution
 * settlement. The metadata is recovered from the most recent persisted Polymarket signal touching
 * the held token for that wallet.
 */
export async function getOpenPolymarketPositionsForSettlement(db: Db): Promise<OpenPolymarketPositionForSettlement[]> {
  const open = await getOpenPositions(db);
  const results: OpenPolymarketPositionForSettlement[] = [];

  for (const position of open) {
    if (position.chain !== "polygon" || position.sourceWalletId === null) continue;
    const rows = await db
      .select({
        conditionId: tradeSignals.conditionId,
        outcomeIndex: tradeSignals.outcomeIndex,
      })
      .from(tradeSignals)
      .where(and(
        eq(tradeSignals.chain, "polygon"),
        eq(tradeSignals.venue, "polymarket"),
        eq(tradeSignals.walletId, position.sourceWalletId),
        isNotNull(tradeSignals.conditionId),
        isNotNull(tradeSignals.outcomeIndex),
        or(
          eq(tradeSignals.tokenIn, position.tokenAddress.toLowerCase()),
          eq(tradeSignals.tokenOut, position.tokenAddress.toLowerCase()),
        ),
      ))
      .orderBy(desc(tradeSignals.observedAt))
      .limit(1);

    const row = rows[0];
    if (!row?.conditionId || row.outcomeIndex === null) continue;
    results.push({
      ...position,
      chain: "polygon",
      conditionId: row.conditionId,
      outcomeIndex: row.outcomeIndex,
    });
  }

  return results;
}

export async function closePosition(db: Db, id: string, realizedPnlUsd: number): Promise<void> {
  await db.update(positions).set({
    closedAt: new Date(),
    realizedPnlUsd: String(realizedPnlUsd),
    qty: "0",
  }).where(eq(positions.id, id));
}

/**
 * Close the open position matching (chain, token, sourceWalletId) by stamping `closedAt`,
 * so a sell-to-zero doesn't leave a qty-0 "open" zombie that reloads at boot.
 */
export async function closePositionByKey(
  db: DbOrTx,
  key: { chain: ChainId; tokenAddress: string; sourceWalletId: string | null; realizedPnlUsd: number }
): Promise<void> {
  await db
    .update(positions)
    .set({ closedAt: new Date(), realizedPnlUsd: String(key.realizedPnlUsd), qty: "0" })
    .where(
      and(
        eq(positions.chain, key.chain),
        eq(positions.tokenAddress, key.tokenAddress.toLowerCase()),
        isNull(positions.closedAt),
        ...(key.sourceWalletId !== null
          ? [eq(positions.sourceWalletId, key.sourceWalletId)]
          : [isNull(positions.sourceWalletId)])
      )
    );
}

function rowToPosition(row: typeof positions.$inferSelect): PositionRow {
  return {
    id: row.id,
    chain: row.chain as ChainId,
    tokenAddress: row.tokenAddress,
    qty: Number(row.qty),
    avgCostUsd: Number(row.avgCostUsd),
    openedAt: row.openedAt,
    closedAt: row.closedAt ?? null,
    realizedPnlUsd: Number(row.realizedPnlUsd),
    sourceWalletId: row.sourceWalletId ?? null,
  };
}

async function hydratePosition(db: Db, position: PositionRow): Promise<PositionRow> {
  const row = await getToken(db, position.chain, position.tokenAddress);
  if (!row) return position;
  return {
    ...position,
    token: {
      chain: row.chain,
      address: row.address,
      symbol: row.symbol,
      decimals: row.decimals,
      ...(row.name ? { name: row.name } : {}),
    },
  };
}
