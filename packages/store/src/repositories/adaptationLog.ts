import { desc } from "drizzle-orm";
import type { Db } from "../db.js";
import { adaptationLog } from "../schema.js";

export type AdaptationLogEntry = {
  rule: string;
  oldValue: string;
  newValue: string;
  evidenceJson?: unknown;
};

export type AdaptationLogRow = { id: string; ts: Date } & AdaptationLogEntry;

export async function getAdaptationLogs(db: Db, limit: number): Promise<AdaptationLogRow[]> {
  const rows = await db
    .select()
    .from(adaptationLog)
    .orderBy(desc(adaptationLog.ts))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    ts: r.ts,
    rule: r.rule,
    oldValue: r.oldValue,
    newValue: r.newValue,
    ...(r.evidenceJson !== null ? { evidenceJson: r.evidenceJson } : {}),
  }));
}

export async function insertAdaptationLog(db: Db, entry: AdaptationLogEntry): Promise<void> {
  await db.insert(adaptationLog).values({
    ts: new Date(),
    rule: entry.rule,
    oldValue: entry.oldValue,
    newValue: entry.newValue,
    ...(entry.evidenceJson !== undefined ? { evidenceJson: entry.evidenceJson } : {}),
  });
}
