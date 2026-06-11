import type { Db } from "../db.js";
import { adaptationLog } from "../schema.js";

export type AdaptationLogEntry = {
  rule: string;
  oldValue: string;
  newValue: string;
  evidenceJson?: unknown;
};

export async function insertAdaptationLog(db: Db, entry: AdaptationLogEntry): Promise<void> {
  await db.insert(adaptationLog).values({
    ts: new Date(),
    rule: entry.rule,
    oldValue: entry.oldValue,
    newValue: entry.newValue,
    ...(entry.evidenceJson !== undefined ? { evidenceJson: entry.evidenceJson } : {}),
  });
}
