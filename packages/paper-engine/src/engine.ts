import { randomUUID } from "crypto";
import PQueue from "p-queue";
import { CHAIN_IDS, WETH, isEvmChain } from "@tradebot/core";
import type { ChainId, EvmChainId, TradeSignal, PaperFill, TokenRef } from "@tradebot/core";
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
  getAllWallets,
  latestMark,
  getV4MarketHintForToken,
} from "@tradebot/store";
import {
  assertUsableZeroxQuote,
  getLiquidityUsd,
  getLiquidityUsdResult,
  getPolymarketMarketStatus,
  getPolymarketPrice,
  getPolymarketResolutionPayout,
  getUsdPrice,
  getUsdPriceResult,
  getZeroxPrice,
} from "@tradebot/pricing";
import type { PriceResult, MarketHint } from "@tradebot/pricing";
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

type RuntimeConfig = Pick<Config, "BASE_TRADE_PCT" | "MAX_TRADE_PCT" | "MIN_NOTIONAL_USD" | "MIN_LIQUIDITY_USD" | "SIZING_MODE" | "ALLOW_FALLBACK_PRICE_BUYS" | "MAX_SPOT_TWAP_DIVERGENCE_BPS">;

const RECENT_NOTIONAL_WINDOW = 20;
const DEX_FEE_BPS = 30;
// Rate limit for the "resolved but indeterminate payout" warning so a stranded Polymarket position
// surfaces without spamming the log on every 60s resolution sweep.
const RESOLUTION_STRAND_WARN_INTERVAL_MS = 6 * 60 * 60_000;

type ZeroxFillQuote =
  | { status: "quoted"; priceUsd: number; notionalUsd: number; dexFeeUsd: number }
  | { status: "unavailable"; hardVetoReason?: "no-executable-route" };

export class PaperEngine {
  private cashUsd: number;
  private positions = new Map<string, InMemoryPosition>();
  private provisionals = new Map<string, ProvisionalEntry>();
  private portfolio: AccountingPortfolio;
  // All engine state mutations run on this queue — both the bus-driven handlers and the
  // externally-invoked entry points (Polymarket copy/settlement, exit sells), which route here via
  // runOnQueue() so nothing mutates portfolio/positions outside this scheduler. INVARIANT: because the
  // queue runs at concurrency 4, two tasks can interleave at their `await` points, so the
  // read-modify-write-then-persist of `portfolio`/`positions` inside each task MUST stay synchronous
  // (no `await` between reading cash/position and writing it back). Introducing an await there — or
  // making applyTradeToState async — would create a cross-task TOCTOU. commitFillAtomic preserves this
  // by computing the next state purely, persisting, then mutating memory after the commit resolves.
  private queue: PQueue;
  // Per-condition timestamp of the last "resolved but indeterminate payout" warning, to rate-limit it.
  private readonly resolutionStrandWarnedAt = new Map<string, number>();
  private snapshotTimer: ReturnType<typeof setInterval> | null = null;
  private settingsTimer: ReturnType<typeof setInterval> | null = null;
  private runtimeConfig: RuntimeConfig;
  private readonly recentSourceNotionals = new Map<string, number[]>();
  private readonly leaderHoldings = new Map<string, number>();
  // Wallet IDs with auto-copy disabled: still watched and scored, but the engine opens no new
  // positions from their signals. Refreshed on the settings timer.
  private autoCopyDisabled = new Set<string>();
  private readonly markPrices = new Map<string, number>();
  private readonly nativeUsd: Record<EvmChainId, number> = { eth: 0, base: 0 };

  private readonly rpcClients: Record<EvmChainId, RpcClient>;

  constructor(
    private readonly db: Db,
    private readonly bus: EventBus,
    private readonly cfg: Config,
    rpcClients: RpcClient | Record<EvmChainId, RpcClient>,
    private readonly weights: WeightProvider = constantWeights,
  ) {
    // Accept either a single client (legacy/tests) or a per-chain map.
    this.rpcClients =
      "eth" in rpcClients && "base" in rpcClients
        ? (rpcClients as Record<EvmChainId, RpcClient>)
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
      ALLOW_FALLBACK_PRICE_BUYS: cfg.ALLOW_FALLBACK_PRICE_BUYS,
      MAX_SPOT_TWAP_DIVERGENCE_BPS: cfg.MAX_SPOT_TWAP_DIVERGENCE_BPS,
    };
  }

  /**
   * Narrow a signal/position chain to an EVM chain before touching the AMM pricing/RPC maps. The
   * engine only ever processes EVM trades — the decoder emits EVM-only signals and the candidate
   * copy path is guarded against non-EVM chains in the API — so reaching here with a non-EVM chain
   * is a programming error; throwing (caught by the queue) is safer than indexing with undefined.
   */
  private evm(chain: ChainId): EvmChainId {
    if (isEvmChain(chain)) return chain;
    throw new Error(`paper engine received unsupported non-EVM chain: ${chain}`);
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

  /**
   * Run state-mutating work on the shared queue and await its result. Used by externally-invoked
   * entry points (the runner's Polymarket/exit jobs) so their state mutations are serialized through
   * the same scheduler as the bus handlers rather than bypassing it. Errors propagate to the caller
   * (the job's own try/catch logs them with context), unlike fire-and-forget enqueue().
   */
  private runOnQueue<T>(work: () => Promise<T>): Promise<T> {
    return this.queue.add(work) as Promise<T>;
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
      ALLOW_FALLBACK_PRICE_BUYS: booleanSetting(settings, ["ALLOW_FALLBACK_PRICE_BUYS", "allow_fallback_price_buys"], this.cfg.ALLOW_FALLBACK_PRICE_BUYS),
      MAX_SPOT_TWAP_DIVERGENCE_BPS: numberSetting(settings, ["MAX_SPOT_TWAP_DIVERGENCE_BPS", "max_spot_twap_divergence_bps"], this.cfg.MAX_SPOT_TWAP_DIVERGENCE_BPS),
    };
    await this.refreshAutoCopyDisabled();
    await this.refreshNativePrices();
  }

  /** Cache the set of wallets whose auto-copy is off so buys can be vetoed without a per-signal query. */
  private async refreshAutoCopyDisabled(): Promise<void> {
    try {
      const wallets = await getAllWallets(this.db);
      this.autoCopyDisabled = new Set(wallets.filter((w) => !w.autoCopy).map((w) => w.id));
    } catch (err) {
      logger.warn({ err }, "failed to refresh auto-copy-disabled wallets; keeping previous set");
    }
  }

  /** Cache the native (WETH) USD price per chain so proportional sizing can value ETH-quoted trades. */
  private async refreshNativePrices(): Promise<void> {
    for (const chain of ["eth", "base"] as EvmChainId[]) {
      try {
        const price = await getUsdPrice(chain, WETH[chain], this.rpcClients[chain]);
        if (price && price > 0) this.nativeUsd[chain] = price;
      } catch {
        // keep last known native price
      }
    }
  }

  decide(signal: TradeSignal, liquidityUsd: number | null): { action: "copy"; notionalUsd: number } | { action: "skip"; reason: string } {
    if (this.weights.getWeight(signal.walletId) === 0) return { action: "skip", reason: "leader-weight-zero" };

    const veto = this.liquidityVeto(signal, liquidityUsd);
    if (veto) return { action: "skip", reason: veto };

    if (signal.side === "buy") return this.sizeBuy(signal);

    // Sell
    const token = signal.side === "sell" ? signal.tokenIn : signal.tokenOut;
    const key = posKey(signal.chain, token.address, signal.walletId);
    const pos = this.positions.get(key);
    if (!pos || pos.qty <= 0) return { action: "skip", reason: "no-position" };

    const fraction = this.estimateLeaderSellFraction(signal);
    const sellQty = fraction * pos.qty;

    return { action: "copy", notionalUsd: sellQty * pos.avgCostUsd };
  }

  /**
   * Liquidity-dependent risk gate, pulled out of decide() so the mempool fast path can defer it to
   * the confirm step. Returns a skip reason or null. Weight is checked separately by the caller.
   */
  private liquidityVeto(signal: TradeSignal, liquidityUsd: number | null): string | null {
    if (liquidityUsd === null) return "no-liquidity-data";
    const mutedTiers = this.weights.getMutedLiquidityTiers?.(signal.walletId);
    if (mutedTiers?.has(classifyLiquidityTier(liquidityUsd))) return "leader-tier-muted";
    if (liquidityUsd < this.runtimeConfig.MIN_LIQUIDITY_USD) return "below-min-liquidity";
    return null;
  }

  /**
   * Pure buy sizing — equity × BASE_TRADE_PCT × weight, proportional scaling, MIN/MAX clamps, and
   * the cash cap — with no liquidity dependency. Shared by decide() (confirmed buys) and the mempool
   * fast path (handleProvisionalBuy), which sizes before any token-side discovery.
   */
  private sizeBuy(signal: TradeSignal): { action: "copy"; notionalUsd: number } | { action: "skip"; reason: string } {
    const weight = this.weights.getWeight(signal.walletId);
    if (weight === 0) return { action: "skip", reason: "leader-weight-zero" };

    const eq = this.equity();
    let notional = eq * this.runtimeConfig.BASE_TRADE_PCT * weight;
    if (this.runtimeConfig.SIZING_MODE === "proportional") {
      notional *= this.proportionalScale(signal);
    }
    notional = Math.max(notional, this.runtimeConfig.MIN_NOTIONAL_USD);
    notional = Math.min(notional, eq * this.runtimeConfig.MAX_TRADE_PCT);
    notional = Math.min(notional, this.cashUsd);
    if (notional < this.runtimeConfig.MIN_NOTIONAL_USD) {
      return {
        action: "skip",
        reason: this.cashUsd < this.runtimeConfig.MIN_NOTIONAL_USD ? "insufficient-balance" : "below-min-notional",
      };
    }
    return { action: "copy", notionalUsd: notional };
  }

  private estimateSignalSourceNotionalUsd(signal: TradeSignal): number | null {
    if (signal.chain === "polygon") {
      const usdcLeg = signal.side === "buy" ? signal.amountIn : signal.amountOut;
      const decimals = signal.side === "buy" ? signal.tokenIn.decimals : signal.tokenOut.decimals;
      const notional = rawToHumanNumber(usdcLeg, decimals);
      return Number.isFinite(notional) && notional > 0 ? notional : null;
    }
    const candidate: SizingCandidate = {
      side: signal.side,
      tokenInSymbol: signal.tokenIn.symbol,
      tokenInAddress: signal.tokenIn.address,
      tokenInAmountHuman: rawToHumanNumber(signal.amountIn, signal.tokenIn.decimals),
      tokenOutSymbol: signal.tokenOut.symbol,
      tokenOutAddress: signal.tokenOut.address,
      tokenOutAmountHuman: rawToHumanNumber(signal.amountOut, signal.tokenOut.decimals),
    };
    const notional = estimateSourceNotionalUsd(candidate, this.nativeUsd[this.evm(signal.chain)] ?? 0);
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

  /**
   * Record a skipped decision: insert + emit a zero-quantity skip fill and (by default) update the
   * leader-holding estimate. Factored out of handleSignal's many skip branches. Pass
   * rememberHolding:false for low-confidence candidates whose side/token may be wrong.
   */
  private async recordSkip(
    signal: TradeSignal,
    reason: string,
    token: TokenRef,
    quoteToken: TokenRef,
    opts: { rememberHolding?: boolean } = {},
  ): Promise<void> {
    const decidedAt = Date.now();
    const fill: PaperFill = {
      id: randomUUID(),
      signalId: signal.id,
      decidedAt,
      decision: "skipped",
      skipReason: reason,
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
    if (opts.rememberHolding !== false) this.rememberLeaderHolding(signal);
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
    // guess would spend paper money on the decoder's uncertainty. Deliberately not updating leader
    // holdings: a candidate's side/token may be wrong, so it must not feed the holding estimate.
    if (signal.decodeStatus === "candidate") {
      return this.recordSkip(signal, "low-confidence-decode", token, quoteToken, { rememberHolding: false });
    }

    // Staleness veto: a backfilled trade stamps observedAt at processing time, so latency math
    // can't catch it. The block timestamp reveals the true age — skip copying long-dead trades
    // at the current price (correctness gate, distinct from the risk filters in decide()).
    // Polygon (Polymarket) uses a looser budget: its data-api indexes trades with a multi-minute
    // lag, so even a freshly-served trade is already older than the EVM 180s gate would allow.
    const maxAgeSec = signal.chain === "polygon"
      ? this.cfg.POLYMARKET_MAX_SIGNAL_AGE_SEC
      : this.cfg.MAX_SIGNAL_AGE_SEC;
    if (isStaleSignal(signal, Date.now(), maxAgeSec * 1000)) {
      return this.recordSkip(signal, "stale-signal", token, quoteToken);
    }

    const [tokenRow, quoteTokenRow] = await Promise.all([
      getToken(this.db, token.chain, token.address),
      getToken(this.db, quoteToken.chain, quoteToken.address),
    ]);
    if (tokenRow?.isBlocked || quoteTokenRow?.isBlocked) {
      return this.recordSkip(signal, "token-blocklist", token, quoteToken);
    }

    // Auto-copy veto: a wallet with auto-copy off is still watched and scored, but the engine opens
    // no new positions from it. Sells still flow through so existing positions can be exited, and a
    // manual candidate copy (reviewStatus 'copying') is an explicit human approval that bypasses this.
    if (signal.side === "buy" && signal.reviewStatus !== "copying" && this.autoCopyDisabled.has(signal.walletId)) {
      return this.recordSkip(signal, "auto-copy-off", token, quoteToken);
    }

    if (signal.chain === "polygon") {
      return this.handlePolymarketSignal(signal, token, quoteToken);
    }

    // Mempool fast path: a copy-trader's edge is acting on the pre-block signal. Commit a provisional
    // buy at the leader's implied price (cheap quote→USD only) and defer the expensive liquidity/price
    // discovery + risk vetoes to handleConfirmed, which can void. Sells and confirmed buys keep the
    // heavyweight path below.
    if (signal.source === "mempool" && signal.side === "buy") {
      return this.handleProvisionalBuy(signal, token, quoteToken);
    }

    // Get liquidity (needed for decide). A V4 swap carries a poolId hint so a V4-only token can be
    // measured via StateView instead of skipping with no-liquidity-data.
    const marketHint = v4MarketHint(signal);
    let liquidityUsd: number | null = null;
    let liquidityWarnings: string[] = [];
    try {
      const liquidity = await getLiquidityUsdResult(this.evm(signal.chain), token.address, this.rpcClients[this.evm(signal.chain)], marketHint);
      liquidityUsd = liquidity?.liquidityUsd ?? null;
      liquidityWarnings = liquidity?.warnings ?? [];
    } catch {
      // proceed with null — will skip with no-liquidity-data
    }

    const decision = this.decide(signal, liquidityUsd);
    const decidedAt = Date.now();
    const fillId = randomUUID();

    if (decision.action === "skip") {
      return this.recordSkip(signal, decision.reason, token, quoteToken);
    }

    // Get price
    let price: PriceResult | null = null;
    try {
      price = await getUsdPriceResult(this.evm(signal.chain), token.address, this.rpcClients[this.evm(signal.chain)], marketHint);
    } catch {
      price = null;
    }
    const priceUsd = price?.priceUsd ?? 0;

    if (!priceUsd) {
      return this.recordSkip(signal, "no-price-data", token, quoteToken);
    }

    if (signal.side === "buy" && price?.source === "defillama" && !this.runtimeConfig.ALLOW_FALLBACK_PRICE_BUYS) {
      return this.recordSkip(signal, "fallback-price-source", token, quoteToken);
    }

    if (
      signal.side === "buy" &&
      price?.spotTwapDivergenceBps !== undefined &&
      price.spotTwapDivergenceBps > this.runtimeConfig.MAX_SPOT_TWAP_DIVERGENCE_BPS
    ) {
      return this.recordSkip(signal, "spot-twap-divergence", token, quoteToken);
    }
    this.markPrices.set(markKey(signal.chain, token.address), priceUsd);
    logger.debug(
      {
        chain: signal.chain,
        tokenAddress: token.address,
        priceSource: price?.source,
        priceVenue: price?.venue,
        pricePool: price?.poolAddress,
        priceWarnings: price?.warnings ?? [],
        liquidityUsd,
        liquidityWarnings,
      },
      "price and liquidity selected for paper fill"
    );

    // Slippage + fee model (shared with exit sells via modeledSlippageBps).
    const gasUsd = signal.chain === "eth" ? this.cfg.GAS_USD_ETH : this.cfg.GAS_USD_BASE;
    const slippageBps = this.modeledSlippageBps(signal.chain, decision.notionalUsd, liquidityUsd);
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
      if (quoted.status === "unavailable" && quoted.hardVetoReason) {
        return this.recordSkip(signal, quoted.hardVetoReason, token, quoteToken);
      }
      fillPrice = quoted.status === "quoted" ? quoted.priceUsd : priceUsd * (1 + slippageBps / 10_000);
      notionalUsd = quoted.status === "quoted" ? quoted.notionalUsd : decision.notionalUsd;
      zeroxFeeUsd = quoted.status === "quoted" ? quoted.dexFeeUsd : null;
      qty = fillPrice > 0 ? notionalUsd / fillPrice : 0;
      const effectiveFeeUsd = zeroxFeeUsd !== null ? gasUsd + zeroxFeeUsd : feeUsd;

      if (this.cashUsd < notionalUsd + effectiveFeeUsd) {
        return this.recordSkip(signal, "insufficient-balance", token, quoteToken);
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
        return this.recordSkip(signal, "no-position", token, quoteToken);
      }

      const posValue = existing.qty * existing.avgCostUsd;
      const fraction = Math.min(1, decision.notionalUsd / Math.max(posValue, 1e-10));
      qty = fraction * existing.qty;
      const priced = await this.priceSellFill({ token, quoteToken, qty, fallbackPriceUsd: priceUsd, slippageBps });
      fillPrice = priced.fillPrice;
      zeroxFeeUsd = priced.dexFeeUsd;
      notionalUsd = qty * fillPrice;
      const dexFeeUsd = zeroxFeeUsd ?? (notionalUsd * DEX_FEE_BPS) / 10_000;
      const effectiveFeeUsd = zeroxFeeUsd !== null ? gasUsd + zeroxFeeUsd : feeUsd;

      await this.applySellToState({
        chain: signal.chain,
        tokenAddress: token.address,
        walletId: signal.walletId,
        posKey: key,
        existing,
        qty,
        notionalUsd,
        gasUsd,
        dexFeeUsd,
        effectiveFeeUsd,
      });
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
      ...(price?.source !== undefined ? { priceSource: price.source } : {}),
      ...(price?.venue !== undefined ? { priceVenue: price.venue } : {}),
      ...(price?.poolAddress !== undefined ? { pricePoolAddress: price.poolAddress } : {}),
      ...(liquidityUsd !== null ? { liquidityUsd } : {}),
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

  private decidePolymarket(signal: TradeSignal): { action: "copy"; notionalUsd: number } | { action: "skip"; reason: string } {
    if (this.weights.getWeight(signal.walletId) === 0) return { action: "skip", reason: "leader-weight-zero" };

    if (signal.side === "buy") return this.sizeBuy(signal);

    const token = signal.tokenIn;
    const key = posKey(signal.chain, token.address, signal.walletId);
    const pos = this.positions.get(key);
    if (!pos || pos.qty <= 0) return { action: "skip", reason: "no-position" };

    const fraction = this.estimateLeaderSellFraction(signal);
    const sellQty = fraction * pos.qty;
    return { action: "copy", notionalUsd: sellQty * pos.avgCostUsd };
  }

  private async handlePolymarketSignal(signal: TradeSignal, token: TokenRef, quoteToken: TokenRef): Promise<void> {
    const decision = this.decidePolymarket(signal);
    if (decision.action === "skip") {
      return this.recordSkip(signal, decision.reason, token, quoteToken);
    }

    const [quote, marketStatus] = await Promise.all([
      getPolymarketPrice(token.address, signal.side),
      signal.side === "buy" && signal.conditionId ? getPolymarketMarketStatus(signal.conditionId) : Promise.resolve(null),
    ]);

    if (signal.side === "buy" && marketStatus?.resolved) {
      return this.recordSkip(signal, "market-resolved", token, quoteToken);
    }
    if (signal.side === "buy" && (marketStatus?.closed || marketStatus?.active === false || marketStatus?.acceptingOrders === false)) {
      return this.recordSkip(signal, "market-closed", token, quoteToken);
    }
    if (!quote || quote.price <= 0) {
      return this.recordSkip(signal, "no-price-data", token, quoteToken);
    }
    if (signal.side === "buy" && quote.spreadBps !== null && quote.spreadBps > quote.maxSpreadBps) {
      return this.recordSkip(signal, "max-spread", token, quoteToken);
    }

    const decidedAt = Date.now();
    const fillId = randomUUID();
    // Recorded for visibility only: the fill executes at the raw best ask (buy) / bid (sell), which
    // already embeds the spread, so we do NOT additionally move `priceUsd` by this amount. It is the
    // observed bid/ask spread at decision time, not a slippage adjustment applied to the price.
    const slippageBps = quote.spreadBps !== null ? Math.max(0, Math.round(quote.spreadBps)) : 0;
    const key = posKey(signal.chain, token.address, signal.walletId);
    let qty: number;
    let notionalUsd: number;
    let next: ReturnType<typeof applyTradeToState>;

    if (signal.side === "buy") {
      notionalUsd = decision.notionalUsd;
      qty = notionalUsd / quote.price;
      if (!Number.isFinite(qty) || qty <= 0) {
        return this.recordSkip(signal, "no-price-data", token, quoteToken);
      }
      if (this.cashUsd < notionalUsd) {
        return this.recordSkip(signal, "insufficient-balance", token, quoteToken);
      }

      const existing = this.positions.get(key);
      const existingAcct: AccountingPosition | null = existing
        ? {
            quantity: existing.qty,
            averageEntryUsd: existing.avgCostUsd,
            costBasisUsd: existing.qty * existing.avgCostUsd,
            realizedPnlUsd: existing.realizedPnlUsd,
            feesPaidUsd: 0,
          }
        : null;

      next = applyTradeToState({
        portfolio: this.portfolio,
        position: existingAcct,
        trade: {
          side: "buy",
          quantity: qty,
          notionalUsd,
          gasUsd: 0,
          slippageUsd: 0,
          dexFeeUsd: 0,
          totalCostUsd: notionalUsd,
          sellProceedsUsd: 0,
        },
      });
    } else {
      const existing = this.positions.get(key);
      if (!existing || existing.qty <= 0) {
        return this.recordSkip(signal, "no-position", token, quoteToken);
      }

      const posValue = existing.qty * existing.avgCostUsd;
      const fraction = Math.min(1, decision.notionalUsd / Math.max(posValue, 1e-10));
      qty = fraction * existing.qty;
      notionalUsd = qty * quote.price;
      next = applyTradeToState({
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
          gasUsd: 0,
          slippageUsd: 0,
          dexFeeUsd: 0,
          totalCostUsd: 0,
          sellProceedsUsd: notionalUsd,
        },
      });
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
      priceUsd: quote.price,
      notionalUsd,
      feeUsd: 0,
      slippageBps,
      latencyMs: decidedAt - signal.observedAt,
      provisional: false,
      priceSource: quote.source,
      priceVenue: "polymarket",
    };

    // The Polygon auto-copy job re-claims any confirmed signal that lacks a fill row, so a position
    // write that committed without its fill would be re-processed and double-applied. Persist the
    // position delta and the fill in one transaction and apply the in-memory mutation only after the
    // commit succeeds — a thrown commit then leaves both the DB and memory untouched, so the re-claim
    // retries cleanly instead of double-spending paper cash.
    await this.commitFillAtomic({
      next,
      posKey: key,
      chain: signal.chain,
      tokenAddress: token.address,
      walletId: signal.walletId,
      fill,
    });
    await this.takeSnapshot();
    this.bus.emit("paper-fill", fill);
    this.rememberLeaderHolding(signal);
    this.rememberSourceNotional(signal);
    logger.info({ fillId, chain: signal.chain, side: signal.side, notionalUsd, priceUsd: quote.price }, "polymarket paper fill");
  }

  /**
   * Mempool fast path for buys: commit a provisional fill at the leader's *implied* price with zero
   * token-side discovery — no findBestMarket fan-out, no spot price read, no 0x quote. The liquidity
   * and price-quality vetoes are deferred to handleConfirmed (which can void). This cuts the
   * mempool→provisional-fill latency to ~one cheap quote-price lookup.
   */
  private async handleProvisionalBuy(signal: TradeSignal, token: TokenRef, quoteToken: TokenRef): Promise<void> {
    const sized = this.sizeBuy(signal);
    if (sized.action === "skip") return this.recordSkip(signal, sized.reason, token, quoteToken);

    // Leader's implied token price from mempool calldata, valued via the cheap quote side only
    // (Chainlink ETH/USD or ≈$1 for USDC). amountOut is the leader's amountOutMin (slippage floor),
    // so impliedPrice is biased slightly high → qty slightly low (conservative). handleConfirmed
    // re-prices but keeps qty fixed (it does not rewrite the ledger), so the small bias persists.
    const quoteUsd = await this.resolveQuoteUsdPrice(quoteToken);
    const amountInH = rawToHumanNumber(signal.amountIn, signal.tokenIn.decimals);
    const amountOutH = rawToHumanNumber(signal.amountOut, signal.tokenOut.decimals);
    const impliedPriceUsd = quoteUsd > 0 && amountOutH > 0 ? (amountInH * quoteUsd) / amountOutH : 0;
    if (impliedPriceUsd <= 0) return this.recordSkip(signal, "no-price-data", token, quoteToken);

    const notionalUsd = sized.notionalUsd;
    const gasUsd = signal.chain === "eth" ? this.cfg.GAS_USD_ETH : this.cfg.GAS_USD_BASE;
    const dexFeeUsd = (notionalUsd * DEX_FEE_BPS) / 10_000;
    const feeUsd = gasUsd + dexFeeUsd;
    if (this.cashUsd < notionalUsd + feeUsd) return this.recordSkip(signal, "insufficient-balance", token, quoteToken);

    const fillPrice = impliedPriceUsd;
    const qty = notionalUsd / fillPrice;
    const fillId = randomUUID();
    const decidedAt = Date.now();

    // Snapshot pre-trade state so void/replace/confirm-veto can reverse exactly.
    const snapKey = posKey(signal.chain, token.address, signal.walletId);
    const prevPortfolio: AccountingPortfolio = { ...this.portfolio };
    const prePos = this.positions.get(snapKey);
    const prevPosition: InMemoryPosition | null = prePos ? { ...prePos } : null;
    const signalLeaderHoldingKey = leaderHoldingKey(signal.chain, token.address, signal.walletId);
    const prevLeaderHolding = this.leaderHoldings.get(signalLeaderHoldingKey);

    const existingAcct: AccountingPosition | null = prePos
      ? { quantity: prePos.qty, averageEntryUsd: prePos.avgCostUsd, costBasisUsd: prePos.qty * prePos.avgCostUsd, realizedPnlUsd: prePos.realizedPnlUsd, feesPaidUsd: 0 }
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
        dexFeeUsd,
        totalCostUsd: notionalUsd + feeUsd,
        sellProceedsUsd: 0,
      },
    });

    this.portfolio = next.portfolio;
    this.cashUsd = next.portfolio.cashUsd;
    this.positions.set(snapKey, {
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

    const fill: PaperFill = {
      id: fillId,
      signalId: signal.id,
      decidedAt,
      decision: "copied",
      side: "buy",
      token,
      quoteToken,
      qty,
      priceUsd: fillPrice,
      notionalUsd,
      feeUsd,
      slippageBps: 0,
      latencyMs: decidedAt - signal.observedAt,
      provisional: true,
      priceSource: "leader-implied",
    };
    await insertFill(this.db, fill);

    this.provisionals.set(signal.id, {
      fillId,
      signalId: signal.id,
      side: "buy",
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

    // Deliberately NOT calling takeSnapshot() here — the 5-min timer and the confirm step snapshot;
    // omitting it keeps the hot path to the fill insert + position upsert.
    this.bus.emit("paper-fill", fill);
    this.rememberLeaderHolding(signal);
    this.rememberSourceNotional(signal);
    logger.info({ fillId, side: "buy", notionalUsd, priceUsd: fillPrice, provisional: true }, "provisional paper fill (fast path)");
  }

  /**
   * Execute a human-reviewed candidate at the current decision time. The persisted signal remains a
   * candidate for scoring purposes; this transient copy uses the normal paper-fill path with decode
   * and staleness vetoes bypassed because the reviewer explicitly approved it now.
   */
  async executeManualCandidateCopy(signal: TradeSignal): Promise<void> {
    await this.handleSignal({
      ...signal,
      source: "confirmed",
      observedAt: Date.now(),
      confirmedAt: Date.now(),
      blockTimestamp: null,
      decodeStatus: "decoded",
      // Mark as in-flight manual copy: this is the explicit human approval that bypasses the decode,
      // staleness, and auto-copy vetoes. It is in-memory only — insertSignal won't overwrite the
      // persisted candidate's reviewStatus, which the runner advances to 'copied' on success.
      reviewStatus: "copying",
    });
  }

  /**
   * Execute a persisted, confirmed Polymarket signal through the normal engine path. The Polygon
   * watcher writes rows directly to the database (it does not emit on the EVM bus), so the runner's
   * auto-copy job re-enters the engine here.
   */
  async executePolymarketSignal(signal: TradeSignal): Promise<void> {
    if (signal.chain !== "polygon") {
      throw new Error(`executePolymarketSignal requires a polygon signal, got ${signal.chain}`);
    }
    // Serialize with the bus-driven handlers and timers via the shared queue (see the invariant on
    // `queue`) instead of mutating engine state directly off the runner's auto-copy job.
    await this.runOnQueue(() => this.handleSignal(signal));
  }

  private async quoteFillPriceWithZerox(input: {
    side: "buy" | "sell";
    token: TokenRef;
    quoteToken: TokenRef;
    notionalUsd: number;
    qty: number | null;
  }): Promise<ZeroxFillQuote> {
    if (!this.cfg.ZEROX_API_KEY) return { status: "unavailable" };

    try {
      if (input.side === "buy") {
        const quoteUsdPrice = await this.resolveQuoteUsdPrice(input.quoteToken);
        if (quoteUsdPrice <= 0) return { status: "unavailable" };
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
        if (tokenQty <= 0 || notionalUsd <= 0) return { status: "unavailable" };
        return { status: "quoted", priceUsd: notionalUsd / tokenQty, notionalUsd, dexFeeUsd: quote.dexFeeUsd };
      }

      if (input.qty === null || input.qty <= 0) return { status: "unavailable" };
      const quoteUsdPrice = await this.resolveQuoteUsdPrice(input.quoteToken);
      if (quoteUsdPrice <= 0) return { status: "unavailable" };
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
      if (soldQty <= 0 || notionalUsd <= 0) return { status: "unavailable" };
      return { status: "quoted", priceUsd: notionalUsd / soldQty, notionalUsd, dexFeeUsd: quote.dexFeeUsd };
    } catch (err) {
      logger.debug({ err, side: input.side, token: input.token.address, quoteToken: input.quoteToken.address }, "0x fill quote unavailable; falling back to spot pricing");
      return isExplicitNoRouteError(err) ? { status: "unavailable", hardVetoReason: "no-executable-route" } : { status: "unavailable" };
    }
  }

  private async resolveQuoteUsdPrice(quoteToken: TokenRef): Promise<number> {
    const price = await getUsdPrice(this.evm(quoteToken.chain), quoteToken.address, this.rpcClients[this.evm(quoteToken.chain)]);
    return price ?? 0;
  }

  /**
   * Modeled execution slippage in bps: DEX fee + price impact (scaled by notional/liquidity, capped
   * at 500 bps) + a fixed copy-delay penalty. Shared by buys, copied sells, and exit sells so every
   * fill path applies the same slippage model.
   */
  private modeledSlippageBps(chain: ChainId, grossNotionalUsd: number, liquidityUsd: number | null): number {
    const delayPenaltyBps = chain === "eth" ? this.cfg.COPY_DELAY_PENALTY_BPS_ETH : this.cfg.COPY_DELAY_PENALTY_BPS_BASE;
    const impactBps = Math.min(500, Math.round(10_000 * grossNotionalUsd / (2 * Math.max(liquidityUsd ?? 1, 1))));
    return DEX_FEE_BPS + impactBps + delayPenaltyBps;
  }

  /**
   * Price a sell fill: prefer an executable 0x quote (when ZEROX_API_KEY is set), otherwise fall
   * back to spot minus modeled slippage. `dexFeeUsd` is the 0x fee when quoted, else null (the
   * caller models the DEX fee from notional). Shared by copied sells and exit-rule sells.
   */
  private async priceSellFill(input: {
    token: TokenRef;
    quoteToken: TokenRef;
    qty: number;
    fallbackPriceUsd: number;
    slippageBps: number;
  }): Promise<{ fillPrice: number; dexFeeUsd: number | null }> {
    const quoted = await this.quoteFillPriceWithZerox({
      side: "sell",
      token: input.token,
      quoteToken: input.quoteToken,
      notionalUsd: input.qty * input.fallbackPriceUsd,
      qty: input.qty,
    });
    if (quoted.status === "quoted") {
      return { fillPrice: quoted.priceUsd, dexFeeUsd: quoted.dexFeeUsd };
    }
    return { fillPrice: input.fallbackPriceUsd * (1 - input.slippageBps / 10_000), dexFeeUsd: null };
  }

  /**
   * Apply a sell to portfolio + position state and persist the position row (close when flat,
   * otherwise upsert). Shared accounting path for copied sells and exit-rule sells.
   */
  /**
   * Persist a position delta and its fill in a single transaction, then apply the in-memory mutation
   * only after the commit succeeds. Used by the Polymarket path, whose signals are drained by a poll
   * that re-claims any signal lacking a fill row: committing the position without its fill would let
   * the poll re-process and double-apply the trade. Atomic commit plus post-commit memory mutation
   * closes that window — a thrown commit leaves the DB and memory untouched, so the re-claim retries.
   */
  private async commitFillAtomic(args: {
    next: { portfolio: AccountingPortfolio; position: { quantity: number; averageEntryUsd: number; realizedPnlUsd: number } };
    posKey: string;
    chain: ChainId;
    tokenAddress: string;
    walletId: string;
    fill: PaperFill;
  }): Promise<void> {
    const { next, fill } = args;
    const closes = next.position.quantity < 1e-10;
    await this.db.transaction(async (tx) => {
      if (closes) {
        await closePositionByKey(tx, {
          chain: args.chain,
          tokenAddress: args.tokenAddress,
          sourceWalletId: args.walletId,
          realizedPnlUsd: next.position.realizedPnlUsd,
        });
      } else {
        await upsertPosition(tx, {
          chain: args.chain,
          tokenAddress: args.tokenAddress,
          qty: next.position.quantity,
          avgCostUsd: next.position.averageEntryUsd,
          realizedPnlUsd: next.position.realizedPnlUsd,
          sourceWalletId: args.walletId,
        });
      }
      await insertFill(tx, fill);
    });

    this.portfolio = next.portfolio;
    this.cashUsd = next.portfolio.cashUsd;
    if (closes) {
      this.positions.delete(args.posKey);
    } else {
      this.positions.set(args.posKey, {
        qty: next.position.quantity,
        avgCostUsd: next.position.averageEntryUsd,
        realizedPnlUsd: next.position.realizedPnlUsd,
      });
    }
  }

  private async applySellToState(input: {
    chain: ChainId;
    tokenAddress: string;
    walletId: string;
    posKey: string;
    existing: InMemoryPosition;
    qty: number;
    notionalUsd: number;
    gasUsd: number;
    dexFeeUsd: number;
    effectiveFeeUsd: number;
  }): Promise<void> {
    const sellProceeds = Math.max(0, input.notionalUsd - input.effectiveFeeUsd);
    const next = applyTradeToState({
      portfolio: this.portfolio,
      position: {
        quantity: input.existing.qty,
        averageEntryUsd: input.existing.avgCostUsd,
        costBasisUsd: input.existing.qty * input.existing.avgCostUsd,
        realizedPnlUsd: input.existing.realizedPnlUsd,
        feesPaidUsd: 0,
      },
      trade: {
        side: "sell",
        quantity: input.qty,
        notionalUsd: input.notionalUsd,
        gasUsd: input.gasUsd,
        slippageUsd: 0,
        dexFeeUsd: input.dexFeeUsd,
        totalCostUsd: input.effectiveFeeUsd,
        sellProceedsUsd: sellProceeds,
      },
    });

    this.portfolio = next.portfolio;
    this.cashUsd = next.portfolio.cashUsd;

    if (next.position.quantity < 1e-10) {
      this.positions.delete(input.posKey);
      // Stamp closedAt so the flat position doesn't reload as a zombie at boot.
      await closePositionByKey(this.db, {
        chain: input.chain,
        tokenAddress: input.tokenAddress,
        sourceWalletId: input.walletId,
        realizedPnlUsd: next.position.realizedPnlUsd,
      });
    } else {
      this.positions.set(input.posKey, {
        qty: next.position.quantity,
        avgCostUsd: next.position.averageEntryUsd,
        realizedPnlUsd: next.position.realizedPnlUsd,
      });
      await upsertPosition(this.db, {
        chain: input.chain,
        tokenAddress: input.tokenAddress,
        qty: next.position.quantity,
        avgCostUsd: next.position.averageEntryUsd,
        realizedPnlUsd: next.position.realizedPnlUsd,
        sourceWalletId: input.walletId,
      });
    }
  }

  async executeExitSell(
    pos: { chain: string; tokenAddress: string; qty: number; avgCostUsd: number; sourceWalletId: string | null },
    trigger: "tp" | "sl" | null,
    currentPriceUsd: number
  ): Promise<void> {
    // Route the externally-invoked exit job through the shared queue (see the invariant on `queue`).
    await this.runOnQueue(() => this.executeExitSellImpl(pos, trigger, currentPriceUsd));
  }

  private async executeExitSellImpl(
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
    // Hydrate real token decimals so the shared 0x sell path (priceSellFill) sizes the quote
    // correctly; fall back to 18 only when the token is unknown.
    const tokenRow = await getToken(this.db, chain, pos.tokenAddress.toLowerCase());
    const token: TokenRef = {
      chain,
      address: pos.tokenAddress.toLowerCase(),
      symbol: tokenRow?.symbol ?? "",
      decimals: tokenRow?.decimals ?? 18,
    };
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
    let liquidityUsd: number | null = null;
    try {
      // Recover a V4 poolId so exit-sell depth uses real liquidity instead of the worst-case
      // null-liquidity slippage penalty for V4-only tokens.
      const hint = (await getV4MarketHintForToken(this.db, chain, token.address)) ?? undefined;
      liquidityUsd = await getLiquidityUsd(chain, token.address, this.rpcClients[chain], hint);
    } catch {
      liquidityUsd = null;
    }
    const grossNotionalUsd = qty * currentPriceUsd;
    const slippageBps = this.modeledSlippageBps(chain, grossNotionalUsd, liquidityUsd);
    // Use the same 0x-or-spot pricing as copied sells so exit fills are modeled identically.
    const priced = await this.priceSellFill({ token, quoteToken, qty, fallbackPriceUsd: currentPriceUsd, slippageBps });
    const fillPrice = priced.fillPrice;
    const zeroxFeeUsd = priced.dexFeeUsd;
    this.markPrices.set(markKey(chain, token.address), currentPriceUsd);
    const notionalUsd = qty * fillPrice;
    const dexFeeUsd = zeroxFeeUsd ?? (notionalUsd * DEX_FEE_BPS) / 10_000;
    const feeUsd = gasUsd + dexFeeUsd;

    await this.applySellToState({
      chain,
      tokenAddress: token.address,
      walletId: pos.sourceWalletId,
      posKey: key,
      existing,
      qty,
      notionalUsd,
      gasUsd,
      dexFeeUsd,
      effectiveFeeUsd: feeUsd,
    });

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

    const token: TokenRef = confirmed.side === "buy" ? confirmed.tokenOut : confirmed.tokenIn;
    const hint = v4MarketHint(confirmed);

    // Deferred liquidity risk gate: the fast path committed the provisional buy without discovery,
    // so run it now and void the fill if it fails. (Sells never become provisionals via the fast
    // path, but guard on side anyway.)
    if (prov.side === "buy") {
      let liquidityUsd: number | null = null;
      try {
        const liquidity = await getLiquidityUsdResult(this.evm(confirmed.chain), token.address, this.rpcClients[this.evm(confirmed.chain)], hint);
        liquidityUsd = liquidity?.liquidityUsd ?? null;
      } catch {
        liquidityUsd = null;
      }
      const veto = this.liquidityVeto(confirmed, liquidityUsd);
      if (veto) return this.reverseProvisional(signalId, `confirm-veto:${veto}`);
    }

    // Recompute price at confirmation time
    let price: PriceResult | null = null;
    try {
      price = await getUsdPriceResult(this.evm(confirmed.chain), token.address, this.rpcClients[this.evm(confirmed.chain)], hint);
    } catch { /* keep null */ }
    const newPrice = price?.priceUsd ?? 0;

    // Deferred fallback-price-source veto: a buy that only prices via the DefiLlama fallback is
    // vetoed at confirm (the fast path skipped this gate), reversing the provisional fill.
    if (prov.side === "buy" && price?.source === "defillama" && !this.runtimeConfig.ALLOW_FALLBACK_PRICE_BUYS) {
      return this.reverseProvisional(signalId, "confirm-veto:fallback-price-source");
    }

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
    return this.reverseProvisional(signalId, reason);
  }

  /**
   * Reverse a provisional fill: undo its portfolio/position/leader-holding deltas and void the fill
   * row. Called when a mempool tx is voided (reverted/replaced) or when a deferred confirm-time veto
   * rejects the fill.
   */
  private async reverseProvisional(signalId: string, reason: string): Promise<void> {
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
    logger.info({ signalId, reason }, "provisional fill reversed");
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

  ingestPriceMark(chain: ChainId, tokenAddress: string, priceUsd: number): void {
    if (!Number.isFinite(priceUsd) || priceUsd <= 0) return;
    this.markPrices.set(markKey(chain, tokenAddress), priceUsd);
  }

  async settlePolymarketPosition(input: {
    chain: "polygon";
    tokenAddress: string;
    qty: number;
    avgCostUsd: number;
    sourceWalletId: string | null;
    conditionId: string;
    outcomeIndex: number;
  }): Promise<"settled" | "skipped"> {
    // Route the externally-invoked resolution job through the shared queue (see the invariant on
    // `queue`) so settlement mutates state under the same scheduler as the copy/exit/bus paths.
    return this.runOnQueue(() => this.settlePolymarketPositionImpl(input));
  }

  private async settlePolymarketPositionImpl(input: {
    chain: "polygon";
    tokenAddress: string;
    qty: number;
    avgCostUsd: number;
    sourceWalletId: string | null;
    conditionId: string;
    outcomeIndex: number;
  }): Promise<"settled" | "skipped"> {
    if (input.sourceWalletId === null) {
      logger.warn({ tokenAddress: input.tokenAddress, conditionId: input.conditionId }, "skipping Polymarket settlement for position without source wallet");
      return "skipped";
    }
    if (input.qty <= 0) return "skipped";

    const status = await getPolymarketMarketStatus(input.conditionId);
    if (!status) return "skipped";

    const payout = getPolymarketResolutionPayout(status, input.outcomeIndex);
    if (payout === null) {
      // A market that's closed/resolved but whose outcome price hasn't converged to ~1/~0 (e.g. an
      // open UMA dispute window, or a multi-outcome market) can't be settled without guessing the
      // winner, so the position stays open and keeps marking at the CLOB midpoint. That's the safe
      // choice, but it can strand a position indefinitely — surface it (rate-limited per condition)
      // so the operator can investigate, rather than letting it drift silently. A still-trading
      // market is the normal not-yet-resolved case and stays at debug.
      if (status.closed || status.resolved) {
        const now = Date.now();
        const lastWarned = this.resolutionStrandWarnedAt.get(input.conditionId) ?? 0;
        if (now - lastWarned >= RESOLUTION_STRAND_WARN_INTERVAL_MS) {
          this.resolutionStrandWarnedAt.set(input.conditionId, now);
          logger.warn({
            conditionId: input.conditionId,
            outcomeIndex: input.outcomeIndex,
            closed: status.closed,
            resolved: status.resolved,
            outcomePrices: status.outcomePrices,
          }, "Polymarket market closed/resolved but payout indeterminate; position left open");
        }
      } else {
        logger.debug({
          conditionId: input.conditionId,
          outcomeIndex: input.outcomeIndex,
          closed: status.closed,
          resolved: status.resolved,
          outcomePrices: status.outcomePrices,
        }, "Polymarket market not settleable yet");
      }
      return "skipped";
    }
    // Settled cleanly — drop any stranding-warn bookkeeping for this condition.
    this.resolutionStrandWarnedAt.delete(input.conditionId);

    const tokenRow = await getToken(this.db, "polygon", input.tokenAddress.toLowerCase());
    const token: TokenRef = {
      chain: "polygon",
      address: input.tokenAddress.toLowerCase(),
      symbol: tokenRow?.symbol ?? "",
      decimals: tokenRow?.decimals ?? 6,
      ...(tokenRow?.name ? { name: tokenRow.name } : {}),
    };
    const quoteToken = quoteTokenFor("polygon");
    const key = posKey("polygon", token.address, input.sourceWalletId);
    const existing = this.positions.get(key) ?? {
      qty: input.qty,
      avgCostUsd: input.avgCostUsd,
      realizedPnlUsd: 0,
    };

    const now = Date.now();
    const signal: TradeSignal = {
      id: randomUUID(),
      chain: "polygon",
      txHash: `resolution:${input.conditionId}:${input.outcomeIndex}:${token.address}:${input.sourceWalletId}`,
      source: "confirmed",
      side: "sell",
      tokenIn: token,
      tokenOut: quoteToken,
      amountIn: toRawAmount(existing.qty, token.decimals),
      amountOut: toRawAmount(existing.qty * payout, quoteToken.decimals),
      venue: "polymarket-resolution",
      observedAt: now,
      confirmedAt: now,
      blockNumber: null,
      walletId: input.sourceWalletId,
      decodeStatus: "decoded",
      conditionId: input.conditionId,
      outcomeIndex: input.outcomeIndex,
    };
    const signalId = await insertSignal(this.db, signal);

    if (payout > 0) this.ingestPriceMark("polygon", token.address, payout);
    await this.applySellToState({
      chain: "polygon",
      tokenAddress: token.address,
      walletId: input.sourceWalletId,
      posKey: key,
      existing,
      qty: existing.qty,
      notionalUsd: existing.qty * payout,
      gasUsd: 0,
      dexFeeUsd: 0,
      effectiveFeeUsd: 0,
    });

    const fill: PaperFill = {
      id: randomUUID(),
      signalId,
      decidedAt: now,
      decision: "copied",
      side: "sell",
      token,
      quoteToken,
      qty: existing.qty,
      priceUsd: payout,
      notionalUsd: existing.qty * payout,
      feeUsd: 0,
      slippageBps: 0,
      latencyMs: 0,
      provisional: false,
      priceSource: status.source,
      priceVenue: "polymarket-resolution",
    };
    await insertFill(this.db, fill);
    await this.takeSnapshot();
    this.bus.emit("paper-fill", fill);
    logger.info({
      signalId,
      conditionId: input.conditionId,
      outcomeIndex: input.outcomeIndex,
      payout,
      qty: existing.qty,
    }, "polymarket position settled at resolution");
    return "settled";
  }
}

/**
 * A confirmed signal is stale when its source timestamp is older than maxAgeMs. EVM signals use the
 * block timestamp (observedAt is merely WS-receipt time), while Polymarket signals use observedAt
 * because the watcher stamps it from the trade timestamp itself. Mempool signals are never stale.
 */
export function isStaleSignal(
  signal: Pick<TradeSignal, "blockTimestamp" | "observedAt" | "source" | "chain">,
  nowMs: number,
  maxAgeMs: number
): boolean {
  if (signal.source === "mempool") return false;
  const ts = signal.blockTimestamp ?? (signal.chain === "polygon" ? signal.observedAt : null);
  if (ts === undefined || ts === null) return false;
  return nowMs - ts > maxAgeMs;
}

function posKey(chain: ChainId, tokenAddress: string, walletId: string | null): string {
  return `${chain}:${tokenAddress.toLowerCase()}:${walletId ?? ""}`;
}

function markKey(chain: ChainId, tokenAddress: string): string {
  return `${chain}:${tokenAddress.toLowerCase()}`;
}

/**
 * Pricing hint for a Uniswap V4 swap: the decoded poolId + the swap's quote side (the counter
 * currency). Lets pricing value a V4-only token via StateView. Undefined for non-V4 signals.
 */
function v4MarketHint(signal: TradeSignal): MarketHint | undefined {
  if (!signal.poolId) return undefined;
  const counter = signal.side === "buy" ? signal.tokenIn : signal.tokenOut;
  return { poolId: signal.poolId, counterCurrency: counter.address };
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

function booleanSetting(settings: Record<string, unknown>, keys: string[], fallback: boolean): boolean {
  for (const key of keys) {
    const value = settings[key];
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (["1", "true", "yes", "on"].includes(normalized)) return true;
      if (["0", "false", "no", "off"].includes(normalized)) return false;
    }
  }
  return fallback;
}

function isExplicitNoRouteError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const normalized = message.toLowerCase();
  return (
    normalized.includes("no usable 0x liquidity/route") ||
    normalized.includes("no usable route") ||
    normalized.includes("no route") ||
    normalized.includes("no_route") ||
    normalized.includes("insufficient_asset_liquidity")
  );
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

function quoteTokenFor(chain: EvmChainId): TokenRef;
function quoteTokenFor(chain: "polygon"): TokenRef;
function quoteTokenFor(chain: EvmChainId | "polygon"): TokenRef {
  if (chain === "eth") {
    return { chain, address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", symbol: "USDC", decimals: 6 };
  }
  if (chain === "base") {
    return { chain, address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", symbol: "USDC", decimals: 6 };
  }
  return { chain, address: "0x2791bca1f2de4661ed88a30c99a7a9449aa84174", symbol: "USDC", decimals: 6 };
}

function toRawAmount(amount: number, decimals: number): bigint {
  if (!Number.isFinite(amount) || amount <= 0) return 0n;
  return BigInt(Math.max(0, Math.floor(amount * 10 ** decimals)));
}
