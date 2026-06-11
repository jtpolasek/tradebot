import { eq, and } from "drizzle-orm";
import type { Db } from "../db.js";
import { leaderStats } from "../schema.js";

export type LeaderStatsRow = {
  walletId: string;
  window: string;
  trades: number;
  winRate: number | null;
  avgReturnPct: number | null;
  medianHoldMinutes: number | null;
  realizedPnlUsd: number | null;
  maxDrawdownPct: number | null;
  score: number | null;
  weight: number;
  updatedAt: Date;
};

export async function upsertLeaderStats(db: Db, row: Omit<LeaderStatsRow, "updatedAt">): Promise<void> {
  await db.insert(leaderStats).values({
    walletId: row.walletId,
    window: row.window,
    trades: row.trades,
    winRate: row.winRate !== null ? String(row.winRate) : undefined,
    avgReturnPct: row.avgReturnPct !== null ? String(row.avgReturnPct) : undefined,
    medianHoldMinutes: row.medianHoldMinutes !== null ? String(row.medianHoldMinutes) : undefined,
    realizedPnlUsd: row.realizedPnlUsd !== null ? String(row.realizedPnlUsd) : undefined,
    maxDrawdownPct: row.maxDrawdownPct !== null ? String(row.maxDrawdownPct) : undefined,
    score: row.score !== null ? String(row.score) : undefined,
    weight: String(row.weight),
    updatedAt: new Date(),
  }).onConflictDoUpdate({
    target: [leaderStats.walletId, leaderStats.window],
    set: {
      trades: row.trades,
      winRate: row.winRate !== null ? String(row.winRate) : undefined,
      avgReturnPct: row.avgReturnPct !== null ? String(row.avgReturnPct) : undefined,
      medianHoldMinutes: row.medianHoldMinutes !== null ? String(row.medianHoldMinutes) : undefined,
      realizedPnlUsd: row.realizedPnlUsd !== null ? String(row.realizedPnlUsd) : undefined,
      maxDrawdownPct: row.maxDrawdownPct !== null ? String(row.maxDrawdownPct) : undefined,
      score: row.score !== null ? String(row.score) : undefined,
      weight: String(row.weight),
      updatedAt: new Date(),
    },
  });
}

export async function getLeaderStats(db: Db, walletId: string, window: string): Promise<LeaderStatsRow | null> {
  const rows = await db
    .select()
    .from(leaderStats)
    .where(and(eq(leaderStats.walletId, walletId), eq(leaderStats.window, window)))
    .limit(1);
  const row = rows[0];
  return row ? rowToStats(row) : null;
}

export async function getAllLeaderStats(db: Db, window: string): Promise<LeaderStatsRow[]> {
  const rows = await db.select().from(leaderStats).where(eq(leaderStats.window, window));
  return rows.map(rowToStats);
}

function rowToStats(row: typeof leaderStats.$inferSelect): LeaderStatsRow {
  return {
    walletId: row.walletId,
    window: row.window,
    trades: row.trades,
    winRate: row.winRate !== null ? Number(row.winRate) : null,
    avgReturnPct: row.avgReturnPct !== null ? Number(row.avgReturnPct) : null,
    medianHoldMinutes: row.medianHoldMinutes !== null ? Number(row.medianHoldMinutes) : null,
    realizedPnlUsd: row.realizedPnlUsd !== null ? Number(row.realizedPnlUsd) : null,
    maxDrawdownPct: row.maxDrawdownPct !== null ? Number(row.maxDrawdownPct) : null,
    score: row.score !== null ? Number(row.score) : null,
    weight: Number(row.weight),
    updatedAt: row.updatedAt,
  };
}
