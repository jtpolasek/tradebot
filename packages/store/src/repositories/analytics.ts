import { sql, eq, and } from "drizzle-orm";
import type { Db } from "../db.js";
import { paperFills, positions, tokens } from "../schema.js";
import type { ChainId, PortfolioAnalytics, PortfolioAnalyticsTokenResult } from "@tradebot/core";

export type AnalyticsPosition = {
  chain: ChainId;
  tokenAddress: string;
  symbol: string;
  name?: string;
  qty: number;
  avgCostUsd: number;
  realizedPnlUsd: number;
  openedAt: Date;
  closedAt: Date | null;
};

export type FillAggregate = {
  copiedFills: number;
  skippedFills: number;
  totalFeesUsd: number;
  totalNotionalUsd: number;
};

const MS_PER_HOUR = 3_600_000;

/**
 * Pure analytics derivation — kept separate from the queries so the formulas can be tested with
 * hand-computed inputs and no database. Realized PnL is summed across all positions (a partially
 * sold open position still carries realized PnL); win rate and average hold consider closed
 * positions only.
 */
export function derivePortfolioAnalytics(
  positionRows: AnalyticsPosition[],
  fills: FillAggregate
): PortfolioAnalytics {
  const closed = positionRows.filter((p) => p.closedAt !== null);
  const winningTrades = closed.filter((p) => p.realizedPnlUsd > 0).length;
  const losingTrades = closed.filter((p) => p.realizedPnlUsd < 0).length;

  const realizedPnlUsd = positionRows.reduce((sum, p) => sum + p.realizedPnlUsd, 0);
  const openExposureUsd = positionRows
    .filter((p) => p.closedAt === null)
    .reduce((sum, p) => sum + p.qty * p.avgCostUsd, 0);

  let weightedHours = 0;
  let holdCount = 0;
  for (const p of closed) {
    const hours = (p.closedAt!.getTime() - p.openedAt.getTime()) / MS_PER_HOUR;
    if (hours >= 0) {
      weightedHours += hours;
      holdCount += 1;
    }
  }

  const totalFills = fills.copiedFills + fills.skippedFills;

  return {
    closedTrades: closed.length,
    winningTrades,
    losingTrades,
    winRate: closed.length ? winningTrades / closed.length : null,
    realizedPnlUsd,
    totalFeesUsd: fills.totalFeesUsd,
    totalNotionalUsd: fills.totalNotionalUsd,
    feeDrag: fills.totalNotionalUsd > 0 ? fills.totalFeesUsd / fills.totalNotionalUsd : null,
    averageHoldHours: holdCount > 0 ? weightedHours / holdCount : null,
    openExposureUsd,
    copiedFills: fills.copiedFills,
    skippedFills: fills.skippedFills,
    skipRate: totalFills > 0 ? fills.skippedFills / totalFills : null,
    byToken: realizedPnlByToken(positionRows),
  };
}

function realizedPnlByToken(positionRows: AnalyticsPosition[]): PortfolioAnalyticsTokenResult[] {
  const totals = new Map<string, PortfolioAnalyticsTokenResult>();
  for (const p of positionRows) {
    const key = `${p.chain}:${p.tokenAddress}`;
    const current = totals.get(key) ?? {
      chain: p.chain,
      tokenAddress: p.tokenAddress,
      symbol: p.symbol,
      ...(p.name ? { name: p.name } : {}),
      realizedPnlUsd: 0,
      closedTrades: 0,
    };
    current.realizedPnlUsd += p.realizedPnlUsd;
    if (p.closedAt !== null) current.closedTrades += 1;
    totals.set(key, current);
  }
  return Array.from(totals.values()).sort((a, b) => b.realizedPnlUsd - a.realizedPnlUsd);
}

export async function getPortfolioAnalytics(db: Db): Promise<PortfolioAnalytics> {
  const positionRows = await db
    .select({
      chain: positions.chain,
      tokenAddress: positions.tokenAddress,
      symbol: tokens.symbol,
      name: tokens.name,
      qty: positions.qty,
      avgCostUsd: positions.avgCostUsd,
      realizedPnlUsd: positions.realizedPnlUsd,
      openedAt: positions.openedAt,
      closedAt: positions.closedAt,
    })
    .from(positions)
    .leftJoin(tokens, and(eq(tokens.chain, positions.chain), eq(tokens.address, positions.tokenAddress)));

  const mapped: AnalyticsPosition[] = positionRows.map((r) => ({
    chain: r.chain as ChainId,
    tokenAddress: r.tokenAddress,
    symbol: r.symbol ?? "",
    ...(r.name ? { name: r.name } : {}),
    qty: Number(r.qty),
    avgCostUsd: Number(r.avgCostUsd),
    realizedPnlUsd: Number(r.realizedPnlUsd),
    openedAt: r.openedAt,
    closedAt: r.closedAt ?? null,
  }));

  const copiedFilter = and(eq(paperFills.decision, "copied"), eq(paperFills.voided, false));
  const [agg] = await db
    .select({
      copied: sql<string>`count(*) filter (where ${copiedFilter})`,
      skipped: sql<string>`count(*) filter (where ${eq(paperFills.decision, "skipped")})`,
      fees: sql<string>`coalesce(sum(${paperFills.feeUsd}) filter (where ${copiedFilter}), 0)`,
      notional: sql<string>`coalesce(sum(${paperFills.notionalUsd}) filter (where ${copiedFilter}), 0)`,
    })
    .from(paperFills);

  const fills: FillAggregate = {
    copiedFills: Number(agg?.copied ?? 0),
    skippedFills: Number(agg?.skipped ?? 0),
    totalFeesUsd: Number(agg?.fees ?? 0),
    totalNotionalUsd: Number(agg?.notional ?? 0),
  };

  return derivePortfolioAnalytics(mapped, fills);
}
