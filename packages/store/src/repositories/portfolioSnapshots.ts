import { desc } from "drizzle-orm";
import type { Db } from "../db.js";
import { portfolioSnapshots } from "../schema.js";

export type SnapshotRow = {
  id: string;
  ts: Date;
  equityUsd: number;
  cashUsd: number;
  positionsValueUsd: number;
  dailyPnlUsd: number;
};

export async function insertSnapshot(db: Db, snapshot: Omit<SnapshotRow, "id">): Promise<void> {
  await db.insert(portfolioSnapshots).values({
    ts: snapshot.ts,
    equityUsd: String(snapshot.equityUsd),
    cashUsd: String(snapshot.cashUsd),
    positionsValueUsd: String(snapshot.positionsValueUsd),
    dailyPnlUsd: String(snapshot.dailyPnlUsd),
  });
}

export async function latestSnapshot(db: Db): Promise<SnapshotRow | null> {
  const rows = await db
    .select()
    .from(portfolioSnapshots)
    .orderBy(desc(portfolioSnapshots.ts))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    ts: row.ts,
    equityUsd: Number(row.equityUsd),
    cashUsd: Number(row.cashUsd),
    positionsValueUsd: Number(row.positionsValueUsd),
    dailyPnlUsd: Number(row.dailyPnlUsd),
  };
}
