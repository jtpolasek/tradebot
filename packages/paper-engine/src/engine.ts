import { randomUUID } from "crypto";
import PQueue from "p-queue";
import { CHAIN_IDS, WETH } from "@tradebot/core";
import type { ChainId, TradeSignal, PaperFill, TokenRef } from "@tradebot/core";
import type { Config, EventBus } from "@tradebot/core";
import type { Db } from "@tradebot/store";
import {
  insertSignal,
  upsertSignal,
  insertFill,
  updateFill,
  voidFill,
  upsertPosition,
  closePositionByKey,
  getPosition,
  getOpenPositions,
  latestSnapshot,
  getRecentSnapshots,
  insertSnapshot,
  getToken,
  getAllSettings,
  latestMark,
} from "@tradebot/store";
import { assertUsableZeroxQuote, getLiquidityUsd, getUsdPrice, getZeroxPrice } from "@tradebot/pricing";
import { applyTradeToState } from "./accounting.js";
import type { AccountingPortfolio, AccountingPosition } from "./accounting.js";
import { estimateSourceNotionalUsd } from "./sizing.js";
import type { SizingCandidate } from "./sizing.js";
import { createLogger } from "@tradebot/core";

const logger = createLogger("paper-engine");

export interface WeightProvider {
  getWeight(walletId: string): number;
  getMutedLiquidityTiers?(walletId: string): ReadonlySet<LiquidityTier>;
}

const constantWeights: WeightProvider = {
  getWeight: () => 1.0,
};

// Loose structural RpcClient interface — avoids viem type-identity errors
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RpcClient = { readContract: (args: any) => Promise<any> };

type InMemoryPosition = {
  qty: number;
  avgCostUsd: number;
  realizedPnlUsd: number;
};

type ProvisionalEntry = {
  fillId: string;
  signalId: string;
  side: "buy" | "sell";
  posKey: string;
  chain: ChainId;
  tokenAddress: string;
  sourceWalletId: string;
  qty: number;
  leaderHoldingKey: string;
  prevLeaderHolding: number | undefined;
  // Per-trade portfolio deltas, reversed on void/replace so interleaved fills aren't clobbered.
  cashDelta: number;
  realizedPnlDelta: number;
  feesDelta: number;
  // Pre-trade position snapshot for this token, restored on void/replace.
  prevPosition: InMemoryPosition | null;
};

export type LiquidityTier = "major" | "mid" | "longtail";

type RuntimeConfig = Pick<Config, "BASE_TRADE_PCT" | "MAX_TRADE_PCT" | "MIN_NOTIONAL_USD" | "MIN_LIQUIDITY_USD" | "SIZING_MODE">;

const RECENT_NOTIONAL_WINDOW = 20;
const DEX_FEE_BPS = 30;

export class PaperEngine {
  private cashUsd: number;
  private positions = new Map<string, InMemoryPosition>();
  private provisionals = new Map<string, ProvisionalEntry>();
  private portfolio: AccountingPortfolio;
  private queue: PQueue;
  private snapshotTimer: ReturnType<typeof setInterval> | null = null;
  private settingsTimer: ReturnType<typeof setInterval> | null = null;
  private runtimeConfig: RuntimeConfig;
  private readonly recentSourceNotionals = new Map<string, number[]>();
  private readonly leaderHoldings = new Map<string, number>();
  private readonly markPrices = new Map<string, number>();
  private readonly nativeUsd: Record<ChainId, number> = { eth: 0, base: 0 };

  private readonly rpcClients: Record<ChainId, RpcClient>;

  constructor(
    private readonly db: Db,
    private readonly bus: EventBus,
    private readonly cfg: Config,
    rpcClients: RpcClient | Record<ChainId, RpcClient>,
    private readonly weights: WeightProvider = constantWeights,
  ) {
    // Accept either a single client (legacy/tests) or a per-chain map.
    this.rpcClients =
      "eth" in rpcClients && "base" in rpcClients
        ? (rpcClients as Record<ChainId, RpcClient>)
        : { eth: rpcClients as RpcClient, base: rpcClients as RpcClient };
    this.cashUsd = cfg.PAPER_STARTING_CASH_USD;
    this.portfolio = { cashUsd: this.cashUsd, realizedPnlUsd: 0, feesPaidUsd: 0 };
    this.queue = new PQueue({ concurrency: 4 });
    this.runtimeConfig = {
      BASE_TRADE_PCT: cfg.BASE_TRADE_PCT,
      MAX_TRADE_PCT: cfg.MAX_TRADE_PCT,
      MIN_NOTIONAL_USD: cfg.MIN_NOTIONAL_USD,
      MIN_LIQUIDITY_USD: cfg.MIN_LIQUIDITY_USD,
      SIZING_MODE: cfg.SIZING_MODE,
    };
  }

  async start(): Promise<void> {
    await this.loadState();
    await this.refreshRuntimeSettings();

    this.bus.on("trade-signal", (signal) => {
      this.enqueue("handleSignal", () => this.handleSignal(signal), { txHash: signal.txHash });
    });

    this.bus.on("signal-confirmed", ({ signalId, confirmed }) => {
      this.enqueue("handleConfirmed", () => this.handleConfirmed(signalId, confirmed), { signalId });
    });

    this.bus.on("signal-voided", ({ signalId, reason }) => {
      this.enqueue("handleVoided", () => this.handleVoided(signalId, reason as "reverted" | "replaced"), { signalId });
    });

    // Snapshot every 5 minutes
    this.snapshotTimer = setInterval(
      () => this.enqueue("takeSnapshot", () => this.takeSnapshot()),
      5 * 60_000
    );
    this.settingsTimer = setInterval(
      () => this.enqueue("refreshRuntimeSettings", () => this.refreshRuntimeSettings()),
      60_000
    );

    logger.info({ cashUsd: this.cashUsd }, "PaperEngine started");
  }

  stop(): void {
    if (this.snapshotTimer) {
      clearInterval(this.snapshotTimer);
      this.snapshotTimer = null;
    }
    if (this.settingsTimer) {
      clearInterval(this.settingsTimer);
      this.settingsTimer = null;
    }
  }

  /** Enqueue work, catching errors so a failed handler never becomes an unhandled rejection. */
  private enqueue(label: string, work: () => Promise<void>, ctx: Record<string, unknown> = {}): void {
    void this.queue
      .add(async () => {
        try {
          await work();
        } catch (err) {
          logger.error({ err, ...ctx }, `${label} failed`);
        }
      })
      .catch((err: unknown) => logger.error({ err, ...ctx }, `${label} enqueue failed`));
  }

  private async loadState(): Promise<void> {
    const snap = await latestSnapshot(this.db);
    if (snap) {
      this.cashUsd = snap.cashUsd;
      this.portfolio.cashUsd = snap.cashUsd;
    } else {
      this.cashUsd = this.cfg.PAPER_STARTING_CASH_USD;
      this.portfolio.cashUsd = this.cashUsd;
    }

    const openPositions = await getOpenPositions(this.db);
    for (const pos of openPositions) {
      const key = posKey(pos.chain, pos.tokenAddress, pos.sourceWalletId);
      const mark = await latestMark(this.db, pos.chain, pos.tokenAddress);
      if (mark && mark.priceUsd > 0) {
        this.markPrices.set(markKey(pos.chain, pos.tokenAddress), mark.priceUsd);
      }
      this.positions.set(key, {
        qty: pos.qty,
        avgCostUsd: pos.avgCostUsd,
        realizedPnlUsd: pos.realizedPnlUsd,
      });
    }

    logger.info(
      { cashUsd: this.cashUsd, openPositions: openPositions.length },
      "PaperEngine state loaded from DB"
    );
  }

  private equity(): number {
    let posValue = 0;
    for (const [key, pos] of this.positions) {
      posValue += this.positionValueUsd(key, pos);
    }
    return this.cashUsd + posValue;
  }

  private positionValueUsd(key: string, pos: InMemoryPosition): number {
    const [chain, tokenAddress] = key.split(":") as [ChainId | undefined, string | undefined];
    const mark = chain && tokenAddress ? this.markPrices.get(markKey(chain, tokenAddress)) : undefined;
    return pos.qty * (mark ?? pos.avgCostUsd);
  }

  private async refreshRuntimeSettings(): Promise<void> {
    const settings = await getAllSettings(this.db);
    this.runtimeConfig = {
      BASE_TRADE_PCT: numberSetting(settings, ["BASE_TRADE_PCT", "base_trade_pct"], this.cfg.BASE_TRADE_PCT),
      MAX_TRADE_PCT: numberSetting(settings, ["MAX_TRADE_PCT", "max_trade_pct"], this.cfg.MAX_TRADE_PCT),
      MIN_NOTIONAL_USD: numberSetting(settings, ["MIN_NOTIONAL_USD", "min_notional_usd"], this.cfg.MIN_NOTIONAL_USD),
      MIN_LIQUIDITY_USD: numberSetting(settings, ["MIN_LIQUIDITY_USD", "min_liquidity_usd"], this.cfg.MIN_LIQUIDITY_USD),
      SIZING_MODE: sizingModeSetting(settings, ["SIZING_MODE", "sizing_mode"], this.cfg.SIZING_MODE),
    };
    await this.refreshNativePrices();
  }

  /** Cache the native (WETH) USD price per chain so proportional sizing can value ETH-quoted trades. */
  private async refreshNativePrices(): Promise<void> {
    for (const chain of ["eth", "base"] as ChainId[]) {
      try {
        const price = await getUsdPrice(chain, WETH[chain], this.rpcClients[chain]);
        if (price && price > 0) this.nativeUsd[chain] = price;
      } catch {
        // keep last known native price
      }
    }
  }

  decide(signal: TradeSignal, liquidityUsd: number | null): { action: "copy"; notionalUsd: number } | { action: "skip"; reason: string } {
    const weight = this.weights.getWeight(signal.walletId);
    if (weight === 0) return { action: "skip", reason: "leader-weight-zero" };

    if (liquidityUsd === null) return { action: "skip", reason: "no-liquidity-data" };
    const mutedTiers = this.weights.getMutedLiquidityTiers?.(signal.walletId);
    if (mutedTiers?.has(classifyLiquidityTier(liquidityUsd))) return { action: "skip", reason: "leader-tier-muted" };
    if (liquidityUsd < this.runtimeConfig.MIN_LIQUIDITY_USD) return { action: "skip", reason: "below-min-liquidity" };

    const eq = this.equity();
    let notional = eq * this.runtimeConfig.BASE_TRADE_PCT * weight;
    if (this.runtimeConfig.SIZING_MODE === "proportional") {
      notional *= this.proportionalScale(signal);
    }
    notional = Math.max(notional, this.runtimeConfig.MIN_NOTIONAL_USD);
    notional = Math.min(notional, eq * this.runtimeConfig.MAX_TRADE_PCT);

    if (signal.side === "buy") {
      notional = Math.min(notional, this.cashUsd);
      if (notional < this.runtimeConfig.MIN_NOTIONAL_USD) {
        return {
          action: "skip",
          reason: this.cashUsd < this.runtimeConfig.MIN_NOTIONAL_USD ? "insufficient-balance" : "below-min-notional",
        };
      }
      return { action: "copy", notionalUsd: notional };
    }

    // Sell
    const token = signal.side === "sell" ? signal.tokenIn : signal.tokenOut;
    const key = posKey(signal.chain, token.address, signal.walletId);
    const pos = this.positions.get(key);
    if (!pos || pos.qty <= 0) return { action: "skip", reason: "no-position" };

    const fraction = this.estimateLeaderSellFraction(signal);
    const sellQty = fraction * pos.qty;

    return { action: "copy", notionalUsd: sellQty * pos.avgCostUsd };
  }

  private estimateSignalSourceNotionalUsd(signal: TradeSignal): number | null {
    const candidate: SizingCandidate = {
      side: signal.side,
      tokenInSymbol: signal.tokenIn.symbol,
      tokenInAddress: signal.tokenIn.address,
      tokenInAmountHuman: rawToHumanNumber(signal.amountIn, signal.tokenIn.decimals),
      tokenOutSymbol: signal.tokenOut.symbol,
      tokenOutAddress: signal.tokenOut.address,
      tokenOutAmountHuman: rawToHumanNumber(signal.amountOut, signal.tokenOut.decimals),
    };
    const notional = estimateSourceNotionalUsd(candidate, this.nativeUsd[signal.chain] ?? 0);
    return Number.isFinite(notional) && notional > 0 ? notional : null;
  }

  private proportionalScale(signal: TradeSignal): number {
    const sourceNotionalUsd = this.estimateSignalSourceNotionalUsd(signal);
    const recent = this.recentSourceNotionals.get(signal.walletId) ?? [];
    const median = medianNumber(recent);
    if (sourceNotionalUsd === null || median === null || median <= 0) return 1;
    return clamp(sourceNotionalUsd / median, 0.25, 4);
  }

  private rememberSourceNotional(signal: TradeSignal): void {
    const sourceNotionalUsd = this.estimateSignalSourceNotionalUsd(signal);
    if (sourceNotionalUsd === null || sourceNotionalUsd <= 0) return;
    const recent = this.recentSourceNotionals.get(signal.walletId) ?? [];
    recent.push(sourceNotionalUsd);
    while (recent.length > RECENT_NOTIONAL_WINDOW) recent.shift();
    this.recentSourceNotionals.set(signal.walletId, recent);
  }

  private estimateLeaderSellFraction(signal: TradeSignal): number {
    if (signal.side !== "sell") return 1;
    const soldQty = rawToHumanNumber(signal.amountIn, signal.tokenIn.decimals);
    if (!Number.isFinite(soldQty) || soldQty <= 0) return 1;

    const heldQty = this.leaderHoldings.get(leaderHoldingKey(signal.chain, signal.tokenIn.address, signal.walletId));
    if (heldQty === undefined || heldQty <= 0) return 1;

    return clamp(soldQty / heldQty, 0, 1);
  }

  private rememberLeaderHolding(signal: TradeSignal): void {
    const token = signal.side === "buy" ? signal.tokenOut : signal.tokenIn;
    const rawAmount = signal.side === "buy" ? signal.amountOut : signal.amountIn;
    const qty = rawToHumanNumber(rawAmount, token.decimals);
    if (!Number.isFinite(qty) || qty <= 0) return;

    const key = leaderHoldingKey(signal.chain, token.address, signal.walletId);
    const current = this.leaderHoldings.get(key);
    if (signal.side === "buy") {
      this.leaderHoldings.set(key, (current ?? 0) + qty);
      return;
    }

    if (current === undefined || current <= 0) return;
    const next = Math.max(0, current - qty);
    if (next <= 1e-10) {
      this.leaderHoldings.delete(key);
    } else {
      this.leaderHoldings.set(key, next);
    }
  }

  private async handleSignal(signal: TradeSignal): Promise<void> {
    const storedSignalId = await insertSignal(this.db, signal);
    if (storedSignalId !== signal.id) {
      signal = { ...signal, id: storedSignalId };
    }

    const token: TokenRef = signal.side === "buy" ? signal.tokenOut : signal.tokenIn;
    const quoteToken: TokenRef = signal.side === "buy" ? signal.tokenIn : signal.tokenOut;

    // Decode-confidence veto: the engine acts on confidently decoded signals only. Candidates are
    // persisted (above) for the human review queue but never auto-copied, since a wrong side/token
    // guess would spend paper money on the decoder's uncertainty.
    if (signal.decodeStatus === "candidate") {
      const decidedAt = Date.now();
      const fill: PaperFill = {
        id: randomUUID(),
        signalId: signal.id,
        decidedAt,
        decision: "skipped",
        skipReason: "low-confidence-decode",
        side: signal.side,
        token,
        quoteToken,
        qty: 0,
        priceUsd: 0,
        notionalUsd: 0,
        feeUsd: 0,
        slippageBps: 0,
        latencyMs: decidedAt - signal.observedAt,
        provisional: false,
      };
      await insertFill(this.db, fill);
      this.bus.emit("paper-fill", fill);
      // Deliberately not updating leader holdings: a candidate's side/token may be wrong, so it
      // must not feed the holding estimate that sizes real sells.
      return;
    }

    // Staleness veto: a backfilled trade stamps observedAt at processing time, so latency math
    // can't catch it. The block timestamp reveals the true age — skip copying long-dead trades
    // at the current price (correctness gate, distinct from the risk filters in decide()).
    if (isStaleSignal(signal, Date.now(), this.cfg.MAX_SIGNAL_AGE_SEC * 1000)) {
      const decidedAt = Date.now();
      const fill: PaperFill = {
        id: randomUUID(),
        signalId: signal.id,
        decidedAt,
        decision: "skipped",
        skipReason: "stale-signal",
        side: signal.side,
        token,
        quoteToken,
        qty: 0,
        priceUsd: 0,
        notionalUsd: 0,
        feeUsd: 0,
        slippageBps: 0,
        latencyMs: decidedAt - signal.observedAt,
        provisional: false,
      };
      await insertFill(this.db, fill);
      this.bus.emit("paper-fill", fill);
      this.rememberLeaderHolding(signal);
      return;
    }

    const [tokenRow, quoteTokenRow] = await Promise.all([
      getToken(this.db, token.chain, token.address),
      getToken(this.db, quoteToken.chain, quoteToken.address),
    ]);
    if (tokenRow?.isBlocked || quoteTokenRow?.isBlocked) {
      const decidedAt = Date.now();
      const fill: PaperFill = {
        id: randomUUID(),
        signalId: signal.id,
        decidedAt,
        decision: "skipped",
        skipReason: "token-blocklist",
        side: signal.side,
        token,
        quoteToken,
        qty: 0,
        priceUsd: 0,
        notionalUsd: 0,
        feeUsd: 0,
        slippageBps: 0,
        latencyMs: decidedAt - signal.observedAt,
        provisional: false,
      };
      await insertFill(this.db, fill);
      this.bus.emit("paper-fill", fill);
      this.rememberLeaderHolding(signal);
      return;
    }

    // Get liquidity (needed for decide)
    let liquidityUsd: number | null = null;
    try {
      liquidityUsd = await getLiquidityUsd(signal.chain, token.address, this.rpcClients[signal.chain]);
    } catch {
      // proceed with null — will skip with no-liquidity-data
    }

    const decision = this.decide(signal, liquidityUsd);
    const decidedAt = Date.now();
    const fillId = randomUUID();

    if (decision.action === "skip") {
      const fill: PaperFill = {
        id: fillId,
        signalId: signal.id,
        decidedAt,
        decision: "skipped",
        skipReason: decision.reason,
        side: signal.side,
        token,
        quoteToken,
        qty: 0,
        priceUsd: 0,
        notionalUsd: 0,
        feeUsd: 0,
        slippageBps: 0,
        latencyMs: decidedAt - signal.observedAt,
        provisional: false,
      };
      await insertFill(this.db, fill);
      this.bus.emit("paper-fill", fill);
      this.rememberLeaderHolding(signal);
      return;
    }

    // Get price
    let priceUsd = 0;
    try {
      priceUsd = (await getUsdPrice(signal.chain, token.address, this.rpcClients[signal.chain])) ?? 0;
    } catch {
      priceUsd = 0;
    }

    if (!priceUsd) {
      const skipFill: PaperFill = {
        id: fillId,
        signalId: signal.id,
        decidedAt,
        decision: "skipped",
        skipReason: "no-price-data",
        side: signal.side,
        token,
        quoteToken,
        qty: 0,
        priceUsd: 0,
        notionalUsd: 0,
        feeUsd: 0,
        slippageBps: 0,
        latencyMs: decidedAt - signal.observedAt,
        provisional: false,
      };
      await insertFill(this.db, skipFill);
      this.bus.emit("paper-fill", skipFill);
      this.rememberLeaderHolding(signal);
      return;
    }
    this.markPrices.set(markKey(signal.chain, token.address), priceUsd);

    // Slippage model
    const gasUsd = signal.chain === "eth" ? this.cfg.GAS_USD_ETH : this.cfg.GAS_USD_BASE;
    const delayPenaltyBps = signal.chain === "eth"
      ? this.cfg.COPY_DELAY_PENALTY_BPS_ETH
      : this.cfg.COPY_DELAY_PENALTY_BPS_BASE;
    const impactBps = Math.min(500, Math.round(10_000 * decision.notionalUsd / (2 * Math.max(liquidityUsd ?? 1, 1))));
    const slippageBps = DEX_FEE_BPS + impactBps + delayPenaltyBps;
    const feeUsd = gasUsd + (decision.notionalUsd * DEX_FEE_BPS) / 10_000;

    let fillPrice: number;
    let qty: number;
    let notionalUsd: number;
    let zeroxFeeUsd: number | null = null;

    // Snapshot pre-trade state so a provisional (mempool) fill can be reversed exactly on void/replace.
    const snapKey = posKey(signal.chain, token.address, signal.walletId);
    const provisional = signal.source === "mempool";
    const prevPortfolio: AccountingPortfolio = { ...this.portfolio };
    const prePos = this.positions.get(snapKey);
    const prevPosition: InMemoryPosition | null = prePos ? { ...prePos } : null;
    const signalLeaderHoldingKey = leaderHoldingKey(signal.chain, token.address, signal.walletId);
    const prevLeaderHolding = this.leaderHoldings.get(signalLeaderHoldingKey);

    if (signal.side === "buy") {
      const quoted = await this.quoteFillPriceWithZerox({
        side: "buy",
        token,
        quoteToken,
        notionalUsd: decision.notionalUsd,
        qty: null,
      });
      fillPrice = quoted?.priceUsd ?? priceUsd * (1 + slippageBps / 10_000);
      notionalUsd = quoted?.notionalUsd ?? decision.notionalUsd;
      zeroxFeeUsd = quoted?.dexFeeUsd ?? null;
      qty = fillPrice > 0 ? notionalUsd / fillPrice : 0;
      const effectiveFeeUsd = zeroxFeeUsd !== null ? gasUsd + zeroxFeeUsd : feeUsd;

      if (this.cashUsd < notionalUsd + effectiveFeeUsd) {
        const skipFill: PaperFill = {
          id: fillId,
          signalId: signal.id,
          decidedAt,
          decision: "skipped",
          skipReason: "insufficient-balance",
          side: signal.side,
          token,
          quoteToken,
          qty: 0,
          priceUsd: 0,
          notionalUsd: 0,
          feeUsd: 0,
          slippageBps: 0,
          latencyMs: decidedAt - signal.observedAt,
          provisional: false,
        };
        await insertFill(this.db, skipFill);
        this.bus.emit("paper-fill", skipFill);
        this.rememberLeaderHolding(signal);
        return;
      }

      // Update in-memory state
      const key = posKey(signal.chain, token.address, signal.walletId);
      const existing = this.positions.get(key);
      const existingAcct: AccountingPosition | null = existing
        ? { quantity: existing.qty, averageEntryUsd: existing.avgCostUsd, costBasisUsd: existing.qty * existing.avgCostUsd, realizedPnlUsd: existing.realizedPnlUsd, feesPaidUsd: 0 }
        : null;

      const next = applyTradeToState({
        portfolio: this.portfolio,
        position: existingAcct,
        trade: {
          side: "buy",
          quantity: qty,
          notionalUsd,
          gasUsd,
          slippageUsd: 0,
          dexFeeUsd: zeroxFeeUsd ?? (notionalUsd * DEX_FEE_BPS) / 10_000,
          totalCostUsd: notionalUsd + effectiveFeeUsd,
          sellProceedsUsd: 0,
        },
      });

      this.portfolio = next.portfolio;
      this.cashUsd = next.portfolio.cashUsd;
      this.positions.set(key, {
        qty: next.position.quantity,
        avgCostUsd: next.position.averageEntryUsd,
        realizedPnlUsd: next.position.realizedPnlUsd,
      });

      await upsertPosition(this.db, {
        chain: signal.chain,
        tokenAddress: token.address,
        qty: next.position.quantity,
        avgCostUsd: next.position.averageEntryUsd,
        realizedPnlUsd: next.position.realizedPnlUsd,
        sourceWalletId: signal.walletId,
      });
    } else {
      // Sell
      const key = posKey(signal.chain, token.address, signal.walletId);
      const existing = this.positions.get(key);
      if (!existing || existing.qty <= 0) {
        const skipFill: PaperFill = {
          id: fillId,
          signalId: signal.id,
          decidedAt,
          decision: "skipped",
          skipReason: "no-position",
          side: signal.side,
          token,
          quoteToken,
          qty: 0,
          priceUsd: 0,
          notionalUsd: 0,
          feeUsd: 0,
          slippageBps: 0,
          latencyMs: decidedAt - signal.observedAt,
          provisional: false,
        };
        await insertFill(this.db, skipFill);
        this.bus.emit("paper-fill", skipFill);
        this.rememberLeaderHolding(signal);
        return;
      }

      const posValue = existing.qty * existing.avgCostUsd;
      const fraction = Math.min(1, decision.notionalUsd / Math.max(posValue, 1e-10));
      qty = fraction * existing.qty;
      const quoted = await this.quoteFillPriceWithZerox({
        side: "sell",
        token,
        quoteToken,
        notionalUsd: decision.notionalUsd,
        qty,
      });
      fillPrice = quoted?.priceUsd ?? priceUsd * (1 - slippageBps / 10_000);
      zeroxFeeUsd = quoted?.dexFeeUsd ?? null;
      notionalUsd = qty * fillPrice;
      const effectiveFeeUsd = zeroxFeeUsd !== null ? gasUsd + zeroxFeeUsd : feeUsd;
      const sellProceeds = Math.max(0, notionalUsd - effectiveFeeUsd);

      const existingAcct: AccountingPosition = {
        quantity: existing.qty,
        averageEntryUsd: existing.avgCostUsd,
        costBasisUsd: existing.qty * existing.avgCostUsd,
        realizedPnlUsd: existing.realizedPnlUsd,
        feesPaidUsd: 0,
      };

      const next = applyTradeToState({
        portfolio: this.portfolio,
        position: existingAcct,
        trade: {
          side: "sell",
          quantity: qty,
          notionalUsd,
          gasUsd,
          slippageUsd: 0,
          dexFeeUsd: zeroxFeeUsd ?? (notionalUsd * DEX_FEE_BPS) / 10_000,
          totalCostUsd: effectiveFeeUsd,
          sellProceedsUsd: sellProceeds,
        },
      });

      this.portfolio = next.portfolio;
      this.cashUsd = next.portfolio.cashUsd;

      if (next.position.quantity < 1e-10) {
        this.positions.delete(key);
        // Stamp closedAt so the flat position doesn't reload as a zombie at boot.
        await closePositionByKey(this.db, {
          chain: signal.chain,
          tokenAddress: token.address,
          sourceWalletId: signal.walletId,
          realizedPnlUsd: next.position.realizedPnlUsd,
        });
      } else {
        this.positions.set(key, {
          qty: next.position.quantity,
          avgCostUsd: next.position.averageEntryUsd,
          realizedPnlUsd: next.position.realizedPnlUsd,
        });
        await upsertPosition(this.db, {
          chain: signal.chain,
          tokenAddress: token.address,
          qty: next.position.quantity,
          avgCostUsd: next.position.averageEntryUsd,
          realizedPnlUsd: next.position.realizedPnlUsd,
          sourceWalletId: signal.walletId,
        });
      }
    }

    const fill: PaperFill = {
      id: fillId,
      signalId: signal.id,
      decidedAt,
      decision: "copied",
      side: signal.side,
      token,
      quoteToken,
      qty,
      priceUsd: fillPrice,
      notionalUsd,
      feeUsd: zeroxFeeUsd !== null ? gasUsd + zeroxFeeUsd : feeUsd,
      slippageBps,
      latencyMs: decidedAt - signal.observedAt,
      provisional,
    };

    await insertFill(this.db, fill);

    if (provisional) {
      this.provisionals.set(signal.id, {
        fillId,
        signalId: signal.id,
        side: signal.side,
        posKey: snapKey,
        chain: signal.chain,
        tokenAddress: token.address,
        sourceWalletId: signal.walletId,
        qty,
        leaderHoldingKey: signalLeaderHoldingKey,
        prevLeaderHolding,
        cashDelta: this.portfolio.cashUsd - prevPortfolio.cashUsd,
        realizedPnlDelta: this.portfolio.realizedPnlUsd - prevPortfolio.realizedPnlUsd,
        feesDelta: this.portfolio.feesPaidUsd - prevPortfolio.feesPaidUsd,
        prevPosition,
      });
    }

    await this.takeSnapshot();
    this.bus.emit("paper-fill", fill);
    this.rememberLeaderHolding(signal);
    this.rememberSourceNotional(signal);
    logger.info({ fillId, side: signal.side, notionalUsd, priceUsd: fillPrice, provisional }, "paper fill");
  }

  private async quoteFillPriceWithZerox(input: {
    side: "buy" | "sell";
    token: TokenRef;
    quoteToken: TokenRef;
    notionalUsd: number;
    qty: number | null;
  }): Promise<{ priceUsd: number; notionalUsd: number; dexFeeUsd: number } | null> {
    if (!this.cfg.ZEROX_API_KEY) return null;

    try {
      if (input.side === "buy") {
        const quoteUsdPrice = await this.resolveQuoteUsdPrice(input.quoteToken);
        if (quoteUsdPrice <= 0) return null;
        const quoteAmount = input.notionalUsd / quoteUsdPrice;
        const quote = await getZeroxPrice({
          chainId: CHAIN_IDS[input.token.chain],
          sellToken: input.quoteToken.address,
          buyToken: input.token.address,
          sellAmount: toRawAmount(quoteAmount, input.quoteToken.decimals).toString(),
        });
        assertUsableZeroxQuote(quote, "buy");
        const tokenQty = rawToHumanNumber(BigInt(quote.buyAmount), input.token.decimals);
        const notionalUsd = rawToHumanNumber(BigInt(quote.sellAmount), input.quoteToken.decimals) * quoteUsdPrice;
        if (tokenQty <= 0 || notionalUsd <= 0) return null;
        return { priceUsd: notionalUsd / tokenQty, notionalUsd, dexFeeUsd: quote.dexFeeUsd };
      }

      if (input.qty === null || input.qty <= 0) return null;
      const quoteUsdPrice = await this.resolveQuoteUsdPrice(input.quoteToken);
      if (quoteUsdPrice <= 0) return null;
      const quote = await getZeroxPrice({
        chainId: CHAIN_IDS[input.token.chain],
        sellToken: input.token.address,
        buyToken: input.quoteToken.address,
        sellAmount: toRawAmount(input.qty, input.token.decimals).toString(),
      });
      assertUsableZeroxQuote(quote, "sell");
      const soldQty = rawToHumanNumber(BigInt(quote.sellAmount), input.token.decimals);
      const quoteQty = rawToHumanNumber(BigInt(quote.buyAmount), input.quoteToken.decimals);
      const notionalUsd = quoteQty * quoteUsdPrice;
      if (soldQty <= 0 || notionalUsd <= 0) return null;
      return { priceUsd: notionalUsd / soldQty, notionalUsd, dexFeeUsd: quote.dexFeeUsd };
    } catch (err) {
      logger.debug({ err, side: input.side, token: input.token.address, quoteToken: input.quoteToken.address }, "0x fill quote unavailable; falling back to spot pricing");
      return null;
    }
  }

  private async resolveQuoteUsdPrice(quoteToken: TokenRef): Promise<number> {
    const price = await getUsdPrice(quoteToken.chain, quoteToken.address, this.rpcClients[quoteToken.chain]);
    return price ?? 0;
  }

  async executeExitSell(
    pos: { chain: string; tokenAddress: string; qty: number; avgCostUsd: number; sourceWalletId: string | null },
    trigger: "tp" | "sl" | null,
    currentPriceUsd: number
  ): Promise<void> {
    if (pos.sourceWalletId === null) {
      logger.warn({ chain: pos.chain, tokenAddress: pos.tokenAddress, trigger }, "skipping exit for position without source wallet");
      return;
    }
    if ((pos.chain !== "eth" && pos.chain !== "base") || pos.qty <= 0 || currentPriceUsd <= 0) return;

    const chain = pos.chain;
    const token: TokenRef = { chain, address: pos.tokenAddress.toLowerCase(), symbol: "", decimals: 18 };
    const quoteToken = quoteTokenFor(chain);
    const now = Date.now();
    const qty = Math.min(pos.qty, this.positions.get(posKey(chain, pos.tokenAddress, pos.sourceWalletId))?.qty ?? pos.qty);
    if (qty <= 0) return;

    const signal: TradeSignal = {
      id: randomUUID(),
      chain,
      txHash: `exit:${trigger ?? "rule"}:${randomUUID()}`,
      source: "confirmed",
      side: "sell",
      tokenIn: token,
      tokenOut: quoteToken,
      amountIn: toRawAmount(qty, token.decimals),
      amountOut: toRawAmount(qty * currentPriceUsd, quoteToken.decimals),
      venue: `exit-${trigger ?? "rule"}`,
      observedAt: now,
      confirmedAt: now,
      blockNumber: null,
      walletId: pos.sourceWalletId,
      decodeStatus: "decoded",
    };
    await insertSignal(this.db, signal);

    const key = posKey(chain, pos.tokenAddress, pos.sourceWalletId);
    const existing = this.positions.get(key) ?? {
      qty: pos.qty,
      avgCostUsd: pos.avgCostUsd,
      realizedPnlUsd: 0,
    };

    const gasUsd = chain === "eth" ? this.cfg.GAS_USD_ETH : this.cfg.GAS_USD_BASE;
    const delayPenaltyBps = chain === "eth"
      ? this.cfg.COPY_DELAY_PENALTY_BPS_ETH
      : this.cfg.COPY_DELAY_PENALTY_BPS_BASE;
    let liquidityUsd: number | null = null;
    try {
      liquidityUsd = await getLiquidityUsd(chain, token.address, this.rpcClients[chain]);
    } catch {
      liquidityUsd = null;
    }
    const grossNotionalUsd = qty * currentPriceUsd;
    const impactBps = liquidityUsd !== null
      ? Math.min(500, Math.round(10_000 * grossNotionalUsd / (2 * Math.max(liquidityUsd, 1))))
      : 0;
    const dexFeeBps = 30;
    const slippageBps = dexFeeBps + impactBps + delayPenaltyBps;
    const fillPrice = currentPriceUsd * (1 - slippageBps / 10_000);
    this.markPrices.set(markKey(chain, token.address), currentPriceUsd);
    const notionalUsd = qty * fillPrice;
    const feeUsd = gasUsd + (notionalUsd * dexFeeBps) / 10_000;
    const sellProceeds = Math.max(0, notionalUsd - feeUsd);

    const next = applyTradeToState({
      portfolio: this.portfolio,
      position: {
        quantity: existing.qty,
        averageEntryUsd: existing.avgCostUsd,
        costBasisUsd: existing.qty * existing.avgCostUsd,
        realizedPnlUsd: existing.realizedPnlUsd,
        feesPaidUsd: 0,
      },
      trade: {
        side: "sell",
        quantity: qty,
        notionalUsd,
        gasUsd,
        slippageUsd: 0,
        dexFeeUsd: (notionalUsd * dexFeeBps) / 10_000,
        totalCostUsd: feeUsd,
        sellProceedsUsd: sellProceeds,
      },
    });

    this.portfolio = next.portfolio;
    this.cashUsd = next.portfolio.cashUsd;

    if (next.position.quantity < 1e-10) {
      this.positions.delete(key);
      await closePositionByKey(this.db, {
        chain,
        tokenAddress: token.address,
        sourceWalletId: pos.sourceWalletId,
        realizedPnlUsd: next.position.realizedPnlUsd,
      });
    } else {
      this.positions.set(key, {
        qty: next.position.quantity,
        avgCostUsd: next.position.averageEntryUsd,
        realizedPnlUsd: next.position.realizedPnlUsd,
      });
      await upsertPosition(this.db, {
        chain,
        tokenAddress: token.address,
        qty: next.position.quantity,
        avgCostUsd: next.position.averageEntryUsd,
        realizedPnlUsd: next.position.realizedPnlUsd,
        sourceWalletId: pos.sourceWalletId,
      });
    }

    const fill: PaperFill = {
      id: randomUUID(),
      signalId: signal.id,
      decidedAt: now,
      decision: "copied",
      side: "sell",
      token,
      quoteToken,
      qty,
      priceUsd: fillPrice,
      notionalUsd,
      feeUsd,
      slippageBps,
      latencyMs: 0,
      provisional: false,
    };
    await insertFill(this.db, fill);
    await this.takeSnapshot();
    this.bus.emit("paper-fill", fill);
    logger.info({ fillId: fill.id, trigger, notionalUsd, priceUsd: fillPrice }, "exit paper fill");
  }

  private async handleConfirmed(signalId: string, confirmed: TradeSignal): Promise<void> {
    await upsertSignal(this.db, confirmed);

    const prov = this.provisionals.get(signalId);
    if (!prov) return;

    // Recompute price at confirmation time
    const token: TokenRef = confirmed.side === "buy" ? confirmed.tokenOut : confirmed.tokenIn;
    let newPrice = 0;
    try {
      newPrice = (await getUsdPrice(confirmed.chain, token.address, this.rpcClients[confirmed.chain])) ?? 0;
    } catch { /* keep 0 */ }

    // Re-price failed — keep the provisional fill at its mempool estimate rather than
    // zeroing a real fill. Just clear the provisional flag.
    if (newPrice <= 0) {
      await updateFill(this.db, prov.fillId, { provisional: false });
      this.provisionals.delete(signalId);
      logger.warn({ signalId }, "confirmed re-price unavailable — keeping mempool estimate");
      return;
    }
    this.markPrices.set(markKey(confirmed.chain, token.address), newPrice);

    // Update the recorded fill to the confirmed price (qty fixed). Cash/position were already
    // committed at the estimate; mempool→confirm is seconds apart, so we don't retroactively
    // rewrite the ledger (other trades may have touched the position in between).
    await updateFill(this.db, prov.fillId, {
      priceUsd: newPrice,
      notionalUsd: prov.qty * newPrice,
      provisional: false,
    });

    this.provisionals.delete(signalId);
    logger.debug({ signalId, newPrice }, "provisional fill confirmed");
  }

  private async handleVoided(signalId: string, reason: "reverted" | "replaced"): Promise<void> {
    const prov = this.provisionals.get(signalId);
    if (!prov) return;

    // Reverse only this trade's portfolio deltas so fills processed concurrently between the
    // provisional and the void keep their cash/realizedPnl/fee effects.
    this.portfolio = {
      cashUsd: this.portfolio.cashUsd - prov.cashDelta,
      realizedPnlUsd: this.portfolio.realizedPnlUsd - prov.realizedPnlDelta,
      feesPaidUsd: this.portfolio.feesPaidUsd - prov.feesDelta,
    };
    this.cashUsd = this.portfolio.cashUsd;

    if (prov.prevPosition) {
      this.positions.set(prov.posKey, { ...prov.prevPosition });
      await upsertPosition(this.db, {
        chain: prov.chain,
        tokenAddress: prov.tokenAddress,
        qty: prov.prevPosition.qty,
        avgCostUsd: prov.prevPosition.avgCostUsd,
        realizedPnlUsd: prov.prevPosition.realizedPnlUsd,
        sourceWalletId: prov.sourceWalletId,
      });
    } else {
      // No position existed before the provisional fill — close the row it created.
      this.positions.delete(prov.posKey);
      await closePositionByKey(this.db, {
        chain: prov.chain,
        tokenAddress: prov.tokenAddress,
        sourceWalletId: prov.sourceWalletId,
        realizedPnlUsd: 0,
      });
    }

    if (prov.prevLeaderHolding === undefined) {
      this.leaderHoldings.delete(prov.leaderHoldingKey);
    } else {
      this.leaderHoldings.set(prov.leaderHoldingKey, prov.prevLeaderHolding);
    }

    await voidFill(this.db, prov.fillId);
    this.provisionals.delete(signalId);
    logger.info({ signalId, reason }, "provisional fill voided");
  }

  private async takeSnapshot(): Promise<void> {
    let posValue = 0;
    for (const [key, pos] of this.positions) {
      posValue += this.positionValueUsd(key, pos);
    }
    const equityUsd = this.cashUsd + posValue;
    const recentSnapshots = await getRecentSnapshots(this.db, 288);
    const dayAgo = Date.now() - 24 * 60 * 60_000;
    const baseline = recentSnapshots.find((snap) => snap.ts.getTime() >= dayAgo) ?? recentSnapshots[0] ?? null;

    await insertSnapshot(this.db, {
      ts: new Date(),
      equityUsd,
      cashUsd: this.cashUsd,
      positionsValueUsd: posValue,
      dailyPnlUsd: baseline ? equityUsd - baseline.equityUsd : 0,
    });
  }

  getCashUsd(): number {
    return this.cashUsd;
  }

  getPositions(): Map<string, InMemoryPosition> {
    return new Map(this.positions);
  }

  getRealizedPnlUsd(): number {
    return this.portfolio.realizedPnlUsd;
  }
}

/**
 * A confirmed signal is stale when its block timestamp is older than maxAgeMs. Mempool and
 * test signals without a block timestamp are never stale (they're live by construction).
 */
export function isStaleSignal(
  signal: Pick<TradeSignal, "blockTimestamp">,
  nowMs: number,
  maxAgeMs: number
): boolean {
  const ts = signal.blockTimestamp;
  if (ts === undefined || ts === null) return false;
  return nowMs - ts > maxAgeMs;
}

function posKey(chain: ChainId, tokenAddress: string, walletId: string | null): string {
  return `${chain}:${tokenAddress.toLowerCase()}:${walletId ?? ""}`;
}

function markKey(chain: ChainId, tokenAddress: string): string {
  return `${chain}:${tokenAddress.toLowerCase()}`;
}

function leaderHoldingKey(chain: ChainId, tokenAddress: string, walletId: string): string {
  return `${chain}:${tokenAddress.toLowerCase()}:${walletId}`;
}

function numberSetting(settings: Record<string, unknown>, keys: string[], fallback: number): number {
  for (const key of keys) {
    const value = settings[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
    if (typeof value === "string") {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
  }
  return fallback;
}

function sizingModeSetting(settings: Record<string, unknown>, keys: string[], fallback: Config["SIZING_MODE"]): Config["SIZING_MODE"] {
  for (const key of keys) {
    const value = settings[key];
    if (value === "fixed" || value === "proportional") return value;
  }
  return fallback;
}

function rawToHumanNumber(amount: bigint, decimals: number): number {
  return Number(amount) / 10 ** decimals;
}

function medianNumber(values: number[]): number | null {
  const sorted = values.filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? null;
  const left = sorted[mid - 1];
  const right = sorted[mid];
  return left !== undefined && right !== undefined ? (left + right) / 2 : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function classifyLiquidityTier(liquidityUsd: number | null): LiquidityTier {
  if (liquidityUsd === null) return "longtail";
  if (liquidityUsd >= 5_000_000) return "major";
  if (liquidityUsd >= 500_000) return "mid";
  return "longtail";
}

function quoteTokenFor(chain: ChainId): TokenRef {
  return chain === "eth"
    ? { chain, address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", symbol: "USDC", decimals: 6 }
    : { chain, address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", symbol: "USDC", decimals: 6 };
}

function toRawAmount(amount: number, decimals: number): bigint {
  if (!Number.isFinite(amount) || amount <= 0) return 0n;
  return BigInt(Math.max(0, Math.floor(amount * 10 ** decimals)));
}
