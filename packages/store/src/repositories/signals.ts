import { eq, and, gte, desc, or, isNull, isNotNull, inArray, sql } from "drizzle-orm";
import type { Db } from "../db.js";
import { tradeSignals } from "../schema.js";
import { NATIVE_TOKEN_PLACEHOLDER } from "@tradebot/core";
import type { TradeSignal, TokenRef, ChainId } from "@tradebot/core";
import { getToken } from "./tokens.js";

export type CandidateReviewStatus = NonNullable<TradeSignal["reviewStatus"]>;
const openCandidateStatuses: CandidateReviewStatus[] = ["pending", "copy-requested", "copying", "copy-failed"];
export type OpenCandidateReviewStatus = Extract<CandidateReviewStatus, "pending" | "copy-requested" | "copying" | "copy-failed">;
export type CandidateSignalStatusFilter = CandidateReviewStatus | "open";
export type CandidateSignalFilters = {
  chain?: ChainId;
  venue?: string;
  status?: CandidateSignalStatusFilter;
};
export type CandidateTriageGroup = {
  chain: ChainId;
  venue: string;
  status: OpenCandidateReviewStatus;
  count: number;
  oldestObservedAt: number;
  newestObservedAt: number;
};
export type CandidateTriageSummary = {
  generatedAt: number;
  totalOpen: number;
  groups: CandidateTriageGroup[];
};

export async function insertSignal(db: Db, signal: TradeSignal): Promise<string> {
  const rows = await db.insert(tradeSignals).values({
    id: signal.id,
    chain: signal.chain,
    walletId: signal.walletId,
    txHash: signal.txHash,
    source: signal.source,
    side: signal.side,
    tokenIn: signal.tokenIn.address,
    tokenOut: signal.tokenOut.address,
    amountIn: String(signal.amountIn),
    amountOut: String(signal.amountOut),
    venue: signal.venue,
    observedAt: new Date(signal.observedAt),
    confirmedAt: signal.confirmedAt !== null ? new Date(signal.confirmedAt) : undefined,
    blockNumber: signal.blockNumber ?? undefined,
    decodeStatus: signal.decodeStatus,
    confidence: signal.confidence != null ? String(signal.confidence) : undefined,
    reason: signal.reason ?? undefined,
    externalUrl: signal.externalUrl ?? undefined,
    reviewStatus: signal.reviewStatus ?? (signal.decodeStatus === "candidate" ? "pending" : undefined),
    poolId: signal.poolId ?? undefined,
    conditionId: signal.conditionId ?? undefined,
    outcomeIndex: signal.outcomeIndex ?? undefined,
  }).onConflictDoNothing().returning({ id: tradeSignals.id });

  const inserted = rows[0];
  if (inserted) return inserted.id;

  const existing = await db
    .select({ id: tradeSignals.id })
    .from(tradeSignals)
    .where(and(
      eq(tradeSignals.chain, signal.chain),
      eq(tradeSignals.txHash, signal.txHash),
      eq(tradeSignals.tokenIn, signal.tokenIn.address),
      eq(tradeSignals.tokenOut, signal.tokenOut.address),
      eq(tradeSignals.side, signal.side),
    ))
    .limit(1);

  const row = existing[0];
  if (!row) {
    throw new Error(`trade signal insert conflicted but no existing row was found for ${signal.chain}:${signal.txHash}`);
  }
  return row.id;
}

export async function upsertSignal(db: Db, signal: TradeSignal): Promise<void> {
  await db.insert(tradeSignals).values({
    id: signal.id,
    chain: signal.chain,
    walletId: signal.walletId,
    txHash: signal.txHash,
    source: signal.source,
    side: signal.side,
    tokenIn: signal.tokenIn.address,
    tokenOut: signal.tokenOut.address,
    amountIn: String(signal.amountIn),
    amountOut: String(signal.amountOut),
    venue: signal.venue,
    observedAt: new Date(signal.observedAt),
    confirmedAt: signal.confirmedAt !== null ? new Date(signal.confirmedAt) : undefined,
    blockNumber: signal.blockNumber ?? undefined,
    decodeStatus: signal.decodeStatus,
    confidence: signal.confidence != null ? String(signal.confidence) : undefined,
    reason: signal.reason ?? undefined,
    externalUrl: signal.externalUrl ?? undefined,
    reviewStatus: signal.reviewStatus ?? (signal.decodeStatus === "candidate" ? "pending" : undefined),
    poolId: signal.poolId ?? undefined,
    conditionId: signal.conditionId ?? undefined,
    outcomeIndex: signal.outcomeIndex ?? undefined,
  }).onConflictDoUpdate({
    target: [tradeSignals.chain, tradeSignals.txHash, tradeSignals.tokenIn, tradeSignals.tokenOut, tradeSignals.side],
    set: {
      source: signal.source,
      amountIn: String(signal.amountIn),
      amountOut: String(signal.amountOut),
      confirmedAt: signal.confirmedAt !== null ? new Date(signal.confirmedAt) : undefined,
      blockNumber: signal.blockNumber ?? undefined,
      decodeStatus: signal.decodeStatus,
      confidence: signal.confidence != null ? String(signal.confidence) : undefined,
      reason: signal.reason ?? undefined,
      externalUrl: signal.externalUrl ?? undefined,
      reviewStatus: signal.reviewStatus ?? (signal.decodeStatus === "candidate" ? "pending" : undefined),
      // Backfill poolId when a mempool signal (no poolId) is confirmed via a V4 strategyA decode.
      poolId: signal.poolId ?? undefined,
      conditionId: signal.conditionId ?? undefined,
      outcomeIndex: signal.outcomeIndex ?? undefined,
    },
  });
}

export async function getSignalById(db: Db, id: string): Promise<TradeSignal | null> {
  const rows = await db.select().from(tradeSignals).where(eq(tradeSignals.id, id)).limit(1);
  const row = rows[0];
  if (!row) return null;
  return hydrateSignal(db, rowToSignal(row));
}

export async function getSignalsByWallet(
  db: Db,
  walletId: string,
  since: Date | null,
  opts: { decodedOnly?: boolean } = {}
): Promise<TradeSignal[]> {
  const conditions = [eq(tradeSignals.walletId, walletId)];
  if (since !== null) conditions.push(gte(tradeSignals.observedAt, since));
  if (opts.decodedOnly) conditions.push(eq(tradeSignals.decodeStatus, "decoded"));
  const rows = await db.select().from(tradeSignals).where(and(...conditions));
  return hydrateSignals(db, rows.map(rowToSignal));
}

export async function getRecentSignals(db: Db, since: Date, limit: number): Promise<TradeSignal[]> {
  const rows = await db
    .select()
    .from(tradeSignals)
    .where(gte(tradeSignals.observedAt, since))
    .orderBy(desc(tradeSignals.observedAt))
    .limit(limit);
  return hydrateSignals(db, rows.map(rowToSignal));
}

export async function getCandidateSignals(db: Db, limit: number, filters: CandidateSignalFilters = {}): Promise<TradeSignal[]> {
  const conditions = [
    eq(tradeSignals.decodeStatus, "candidate"),
    candidateReviewStatusCondition(filters.status ?? "open"),
  ];
  if (filters.chain) conditions.push(eq(tradeSignals.chain, filters.chain));
  if (filters.venue) conditions.push(eq(tradeSignals.venue, filters.venue));

  const rows = await db
    .select()
    .from(tradeSignals)
    .where(and(...conditions))
    .orderBy(desc(tradeSignals.observedAt))
    .limit(limit);
  return hydrateSignals(db, rows.map(rowToSignal));
}

export async function getCandidateTriageSummary(db: Db): Promise<CandidateTriageSummary> {
  const normalizedStatus = sql<OpenCandidateReviewStatus>`coalesce(${tradeSignals.reviewStatus}, 'pending')`;
  const rows = await db
    .select({
      chain: tradeSignals.chain,
      venue: tradeSignals.venue,
      status: normalizedStatus,
      count: sql<number>`count(*)::int`,
      oldestObservedAt: sql<Date>`min(${tradeSignals.observedAt})`,
      newestObservedAt: sql<Date>`max(${tradeSignals.observedAt})`,
    })
    .from(tradeSignals)
    .where(and(
      eq(tradeSignals.decodeStatus, "candidate"),
      candidateReviewStatusCondition("open"),
    ))
    .groupBy(tradeSignals.chain, tradeSignals.venue, normalizedStatus);

  const groups = rows
    .map((row) => ({
      chain: row.chain as ChainId,
      venue: row.venue,
      status: row.status,
      count: Number(row.count),
      oldestObservedAt: timestampMillis(row.oldestObservedAt),
      newestObservedAt: timestampMillis(row.newestObservedAt),
    }))
    .sort((a, b) =>
      b.count - a.count ||
      a.chain.localeCompare(b.chain) ||
      a.venue.localeCompare(b.venue) ||
      a.status.localeCompare(b.status)
    );

  return {
    generatedAt: Date.now(),
    totalOpen: groups.reduce((sum, group) => sum + group.count, 0),
    groups,
  };
}

function timestampMillis(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

function candidateReviewStatusCondition(status: CandidateSignalStatusFilter) {
  if (status === "open") {
    return or(isNull(tradeSignals.reviewStatus), inArray(tradeSignals.reviewStatus, openCandidateStatuses));
  }
  if (status === "pending") {
    return or(isNull(tradeSignals.reviewStatus), eq(tradeSignals.reviewStatus, "pending"));
  }
  return eq(tradeSignals.reviewStatus, status);
}

export async function getCopyRequestedCandidates(db: Db, limit: number): Promise<TradeSignal[]> {
  const rows = await db
    .select()
    .from(tradeSignals)
    .where(and(
      eq(tradeSignals.decodeStatus, "candidate"),
      eq(tradeSignals.reviewStatus, "copy-requested"),
    ))
    .orderBy(tradeSignals.observedAt)
    .limit(limit);
  return hydrateSignals(db, rows.map(rowToSignal));
}

export async function setCandidateReviewStatus(
  db: Db,
  id: string,
  status: CandidateReviewStatus
): Promise<TradeSignal | null> {
  const rows = await db
    .update(tradeSignals)
    .set({ reviewStatus: status })
    .where(and(eq(tradeSignals.id, id), eq(tradeSignals.decodeStatus, "candidate")))
    .returning();
  const row = rows[0];
  return row ? hydrateSignal(db, rowToSignal(row)) : null;
}

export async function transitionCandidateReviewStatus(
  db: Db,
  id: string,
  fromStatuses: CandidateReviewStatus[],
  status: CandidateReviewStatus
): Promise<TradeSignal | null> {
  if (fromStatuses.length === 0) return null;
  const rows = await db
    .update(tradeSignals)
    .set({ reviewStatus: status })
    .where(and(
      eq(tradeSignals.id, id),
      eq(tradeSignals.decodeStatus, "candidate"),
      inArray(tradeSignals.reviewStatus, fromStatuses),
    ))
    .returning();
  const row = rows[0];
  return row ? hydrateSignal(db, rowToSignal(row)) : null;
}

/**
 * Recover a Uniswap V4 market hint for a held token from any persisted signal that traded it.
 * V4 pools can't be discovered on-chain by token pair, so downstream pricing paths that only have a
 * token (the marks job, exit-sell depth) use this to re-read the pool by its observed poolId. The
 * poolId is a property of the token's V4 pool, not of a specific trade, so the most recent signal
 * touching the token on either leg is sufficient; the counter currency is the other leg. Returns
 * null for non-V4 tokens (no signal carries a poolId).
 */
export async function getV4MarketHintForToken(
  db: Db,
  chain: ChainId,
  tokenAddress: string
): Promise<{ poolId: string; counterCurrency: string } | null> {
  const addr = tokenAddress.toLowerCase();
  const rows = await db
    .select({ tokenIn: tradeSignals.tokenIn, tokenOut: tradeSignals.tokenOut, poolId: tradeSignals.poolId })
    .from(tradeSignals)
    .where(and(
      eq(tradeSignals.chain, chain),
      isNotNull(tradeSignals.poolId),
      or(eq(tradeSignals.tokenIn, addr), eq(tradeSignals.tokenOut, addr)),
    ))
    .orderBy(desc(tradeSignals.observedAt))
    .limit(1);
  const row = rows[0];
  if (!row || !row.poolId) return null;
  const counterCurrency = row.tokenIn.toLowerCase() === addr ? row.tokenOut : row.tokenIn;
  return { poolId: row.poolId, counterCurrency };
}

async function hydrateSignals(db: Db, signals: TradeSignal[]): Promise<TradeSignal[]> {
  return Promise.all(signals.map((signal) => hydrateSignal(db, signal)));
}

async function hydrateSignal(db: Db, signal: TradeSignal): Promise<TradeSignal> {
  const [tokenIn, tokenOut] = await Promise.all([
    hydrateToken(db, signal.tokenIn),
    hydrateToken(db, signal.tokenOut),
  ]);
  return { ...signal, tokenIn, tokenOut };
}

async function hydrateToken(db: Db, token: TokenRef): Promise<TokenRef> {
  if (!token.address) return token;
  if (token.address.toLowerCase() === NATIVE_TOKEN_PLACEHOLDER) {
    return { ...token, symbol: token.symbol || "ETH", name: token.name || "Ether", decimals: 18 };
  }
  const row = await getToken(db, token.chain, token.address);
  if (!row) return token;
  return {
    ...token,
    symbol: row.symbol || token.symbol,
    decimals: row.decimals,
    ...(row.name ? { name: row.name } : {}),
  };
}

function rowToSignal(row: typeof tradeSignals.$inferSelect): TradeSignal {
  return {
    id: row.id,
    chain: row.chain as ChainId,
    walletId: row.walletId,
    txHash: row.txHash,
    source: row.source as "mempool" | "confirmed",
    side: row.side as "buy" | "sell",
    tokenIn: { chain: row.chain as ChainId, address: row.tokenIn, symbol: "", decimals: 18 },
    tokenOut: { chain: row.chain as ChainId, address: row.tokenOut, symbol: "", decimals: 18 },
    amountIn: BigInt(row.amountIn),
    amountOut: BigInt(row.amountOut),
    venue: row.venue,
    observedAt: row.observedAt.getTime(),
    confirmedAt: row.confirmedAt ? row.confirmedAt.getTime() : null,
    blockNumber: row.blockNumber ?? null,
    decodeStatus: row.decodeStatus === "candidate" ? "candidate" : "decoded",
    confidence: row.confidence != null ? Number(row.confidence) : null,
    reason: row.reason ?? null,
    externalUrl: row.externalUrl ?? null,
    reviewStatus: parseReviewStatus(row.reviewStatus),
    poolId: row.poolId ?? null,
    conditionId: row.conditionId ?? null,
    outcomeIndex: row.outcomeIndex ?? null,
  };
}

function parseReviewStatus(value: string | null): Exclude<TradeSignal["reviewStatus"], undefined> {
  if (
    value === "pending" ||
    value === "copy-requested" ||
    value === "copying" ||
    value === "copied" ||
    value === "copy-failed" ||
    value === "dismissed"
  ) {
    return value;
  }
  return null;
}
