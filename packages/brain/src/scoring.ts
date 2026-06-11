import type { ChainId } from "@tradebot/core";

export type ScoreWindow = "7d" | "30d" | "all";

export type TradeRow = {
  side: "buy" | "sell";
  tokenAddress: string;
  chain: ChainId;
  qty: number;       // human units of non-quote token
  priceUsd: number;  // USD price per unit at trade time
  observedAt: Date;
};

export type RoundTrip = {
  tokenAddress: string;
  chain: ChainId;
  entryQty: number;
  entryPriceUsd: number;
  exitPriceUsd: number;
  openedAt: Date;
  closedAt: Date;
  holdMinutes: number;
  returnPct: number;
  pnlUsd: number;
};

export type ScoringResult = {
  walletId: string;
  window: ScoreWindow;
  trades: number;
  winRate: number | null;
  avgReturnPct: number | null;
  medianHoldMinutes: number | null;
  realizedPnlUsd: number | null;
  maxDrawdownPct: number | null;
};

type BuyLot = {
  qty: number;
  priceUsd: number;
  observedAt: Date;
};

/**
 * FIFO round-trip reconstruction.
 * markPrices: "chain:tokenAddress" → current USD price, used to close open lots as-of-now.
 */
export function fifoRoundTrips(
  trades: TradeRow[],
  markPrices?: Map<string, number>
): RoundTrip[] {
  const groups = new Map<string, TradeRow[]>();
  for (const t of trades) {
    const key = `${t.chain}:${t.tokenAddress}`;
    const arr = groups.get(key) ?? [];
    arr.push(t);
    groups.set(key, arr);
  }

  const roundTrips: RoundTrip[] = [];
  const now = new Date();

  for (const [groupKey, tokenTrades] of groups) {
    tokenTrades.sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime());

    const queue: BuyLot[] = [];

    for (const trade of tokenTrades) {
      if (trade.side === "buy") {
        queue.push({ qty: trade.qty, priceUsd: trade.priceUsd, observedAt: trade.observedAt });
      } else {
        let remaining = trade.qty;
        while (remaining > 1e-10 && queue.length > 0) {
          const lot = queue[0]!;
          const consumed = Math.min(remaining, lot.qty);
          const holdMinutes = (trade.observedAt.getTime() - lot.observedAt.getTime()) / 60_000;
          const returnPct = lot.priceUsd > 0
            ? ((trade.priceUsd - lot.priceUsd) / lot.priceUsd) * 100
            : 0;

          roundTrips.push({
            tokenAddress: trade.tokenAddress,
            chain: trade.chain,
            entryQty: consumed,
            entryPriceUsd: lot.priceUsd,
            exitPriceUsd: trade.priceUsd,
            openedAt: lot.observedAt,
            closedAt: trade.observedAt,
            holdMinutes,
            returnPct,
            pnlUsd: consumed * (trade.priceUsd - lot.priceUsd),
          });

          lot.qty -= consumed;
          remaining -= consumed;
          if (lot.qty < 1e-10) queue.shift();
        }
      }
    }

    // Mark open remainders at current price if provided
    if (markPrices && queue.length > 0) {
      const markPrice = markPrices.get(groupKey);
      if (markPrice !== undefined && markPrice > 0) {
        for (const lot of queue) {
          if (lot.qty < 1e-10) continue;
          const holdMinutes = (now.getTime() - lot.observedAt.getTime()) / 60_000;
          const returnPct = lot.priceUsd > 0
            ? ((markPrice - lot.priceUsd) / lot.priceUsd) * 100
            : 0;
          roundTrips.push({
            tokenAddress: trades[0]!.tokenAddress,
            chain: trades[0]!.chain,
            entryQty: lot.qty,
            entryPriceUsd: lot.priceUsd,
            exitPriceUsd: markPrice,
            openedAt: lot.observedAt,
            closedAt: now,
            holdMinutes,
            returnPct,
            pnlUsd: lot.qty * (markPrice - lot.priceUsd),
          });
        }
      }
    }
  }

  return roundTrips;
}

export function computeScoringResult(
  walletId: string,
  window: ScoreWindow,
  roundTrips: RoundTrip[]
): ScoringResult {
  const trades = roundTrips.length;

  if (trades === 0) {
    return {
      walletId,
      window,
      trades: 0,
      winRate: null,
      avgReturnPct: null,
      medianHoldMinutes: null,
      realizedPnlUsd: null,
      maxDrawdownPct: null,
    };
  }

  const winRate = roundTrips.filter((r) => r.pnlUsd > 0).length / trades;
  const avgReturnPct = roundTrips.reduce((s, r) => s + r.returnPct, 0) / trades;

  const sortedHolds = roundTrips.map((r) => r.holdMinutes).sort((a, b) => a - b);
  const mid = Math.floor(sortedHolds.length / 2);
  const medianHoldMinutes =
    sortedHolds.length % 2 === 0
      ? ((sortedHolds[mid - 1] ?? 0) + (sortedHolds[mid] ?? 0)) / 2
      : (sortedHolds[mid] ?? 0);

  const realizedPnlUsd = roundTrips.reduce((s, r) => s + r.pnlUsd, 0);

  // Max drawdown over the cumulative-PnL series of closed trades (sorted by closedAt)
  const sorted = [...roundTrips].sort((a, b) => a.closedAt.getTime() - b.closedAt.getTime());
  let peak = 0;
  let cumPnl = 0;
  let maxDrawdownPct = 0;
  for (const rt of sorted) {
    cumPnl += rt.pnlUsd;
    if (cumPnl > peak) peak = cumPnl;
    if (peak > 0) {
      const dd = ((peak - cumPnl) / peak) * 100;
      if (dd > maxDrawdownPct) maxDrawdownPct = dd;
    }
  }

  return {
    walletId,
    window,
    trades,
    winRate,
    avgReturnPct,
    medianHoldMinutes,
    realizedPnlUsd,
    maxDrawdownPct,
  };
}
