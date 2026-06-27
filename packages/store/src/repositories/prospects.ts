import { and, eq, gte } from "drizzle-orm";
import type { Db } from "../db.js";
import { prospects, prospectDiscoveryState } from "../schema.js";

export type ProspectVerdict = "promoted" | "rejected";

/**
 * A single evaluation outcome for a nominated wallet, written for every result (promoted and
 * rejected) so the `prospects` table is a complete audit trail of what the finder saw and why.
 * `firstSeenAt` is owned by the table (set once on insert, preserved across re-evaluations).
 */
export interface ProspectEvaluation {
  address: string; // lowercase proxyWallet
  source: string;
  userName?: string | null;
  xUsername?: string | null;
  pnlUsd?: number | null;
  volUsd?: number | null;
  pnlPerVol?: number | null;
  tradeCount?: number | null;
  lastTradeTs?: number | null;
  score?: number | null;
  verdict: ProspectVerdict;
  rejectReason?: string | null;
  promotedWalletId?: string | null;
}

export interface ProspectRow extends ProspectEvaluation {
  firstSeenAt: Date;
  lastEvaluatedAt: Date;
}

function rowToProspect(row: typeof prospects.$inferSelect): ProspectRow {
  return {
    address: row.address,
    source: row.source,
    userName: row.userName,
    xUsername: row.xUsername,
    pnlUsd: row.pnlUsd,
    volUsd: row.volUsd,
    pnlPerVol: row.pnlPerVol,
    tradeCount: row.tradeCount,
    lastTradeTs: row.lastTradeTs,
    score: row.score,
    verdict: row.verdict as ProspectVerdict,
    rejectReason: row.rejectReason,
    promotedWalletId: row.promotedWalletId,
    firstSeenAt: row.firstSeenAt,
    lastEvaluatedAt: row.lastEvaluatedAt,
  };
}

/**
 * Insert or refresh a prospect's latest evaluation snapshot, keyed by address. `firstSeenAt` is left
 * untouched on update (the table default sets it once); `lastEvaluatedAt` is bumped to now each time.
 */
export async function upsertProspectEvaluation(db: Db, evaluation: ProspectEvaluation): Promise<void> {
  const now = new Date();
  const values = {
    address: evaluation.address,
    source: evaluation.source,
    userName: evaluation.userName ?? null,
    xUsername: evaluation.xUsername ?? null,
    pnlUsd: evaluation.pnlUsd ?? null,
    volUsd: evaluation.volUsd ?? null,
    pnlPerVol: evaluation.pnlPerVol ?? null,
    tradeCount: evaluation.tradeCount ?? null,
    lastTradeTs: evaluation.lastTradeTs ?? null,
    score: evaluation.score ?? null,
    verdict: evaluation.verdict,
    rejectReason: evaluation.rejectReason ?? null,
    promotedWalletId: evaluation.promotedWalletId ?? null,
    lastEvaluatedAt: now,
  };
  await db
    .insert(prospects)
    .values(values)
    .onConflictDoUpdate({ target: prospects.address, set: values });
}

/**
 * Addresses last evaluated as `rejected` at or after `since` — the discovery cooldown window. The job
 * skips re-evaluating these so a fresh nomination of a recently-rejected wallet doesn't re-spend calls.
 */
export async function getRecentlyRejected(db: Db, since: Date): Promise<string[]> {
  const rows = await db
    .select({ address: prospects.address })
    .from(prospects)
    .where(and(eq(prospects.verdict, "rejected"), gte(prospects.lastEvaluatedAt, since)));
  return rows.map((r) => r.address);
}

/** Read a single prospect by address, or null if never evaluated. */
export async function getProspect(db: Db, address: string): Promise<ProspectRow | null> {
  const rows = await db.select().from(prospects).where(eq(prospects.address, address));
  return rows[0] ? rowToProspect(rows[0]) : null;
}

export interface DiscoveryState {
  lastRunAt: Date | null;
  lastError: string | null;
  promotedLastRun: number;
}

const DISCOVERY_STATE_ID = 1;

/** Read the singleton discovery run-state, or null if the job has never recorded a run. */
export async function getDiscoveryState(db: Db): Promise<DiscoveryState | null> {
  const rows = await db
    .select()
    .from(prospectDiscoveryState)
    .where(eq(prospectDiscoveryState.id, DISCOVERY_STATE_ID));
  const row = rows[0];
  if (!row) return null;
  return {
    lastRunAt: row.lastRunAt,
    lastError: row.lastError,
    promotedLastRun: row.promotedLastRun,
  };
}

/**
 * Upsert the singleton discovery run-state. Only the provided fields are written, so a successful run
 * can clear `lastError` while a failed one records it without disturbing the last-good run timestamp.
 */
export async function setDiscoveryState(db: Db, patch: Partial<DiscoveryState>): Promise<void> {
  const set: Partial<typeof prospectDiscoveryState.$inferInsert> = {};
  if (patch.lastRunAt !== undefined) set.lastRunAt = patch.lastRunAt;
  if (patch.lastError !== undefined) set.lastError = patch.lastError;
  if (patch.promotedLastRun !== undefined) set.promotedLastRun = patch.promotedLastRun;
  await db
    .insert(prospectDiscoveryState)
    .values({ id: DISCOVERY_STATE_ID, ...set })
    .onConflictDoUpdate({ target: prospectDiscoveryState.id, set });
}
