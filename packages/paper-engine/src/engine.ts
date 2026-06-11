import { randomUUID } from "crypto";
import PQueue from "p-queue";
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
  getPosition,
  getOpenPositions,
  latestSnapshot,
  insertSnapshot,
} from "@tradebot/store";
import { getUsdPrice, getLiquidityUsd } from "@tradebot/pricing";
import { applyTradeToState } from "./accounting.js";
import type { AccountingPortfolio, AccountingPosition } from "./accounting.js";
import { createLogger } from "@tradebot/core";

const logger = createLogger("paper-engine");

export interface WeightProvider {
  getWeight(walletId: string): number;
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
  // Pre-trade snapshot, used to reverse the fill exactly on void/replace.
  prevPortfolio: AccountingPortfolio;
  prevPosition: InMemoryPosition | null;
};

export class PaperEngine {
  private cashUsd: number;
  private positions = new Map<string, InMemoryPosition>();
  private provisionals = new Map<string, ProvisionalEntry>();
  private portfolio: AccountingPortfolio;
  private queue: PQueue;
  private snapshotTimer: ReturnType<typeof setInterval> | null = null;

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
  }

  async start(): Promise<void> {
    await this.loadState();

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

    logger.info({ cashUsd: this.cashUsd }, "PaperEngine started");
  }

  stop(): void {
    if (this.snapshotTimer) {
      clearInterval(this.snapshotTimer);
      this.snapshotTimer = null;
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
    for (const pos of this.positions.values()) {
      posValue += pos.qty * pos.avgCostUsd;
    }
    return this.cashUsd + posValue;
  }

  decide(signal: TradeSignal, liquidityUsd: number | null): { action: "copy"; notionalUsd: number } | { action: "skip"; reason: string } {
    const weight = this.weights.getWeight(signal.walletId);
    if (weight === 0) return { action: "skip", reason: "leader-weight-zero" };

    if (liquidityUsd === null) return { action: "skip", reason: "no-liquidity-data" };
    if (liquidityUsd < this.cfg.MIN_LIQUIDITY_USD) return { action: "skip", reason: "below-min-liquidity" };

    const eq = this.equity();
    let notional = eq * this.cfg.BASE_TRADE_PCT * weight;
    notional = Math.min(notional, eq * this.cfg.MAX_TRADE_PCT);
    notional = Math.max(notional, this.cfg.MIN_NOTIONAL_USD);

    if (signal.side === "buy") {
      notional = Math.min(notional, this.cashUsd);
      if (notional < this.cfg.MIN_NOTIONAL_USD) {
        return { action: "skip", reason: "insufficient-balance" };
      }
      return { action: "copy", notionalUsd: notional };
    }

    // Sell
    const token = signal.side === "sell" ? signal.tokenIn : signal.tokenOut;
    const key = posKey(signal.chain, token.address, signal.walletId);
    const pos = this.positions.get(key);
    if (!pos || pos.qty <= 0) return { action: "skip", reason: "no-position" };

    // Sell the same fraction the leader sold (estimate: notional / pos value)
    const posValue = pos.qty * pos.avgCostUsd;
    const fraction = Math.min(1, notional / Math.max(posValue, 1e-10));
    const sellQty = fraction * pos.qty;

    return { action: "copy", notionalUsd: sellQty * pos.avgCostUsd };
  }

  private async handleSignal(signal: TradeSignal): Promise<void> {
    await insertSignal(this.db, signal);

    const token: TokenRef = signal.side === "buy" ? signal.tokenOut : signal.tokenIn;
    const quoteToken: TokenRef = signal.side === "buy" ? signal.tokenIn : signal.tokenOut;

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
      return;
    }

    // Slippage model
    const gasUsd = signal.chain === "eth" ? this.cfg.GAS_USD_ETH : this.cfg.GAS_USD_BASE;
    const delayPenaltyBps = signal.chain === "eth"
      ? this.cfg.COPY_DELAY_PENALTY_BPS_ETH
      : this.cfg.COPY_DELAY_PENALTY_BPS_BASE;
    const impactBps = Math.min(500, Math.round(10_000 * decision.notionalUsd / (2 * Math.max(liquidityUsd ?? 1, 1))));
    const dexFeeBps = 30;
    const slippageBps = dexFeeBps + impactBps + delayPenaltyBps;
    const feeUsd = gasUsd + (decision.notionalUsd * dexFeeBps) / 10_000;

    let fillPrice: number;
    let qty: number;
    let notionalUsd: number;

    // Snapshot pre-trade state so a provisional (mempool) fill can be reversed exactly on void/replace.
    const snapKey = posKey(signal.chain, token.address, signal.walletId);
    const provisional = signal.source === "mempool";
    const prevPortfolio: AccountingPortfolio = { ...this.portfolio };
    const prePos = this.positions.get(snapKey);
    const prevPosition: InMemoryPosition | null = prePos ? { ...prePos } : null;

    if (signal.side === "buy") {
      fillPrice = priceUsd * (1 + slippageBps / 10_000);
      notionalUsd = decision.notionalUsd;
      qty = fillPrice > 0 ? notionalUsd / fillPrice : 0;

      if (this.cashUsd < notionalUsd + feeUsd) {
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
          dexFeeUsd: (notionalUsd * dexFeeBps) / 10_000,
          totalCostUsd: notionalUsd + feeUsd,
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
        return;
      }

      const posValue = existing.qty * existing.avgCostUsd;
      const fraction = Math.min(1, decision.notionalUsd / Math.max(posValue, 1e-10));
      qty = fraction * existing.qty;
      fillPrice = priceUsd * (1 - slippageBps / 10_000);
      notionalUsd = qty * fillPrice;
      const sellProceeds = Math.max(0, notionalUsd - feeUsd);

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
          dexFeeUsd: (notionalUsd * dexFeeBps) / 10_000,
          totalCostUsd: feeUsd,
          sellProceedsUsd: sellProceeds,
        },
      });

      this.portfolio = next.portfolio;
      this.cashUsd = next.portfolio.cashUsd;

      if (next.position.quantity < 1e-10) {
        this.positions.delete(key);
        await upsertPosition(this.db, {
          chain: signal.chain,
          tokenAddress: token.address,
          qty: 0,
          avgCostUsd: 0,
          realizedPnlUsd: next.position.realizedPnlUsd,
          sourceWalletId: signal.walletId,
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
      feeUsd,
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
        prevPortfolio,
        prevPosition,
      });
    }

    await this.takeSnapshot();
    this.bus.emit("paper-fill", fill);
    logger.info({ fillId, side: signal.side, notionalUsd, priceUsd: fillPrice, provisional }, "paper fill");
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

    // Restore portfolio and position to the exact pre-trade snapshot, then persist.
    this.portfolio = { ...prov.prevPortfolio };
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
      this.positions.delete(prov.posKey);
      await upsertPosition(this.db, {
        chain: prov.chain,
        tokenAddress: prov.tokenAddress,
        qty: 0,
        avgCostUsd: 0,
        realizedPnlUsd: 0,
        sourceWalletId: prov.sourceWalletId,
      });
    }

    await voidFill(this.db, prov.fillId);
    this.provisionals.delete(signalId);
    logger.info({ signalId, reason }, "provisional fill voided");
  }

  private async takeSnapshot(): Promise<void> {
    let posValue = 0;
    for (const pos of this.positions.values()) {
      posValue += pos.qty * pos.avgCostUsd;
    }
    const equityUsd = this.cashUsd + posValue;

    await insertSnapshot(this.db, {
      ts: new Date(),
      equityUsd,
      cashUsd: this.cashUsd,
      positionsValueUsd: posValue,
      dailyPnlUsd: this.portfolio.realizedPnlUsd,
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

function posKey(chain: ChainId, tokenAddress: string, walletId: string | null): string {
  return `${chain}:${tokenAddress.toLowerCase()}:${walletId ?? ""}`;
}
