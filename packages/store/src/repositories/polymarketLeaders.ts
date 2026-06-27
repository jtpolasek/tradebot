import { and, eq } from "drizzle-orm";
import type { Db } from "../db.js";
import { paperFills, positions, tradeSignals, wallets } from "../schema.js";
import { latestMark } from "./priceMarks.js";
import type { TrackedWallet } from "@tradebot/core";

export type PolymarketLeaderRow = {
  wallet: TrackedWallet;
  signals: number;
  copiedFills: number;
  skippedFills: number;
  openPositions: number;
  closedPositions: number;
  winningClosedPositions: number;
  realizedPnlUsd: number;
  openValueUsd: number | null;
  unrealizedPnlUsd: number | null;
  totalPnlUsd: number | null;
  totalNotionalUsd: number;
  winRate: number | null;
  updatedAt: Date | null;
};

type MutablePolymarketLeader = Omit<
  PolymarketLeaderRow,
  "wallet" | "winRate" | "totalPnlUsd" | "openValueUsd"
> & {
  wallet: TrackedWallet;
  openValueUsd: number;
  unrealizedPnlUsd: number | null;
  // An open position whose current price we could not obtain (no fresh mark). When set, this
  // leader's open-position valuation is reported as unknown rather than imputed at cost basis.
  pricingIncomplete: boolean;
};

function walletFromRow(row: typeof wallets.$inferSelect): TrackedWallet {
  return {
    id: row.id,
    chain: row.chain as TrackedWallet["chain"],
    address: row.address,
    label: row.label,
    active: row.active,
    autoCopy: row.autoCopy,
    addedAt: row.addedAt,
  };
}

function emptyLeader(wallet: TrackedWallet): MutablePolymarketLeader {
  return {
    wallet,
    signals: 0,
    copiedFills: 0,
    skippedFills: 0,
    openPositions: 0,
    closedPositions: 0,
    winningClosedPositions: 0,
    realizedPnlUsd: 0,
    openValueUsd: 0,
    unrealizedPnlUsd: null,
    totalNotionalUsd: 0,
    updatedAt: null,
    pricingIncomplete: false,
  };
}

function touch(row: MutablePolymarketLeader, at: Date | null): void {
  if (at && (!row.updatedAt || at > row.updatedAt)) row.updatedAt = at;
}

function roundMoney(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export async function getPolymarketLeaders(db: Db): Promise<PolymarketLeaderRow[]> {
  const walletRows = await db.select().from(wallets).where(eq(wallets.chain, "polygon"));
  const byWallet = new Map<string, MutablePolymarketLeader>();
  for (const row of walletRows) {
    const wallet = walletFromRow(row);
    byWallet.set(wallet.id, emptyLeader(wallet));
  }

  const signalRows = await db
    .select({
      walletId: tradeSignals.walletId,
      observedAt: tradeSignals.observedAt,
    })
    .from(tradeSignals)
    .where(and(eq(tradeSignals.chain, "polygon"), eq(tradeSignals.decodeStatus, "decoded")));

  for (const signal of signalRows) {
    const row = byWallet.get(signal.walletId);
    if (!row) continue;
    row.signals++;
    touch(row, signal.observedAt);
  }

  const fillRows = await db
    .select({
      walletId: tradeSignals.walletId,
      decision: paperFills.decision,
      notionalUsd: paperFills.notionalUsd,
      decidedAt: paperFills.decidedAt,
    })
    .from(paperFills)
    .innerJoin(tradeSignals, eq(paperFills.signalId, tradeSignals.id))
    .where(and(eq(tradeSignals.chain, "polygon"), eq(paperFills.voided, false)));

  for (const fill of fillRows) {
    const row = byWallet.get(fill.walletId);
    if (!row) continue;
    if (fill.decision === "copied") row.copiedFills++;
    if (fill.decision === "skipped") row.skippedFills++;
    row.totalNotionalUsd += Number(fill.notionalUsd);
    touch(row, fill.decidedAt);
  }

  const positionRows = await db.select().from(positions).where(eq(positions.chain, "polygon"));
  for (const position of positionRows) {
    if (!position.sourceWalletId) continue;
    const row = byWallet.get(position.sourceWalletId);
    if (!row) continue;

    const qty = Number(position.qty);
    const avgCostUsd = Number(position.avgCostUsd);
    const realizedPnlUsd = Number(position.realizedPnlUsd);
    row.realizedPnlUsd += realizedPnlUsd;
    touch(row, position.closedAt ?? position.openedAt);

    if (position.closedAt) {
      row.closedPositions++;
      if (realizedPnlUsd > 0) row.winningClosedPositions++;
      continue;
    }

    row.openPositions++;
    const mark = await latestMark(db, "polygon", position.tokenAddress);
    if (!mark || !Number.isFinite(mark.priceUsd) || mark.priceUsd <= 0) {
      // No current price — don't impute cost basis (that fabricates a $0.00 unrealized). Flag the
      // leader so its open valuation reports as unknown.
      row.pricingIncomplete = true;
      continue;
    }
    row.openValueUsd += qty * mark.priceUsd;
    const unrealized = qty * (mark.priceUsd - avgCostUsd);
    row.unrealizedPnlUsd = (row.unrealizedPnlUsd ?? 0) + unrealized;
    touch(row, mark.ts);
  }

  return Array.from(byWallet.values())
    .map((row) => {
      const winRate = row.closedPositions > 0 ? row.winningClosedPositions / row.closedPositions : null;

      // If any open position lacks a current price, open-position valuation is unknown — report it as
      // null rather than imputing cost basis. Realized PnL and counts stay exact regardless.
      let unrealizedPnlUsd: number | null;
      let totalPnlUsd: number | null;
      let openValueUsd: number | null;
      if (row.pricingIncomplete) {
        unrealizedPnlUsd = null;
        totalPnlUsd = null;
        openValueUsd = null;
      } else if (row.openPositions === 0) {
        unrealizedPnlUsd = null;
        totalPnlUsd = roundMoney(row.realizedPnlUsd);
        openValueUsd = 0;
      } else {
        const unrealized = row.unrealizedPnlUsd ?? 0;
        unrealizedPnlUsd = roundMoney(unrealized);
        totalPnlUsd = roundMoney(row.realizedPnlUsd + unrealized);
        openValueUsd = roundMoney(row.openValueUsd);
      }

      const { pricingIncomplete: _pricingIncomplete, ...rest } = row;
      return {
        ...rest,
        realizedPnlUsd: roundMoney(row.realizedPnlUsd),
        openValueUsd,
        unrealizedPnlUsd,
        totalPnlUsd,
        totalNotionalUsd: roundMoney(row.totalNotionalUsd),
        winRate,
      };
    })
    .sort((a, b) => {
      const ap = a.totalPnlUsd ?? a.realizedPnlUsd;
      const bp = b.totalPnlUsd ?? b.realizedPnlUsd;
      return bp - ap;
    });
}
