import { fetchTrades, type PolymarketTrade } from "./client.js";
import type { Nomination } from "./nominator.js";

export type ProspectEvaluationVerdict = "promoted" | "rejected";

export interface ProspectEvaluationSnapshot {
  address: string;
  source: string;
  userName?: string | null;
  xUsername?: string | null;
  pnlUsd: number;
  volUsd: number;
  pnlPerVol: number;
  tradeCount: number | null;
  lastTradeTs: number | null;
  score: number;
  verdict: ProspectEvaluationVerdict;
  rejectReason?: string | null;
}

export interface ProspectEvaluationThresholds {
  minPnlUsd: number;
  minPnlPerVol: number;
  minTrades: number;
  recencyDays: number;
}

export interface EvaluateProspectOptions extends ProspectEvaluationThresholds {
  baseUrl: string;
  fetchImpl?: typeof fetch | undefined;
  nowMs?: number | undefined;
  fetchTradesFn?: typeof fetchTrades | undefined;
}

const TRADE_LIMIT = 100;
const DAY_MS = 86_400_000;
const CORROBORATION_SCORE_MULTIPLIER = 1.1;

export async function evaluateProspect(
  nomination: Nomination,
  opts: EvaluateProspectOptions
): Promise<ProspectEvaluationSnapshot> {
  const address = nomination.address.toLowerCase();
  const pnlPerVol = nomination.pnlUsd / Math.max(nomination.volUsd, 1);
  const baseSnapshot = {
    address,
    source: nomination.source,
    userName: nomination.userName ?? null,
    xUsername: nomination.xUsername ?? null,
    pnlUsd: nomination.pnlUsd,
    volUsd: nomination.volUsd,
    pnlPerVol,
    tradeCount: null,
    lastTradeTs: null,
    score: scoreFor(pnlPerVol, nomination.corroborated),
  };

  if (nomination.pnlUsd < opts.minPnlUsd) {
    return reject(baseSnapshot, "pnl_below_min");
  }
  if (pnlPerVol < opts.minPnlPerVol) {
    return reject(baseSnapshot, "pnl_per_vol_below_min");
  }

  const fetchOpts = opts.fetchImpl ? { limit: TRADE_LIMIT, fetchImpl: opts.fetchImpl } : { limit: TRADE_LIMIT };
  const trades = await (opts.fetchTradesFn ?? fetchTrades)(opts.baseUrl, address, fetchOpts);
  const tradeCount = trades.length;
  const lastTradeTs = newestTradeTsMs(trades);
  const withTrades = { ...baseSnapshot, tradeCount, lastTradeTs };

  if (tradeCount < opts.minTrades) {
    return reject(withTrades, "trade_count_below_min");
  }

  const cutoffMs = (opts.nowMs ?? Date.now()) - opts.recencyDays * DAY_MS;
  if (lastTradeTs === null || lastTradeTs < cutoffMs) {
    return reject(withTrades, "last_trade_too_old");
  }

  return {
    ...withTrades,
    verdict: "promoted",
    rejectReason: null,
  };
}

function scoreFor(pnlPerVol: number, corroborated: boolean | undefined): number {
  return corroborated ? pnlPerVol * CORROBORATION_SCORE_MULTIPLIER : pnlPerVol;
}

function newestTradeTsMs(trades: PolymarketTrade[]): number | null {
  let newest: number | null = null;
  for (const trade of trades) {
    const ts = trade.timestamp * 1000;
    if (newest === null || ts > newest) newest = ts;
  }
  return newest;
}

function reject(
  snapshot: Omit<ProspectEvaluationSnapshot, "verdict" | "rejectReason">,
  rejectReason: string
): ProspectEvaluationSnapshot {
  return {
    ...snapshot,
    verdict: "rejected",
    rejectReason,
  };
}