import { sql } from "drizzle-orm";
import type { Db } from "../db.js";
import { runnerHealth, tradeSignals, paperFills } from "../schema.js";
import type { RunnerHealthPayload } from "@tradebot/core";

const ROW_ID = "runner";

/** Upsert the single runner heartbeat row. */
export async function upsertRunnerHealth(db: Db, payload: RunnerHealthPayload): Promise<void> {
  await db
    .insert(runnerHealth)
    .values({ id: ROW_ID, ts: new Date(), payload })
    .onConflictDoUpdate({
      target: runnerHealth.id,
      set: { ts: new Date(), payload },
    });
}

export interface RunnerHealthRow {
  ts: number;
  payload: RunnerHealthPayload;
}

/** Read the latest heartbeat, or null if the runner has never written one. */
export async function getRunnerHealth(db: Db): Promise<RunnerHealthRow | null> {
  const rows = await db.select().from(runnerHealth).limit(1);
  const row = rows[0];
  if (!row) return null;
  return { ts: row.ts.getTime(), payload: row.payload as RunnerHealthPayload };
}

/** Epoch ms of the most recent signal's observed_at, or null when there are none. */
export async function latestSignalAt(db: Db): Promise<number | null> {
  const rows = await db
    .select({ ts: sql<Date>`max(${tradeSignals.observedAt})` })
    .from(tradeSignals);
  const ts = rows[0]?.ts;
  return ts ? new Date(ts).getTime() : null;
}

/** Epoch ms of the most recent fill's decided_at, or null when there are none. */
export async function latestFillAt(db: Db): Promise<number | null> {
  const rows = await db
    .select({ ts: sql<Date>`max(${paperFills.decidedAt})` })
    .from(paperFills);
  const ts = rows[0]?.ts;
  return ts ? new Date(ts).getTime() : null;
}
