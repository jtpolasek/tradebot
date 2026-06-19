import { and, eq, sql } from "drizzle-orm";
import type { PolymarketPollHealth } from "@tradebot/core";
import type { Db } from "../db.js";
import { polymarketPollState, wallets } from "../schema.js";

export interface PolymarketPollCursor {
  walletId: string;
  cursorTimestamp: number;
  cursorKeys: string[];
}

export interface PolymarketPollSuccessInput {
  walletId: string;
  lastPolledAt: number;
  cursorTimestamp: number | null;
  cursorKeys: string[];
  fetchedCount: number;
  recordedCount: number;
  duplicateCount: number;
  pageCount: number;
  durationMs: number;
}

export interface PolymarketPollFailureInput {
  walletId: string;
  lastPolledAt: number;
  error: string;
  durationMs: number;
}

export async function upsertPolymarketPollSuccess(db: Db, input: PolymarketPollSuccessInput): Promise<void> {
  const now = new Date(input.lastPolledAt);
  await db
    .insert(polymarketPollState)
    .values({
      walletId: input.walletId,
      lastPolledAt: now,
      lastSuccessAt: now,
      lastErrorAt: null,
      lastError: null,
      cursorTimestamp: input.cursorTimestamp,
      cursorKeys: input.cursorKeys,
      fetchedCount: input.fetchedCount,
      recordedCount: input.recordedCount,
      duplicateCount: input.duplicateCount,
      pageCount: input.pageCount,
      durationMs: input.durationMs,
      consecutiveFailures: 0,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: polymarketPollState.walletId,
      set: {
        lastPolledAt: now,
        lastSuccessAt: now,
        lastErrorAt: null,
        lastError: null,
        cursorTimestamp: input.cursorTimestamp,
        cursorKeys: input.cursorKeys,
        fetchedCount: input.fetchedCount,
        recordedCount: input.recordedCount,
        duplicateCount: input.duplicateCount,
        pageCount: input.pageCount,
        durationMs: input.durationMs,
        consecutiveFailures: 0,
        updatedAt: now,
      },
    });
}

export async function upsertPolymarketPollFailure(db: Db, input: PolymarketPollFailureInput): Promise<void> {
  const now = new Date(input.lastPolledAt);
  await db
    .insert(polymarketPollState)
    .values({
      walletId: input.walletId,
      lastPolledAt: now,
      lastErrorAt: now,
      lastError: input.error,
      durationMs: input.durationMs,
      consecutiveFailures: 1,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: polymarketPollState.walletId,
      set: {
        lastPolledAt: now,
        lastErrorAt: now,
        lastError: input.error,
        durationMs: input.durationMs,
        consecutiveFailures: sql`${polymarketPollState.consecutiveFailures} + 1`,
        updatedAt: now,
      },
    });
}

export async function getPolymarketPollCursors(db: Db): Promise<PolymarketPollCursor[]> {
  const rows = await db
    .select({
      walletId: polymarketPollState.walletId,
      cursorTimestamp: polymarketPollState.cursorTimestamp,
      cursorKeys: polymarketPollState.cursorKeys,
    })
    .from(polymarketPollState)
    .where(sql`${polymarketPollState.cursorTimestamp} is not null`);

  return rows.flatMap((row) => {
    if (row.cursorTimestamp === null) return [];
    return [{
      walletId: row.walletId,
      cursorTimestamp: row.cursorTimestamp,
      cursorKeys: parseCursorKeys(row.cursorKeys),
    }];
  });
}

export async function getPolymarketPollHealth(db: Db): Promise<PolymarketPollHealth[]> {
  const rows = await db
    .select({
      walletId: wallets.id,
      walletAddress: wallets.address,
      walletLabel: wallets.label,
      lastPolledAt: polymarketPollState.lastPolledAt,
      lastSuccessAt: polymarketPollState.lastSuccessAt,
      lastErrorAt: polymarketPollState.lastErrorAt,
      lastError: polymarketPollState.lastError,
      cursorTimestamp: polymarketPollState.cursorTimestamp,
      cursorKeys: polymarketPollState.cursorKeys,
      fetchedCount: polymarketPollState.fetchedCount,
      recordedCount: polymarketPollState.recordedCount,
      duplicateCount: polymarketPollState.duplicateCount,
      pageCount: polymarketPollState.pageCount,
      durationMs: polymarketPollState.durationMs,
      consecutiveFailures: polymarketPollState.consecutiveFailures,
      updatedAt: polymarketPollState.updatedAt,
    })
    .from(wallets)
    .leftJoin(polymarketPollState, eq(wallets.id, polymarketPollState.walletId))
    .where(and(eq(wallets.chain, "polygon"), eq(wallets.active, true)))
    .orderBy(wallets.label);

  return rows.map((row) => ({
    walletId: row.walletId,
    walletAddress: row.walletAddress,
    walletLabel: row.walletLabel,
    lastPolledAt: dateMs(row.lastPolledAt),
    lastSuccessAt: dateMs(row.lastSuccessAt),
    lastErrorAt: dateMs(row.lastErrorAt),
    lastError: row.lastError,
    cursorTimestamp: row.cursorTimestamp,
    cursorKeyCount: parseCursorKeys(row.cursorKeys).length,
    fetchedCount: row.fetchedCount ?? 0,
    recordedCount: row.recordedCount ?? 0,
    duplicateCount: row.duplicateCount ?? 0,
    pageCount: row.pageCount ?? 0,
    durationMs: row.durationMs,
    consecutiveFailures: row.consecutiveFailures ?? 0,
    updatedAt: dateMs(row.updatedAt),
  }));
}

function dateMs(value: Date | null): number | null {
  return value ? value.getTime() : null;
}

function parseCursorKeys(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}
