import { createLogger, fromBaseUnits, isEvmChain, NATIVE_TOKEN_PLACEHOLDER, WETH } from "@tradebot/core";
import type { EvmChainId } from "@tradebot/core";
import type { Db } from "@tradebot/store";
import {
  getActiveWallets,
  getSignalsByWallet,
  getToken,
  latestMark,
  upsertLeaderStats,
  getAllLeaderStats,
  getSetting,
  setSetting,
  getCopiedFills,
  insertAdaptationLog,
} from "@tradebot/store";
import { getLiquidityUsd, getUsdPrice } from "@tradebot/pricing";
import type { LiquidityTier, WeightProvider } from "@tradebot/paper-engine";
import { fifoRoundTrips, computeScoringResult } from "./scoring.js";
import { computeZScore, computeScore, scoreToWeight, shouldAutoMute } from "./weights.js";
import { runLiquidityNotch, computePerLeaderMutes } from "./adaptation.js";
import type { FillRecord } from "./adaptation.js";
import type { ScoringResult, TradeRow, ScoreWindow } from "./scoring.js";

const logger = createLogger("brain");

// Loose structural RpcClient interface — avoids viem type-identity errors across packages.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RpcClient = { readContract: (args: any) => Promise<any> };
type RpcClients = Record<EvmChainId, RpcClient>;
type QuotePriceCache = Map<string, number>;
type LatestMarkLookup = typeof latestMark;
type QuotePriceLookup = typeof getUsdPrice;

// Quote asset addresses that price to 1 USD
const STABLE_ADDRESSES = new Set([
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", // USDC eth
  "0xdac17f958d2ee523a2206206994597c13d831ec7", // USDT eth
  "0x6b175474e89094c44da98b954eedeac495271d0f", // DAI eth
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", // USDC base
]);

export class BrainWeightProvider implements WeightProvider {
  private weights = new Map<string, number>();
  private mutedTiers = new Map<string, Set<LiquidityTier>>();

  getWeight(walletId: string): number {
    return this.weights.get(walletId) ?? 1.0;
  }

  refresh(weights: Map<string, number>): void {
    this.weights = new Map(weights);
  }

  getMutedLiquidityTiers(walletId: string): ReadonlySet<LiquidityTier> {
    return this.mutedTiers.get(walletId) ?? new Set<LiquidityTier>();
  }

  refreshMutedTiers(mutedTiers: Map<string, Set<LiquidityTier>>): void {
    this.mutedTiers = new Map(
      Array.from(mutedTiers.entries(), ([walletId, tiers]) => [walletId, new Set(tiers)])
    );
  }
}

export function baselineWeightForTradeCount(trades: number): number {
  return trades < 5 ? 0.5 : 1.0;
}

export function scoreResultAgainstCohort(
  result: ScoringResult,
  cohort: ScoringResult[]
): { score: number | null; weight: number } {
  let score: number | null = null;
  let weight = baselineWeightForTradeCount(result.trades);

  if (result.trades >= 5 && result.realizedPnlUsd !== null) {
    const eligibleCohort = cohort.filter((s) => s.trades >= 5 && s.realizedPnlUsd !== null);
    const pnlCohort = eligibleCohort.map((s) => s.realizedPnlUsd ?? 0);
    const winRateCohort = eligibleCohort.map((s) => s.winRate ?? 0);
    const avgRetCohort = eligibleCohort.map((s) => s.avgReturnPct ?? 0);
    const ddCohort = eligibleCohort.map((s) => s.maxDrawdownPct ?? 0);

    const pnlZ = computeZScore(result.realizedPnlUsd, pnlCohort);
    const winRateZ = computeZScore(result.winRate ?? 0, winRateCohort);
    const avgRetZ = computeZScore(result.avgReturnPct ?? 0, avgRetCohort);
    const ddZ = computeZScore(result.maxDrawdownPct ?? 0, ddCohort);
    score = computeScore(pnlZ, winRateZ, avgRetZ, ddZ);
    weight = scoreToWeight(score);
  }

  return { score, weight };
}

function normalizeQuoteAddress(chain: EvmChainId, address: string): string {
  const addr = address.toLowerCase();
  return addr === "" || addr === NATIVE_TOKEN_PLACEHOLDER ? WETH[chain] : addr;
}

export async function resolveQuoteUsdPrice({
  db,
  chain,
  address,
  rpcClient,
  cache,
  latestMarkLookup = latestMark,
  quotePriceLookup = getUsdPrice,
}: {
  db: Db;
  chain: EvmChainId;
  address: string;
  rpcClient?: RpcClient;
  cache?: QuotePriceCache;
  latestMarkLookup?: LatestMarkLookup;
  quotePriceLookup?: QuotePriceLookup;
}): Promise<number | null> {
  const quoteAddress = normalizeQuoteAddress(chain, address);
  if (STABLE_ADDRESSES.has(quoteAddress)) return 1.0;

  const cacheKey = `${chain}:${quoteAddress}`;
  const cached = cache?.get(cacheKey);
  if (cached !== undefined) return cached;

  const mark = await latestMarkLookup(db, chain, quoteAddress);
  if (mark && mark.priceUsd > 0) {
    cache?.set(cacheKey, mark.priceUsd);
    return mark.priceUsd;
  }

  if (rpcClient) {
    const price = await quotePriceLookup(chain, quoteAddress, rpcClient);
    if (price !== null && price > 0) {
      cache?.set(cacheKey, price);
      return price;
    }
  }

  return null;
}

export function tokenDecimalsForScoring(address: string, storedDecimals: number | null | undefined, fallback: number): number {
  const normalized = address.toLowerCase();
  if (normalized === NATIVE_TOKEN_PLACEHOLDER || normalized === WETH.eth || normalized === WETH.base) return 18;
  return storedDecimals ?? fallback;
}

async function signalsToTradeRows(
  db: Db,
  walletId: string,
  since: Date | null,
  rpcClients?: RpcClients,
  quotePriceCache?: QuotePriceCache
): Promise<TradeRow[]> {
  // Candidates are the decoder's uncertainty, not the leader's behavior — exclude them from
  // scoring (see docs/adr/0001-persist-candidates-outside-scoring.md).
  const signals = await getSignalsByWallet(db, walletId, since, { decodedOnly: true });
  const rows: TradeRow[] = [];

  for (const sig of signals) {
    // Decoded signals are EVM-only (Polymarket trades are candidates, excluded above), but the
    // row's chain is typed ChainId — guard so the AMM pricing/RPC maps are only indexed by EVM.
    if (!isEvmChain(sig.chain)) continue;
    const nonQuoteAddress = sig.side === "buy" ? sig.tokenOut.address : sig.tokenIn.address;
    const quoteAddress = sig.side === "buy" ? sig.tokenIn.address : sig.tokenOut.address;
    const rawQty = sig.side === "buy" ? sig.amountOut : sig.amountIn;
    const rawQuoteAmt = sig.side === "buy" ? sig.amountIn : sig.amountOut;

    const tokenRow = await getToken(db, sig.chain, nonQuoteAddress);
    const quoteRow = await getToken(db, sig.chain, quoteAddress);
    const decimals = tokenDecimalsForScoring(nonQuoteAddress, tokenRow?.decimals, 18);
    const quoteDecimals = tokenDecimalsForScoring(quoteAddress, quoteRow?.decimals, 6);

    const qty = fromBaseUnits(rawQty, decimals);
    const quoteAmt = fromBaseUnits(rawQuoteAmt, quoteDecimals);

    const quoteUsd = await resolveQuoteUsdPrice({
      db,
      chain: sig.chain,
      address: quoteAddress,
      ...(rpcClients ? { rpcClient: rpcClients[sig.chain] } : {}),
      ...(quotePriceCache ? { cache: quotePriceCache } : {}),
    });
    if (quoteUsd === null) continue;
    const costOrProceeds = quoteAmt * quoteUsd;
    const priceUsd = qty > 0 ? costOrProceeds / qty : 0;

    if (priceUsd <= 0 || qty <= 0) continue;

    rows.push({
      side: sig.side,
      tokenAddress: nonQuoteAddress.toLowerCase(),
      chain: sig.chain,
      qty,
      priceUsd,
      observedAt: new Date(sig.observedAt),
    });
  }

  return rows;
}

async function scoreWallet(
  db: Db,
  walletId: string,
  window: ScoreWindow,
  since: Date | null,
  rpcClients?: RpcClients,
  quotePriceCache?: QuotePriceCache
): Promise<{ result: ReturnType<typeof computeScoringResult>; rows: TradeRow[] }> {
  const rows = await signalsToTradeRows(db, walletId, since, rpcClients, quotePriceCache);

  // Build mark prices for open remainders
  const markPrices = new Map<string, number>();
  const seen = new Set<string>();
  for (const row of rows) {
    const key = `${row.chain}:${row.tokenAddress}`;
    if (!seen.has(key)) {
      seen.add(key);
      const mark = await latestMark(db, row.chain, row.tokenAddress);
      if (mark) markPrices.set(key, mark.priceUsd);
    }
  }

  const roundTrips = fifoRoundTrips(rows, markPrices);
  const result = computeScoringResult(walletId, window, roundTrips);
  return { result, rows };
}

function windowToSince(window: ScoreWindow): Date | null {
  if (window === "all") return null;
  const ms = window === "7d" ? 7 * 86_400_000 : 30 * 86_400_000;
  return new Date(Date.now() - ms);
}

export async function runScorerJob(db: Db, weightProvider: BrainWeightProvider, rpcClients?: RpcClients): Promise<void> {
  logger.info("Starting scorer job");

  const wallets = await getActiveWallets(db);
  const windows: ScoreWindow[] = ["7d", "30d", "all"];
  const quotePriceCache: QuotePriceCache = new Map();

  for (const window of windows) {
    const currentResults: ScoringResult[] = [];
    const failedWalletIds = new Set<string>();

    for (const wallet of wallets) {
      try {
        const since = windowToSince(window);
        const { result } = await scoreWallet(db, wallet.id, window, since, rpcClients, quotePriceCache);
        currentResults.push(result);
      } catch (err) {
        failedWalletIds.add(wallet.id);
        logger.error({ walletId: wallet.id, window, err }, "failed to score wallet");
      }
    }

    for (const wallet of wallets) {
      if (failedWalletIds.has(wallet.id)) continue;
      const result = currentResults.find((r) => r.walletId === wallet.id);
      if (!result) continue;

      try {
        let { score, weight } = scoreResultAgainstCohort(result, currentResults);
        // Auto-mute check on 7d window
        if (window === "7d" && shouldAutoMute(score)) {
          weight = 0;
          logger.info({ walletId: wallet.id, score }, "auto-muting leader");
          await insertAdaptationLog(db, {
            rule: "auto-mute",
            oldValue: String(weightProvider.getWeight(wallet.id)),
            newValue: "0",
            evidenceJson: { walletId: wallet.id, score7d: score, trades: result.trades },
          });
        }

        await upsertLeaderStats(db, {
          walletId: wallet.id,
          window,
          trades: result.trades,
          winRate: result.winRate,
          avgReturnPct: result.avgReturnPct,
          medianHoldMinutes: result.medianHoldMinutes,
          realizedPnlUsd: result.realizedPnlUsd,
          maxDrawdownPct: result.maxDrawdownPct,
          score,
          weight,
        });

        logger.debug({ walletId: wallet.id, window, trades: result.trades, score, weight }, "scored wallet");
      } catch (err) {
        logger.error({ walletId: wallet.id, window, err }, "failed to score wallet");
      }
    }
  }

  // Refresh in-memory weights from 7d stats
  const stats7d = await getAllLeaderStats(db, "7d");
  const weightMap = new Map<string, number>();
  for (const s of stats7d) {
    weightMap.set(s.walletId, s.weight);
  }
  weightProvider.refresh(weightMap);

  // Run weekly adaptation (always runs as part of scorer — adaptation guards itself with fill count)
  const mutedTiers = await runAdaptationJob(db, rpcClients);
  weightProvider.refreshMutedTiers(mutedTiers);

  logger.info({ wallets: wallets.length }, "Scorer job complete");
}

async function runAdaptationJob(db: Db, rpcClients?: RpcClients): Promise<Map<string, Set<LiquidityTier>>> {
  try {
    const fills = await getCopiedFills(db);
    const minLiqRaw = await getSetting(db, "min_liquidity_usd");
    const currentMin = typeof minLiqRaw === "number" ? minLiqRaw : 150_000;

    const liquidityCache = new Map<string, number | null>();
    const fillRecords: FillRecord[] = [];
    for (const f of fills) {
      // Copied fills are EVM-only; guard so the AMM liquidity/RPC maps are only indexed by EVM.
      if (!isEvmChain(f.chain)) continue;
      const mark = await latestMark(db, f.chain, f.tokenAddress);
      const liquidityUsd = await getAdaptationLiquidityUsd(f.chain, f.tokenAddress, rpcClients, liquidityCache);
      fillRecords.push({
        id: f.id,
        walletId: f.walletId,
        tokenAddress: f.tokenAddress,
        side: f.side,
        qty: f.qty,
        entryPriceUsd: f.priceUsd,
        currentPriceUsd: mark?.priceUsd ?? f.priceUsd,
        notionalUsd: f.notionalUsd,
        liquidityUsd,
      });
    }

    await runLiquidityNotch({
      getBuyFills: () => fillRecords.filter((f) => f.side === "buy"),
      getCurrentMinLiquidityUsd: () => currentMin,
      setMinLiquidityUsd: async (value, evidence) => {
        await setSetting(db, "min_liquidity_usd", value);
        logger.info({ value, evidence }, "min_liquidity_usd updated");
      },
      logAdaptation: async (entry) => {
        await insertAdaptationLog(db, entry);
      },
    });

    const mutes = computePerLeaderMutes(fillRecords);
    if (mutes.size > 0) {
      logger.info({ muteCount: mutes.size }, "per-leader tier mutes computed");
    }
    return mutes;
  } catch (err) {
    logger.error({ err }, "adaptation job failed");
    return new Map();
  }
}

async function getAdaptationLiquidityUsd(
  chain: EvmChainId,
  tokenAddress: string,
  rpcClients: RpcClients | undefined,
  cache: Map<string, number | null>
): Promise<number | null> {
  if (!rpcClients) return null;
  const key = `${chain}:${tokenAddress.toLowerCase()}`;
  if (cache.has(key)) return cache.get(key) ?? null;
  try {
    const value = await getLiquidityUsd(chain, tokenAddress, rpcClients[chain]);
    cache.set(key, value);
    return value;
  } catch (err) {
    logger.warn({ err, chain, tokenAddress }, "adaptation liquidity lookup failed");
    cache.set(key, null);
    return null;
  }
}

export function startScorerJob(
  db: Db,
  weightProvider: BrainWeightProvider,
  rpcClients?: RpcClients
): { stop: () => void } {
  // Run immediately, then every hour
  void runScorerJob(db, weightProvider, rpcClients).catch((err) =>
    logger.error({ err }, "scorer job error")
  );

  const timer = setInterval(
    () => void runScorerJob(db, weightProvider, rpcClients).catch((err) =>
      logger.error({ err }, "scorer job error")
    ),
    60 * 60_000
  );

  return {
    stop: () => clearInterval(timer),
  };
}
