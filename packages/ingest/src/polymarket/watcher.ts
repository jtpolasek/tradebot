import { randomUUID } from "crypto";
import { createLogger } from "@tradebot/core";
import type { TradeSignal, ChainWatcherHealth, ConnectionState } from "@tradebot/core";
import {
  getActiveWallets,
  insertSignal,
  upsertToken,
  upsertLastBlock,
  type Db,
} from "@tradebot/store";
import { fetchTrades, type PolymarketTrade, type FetchTradesOptions } from "./client.js";

const logger = createLogger("ingest:polygon");

const WALLET_RELOAD_MS = 60_000;

// Polymarket settles in bridged USDC.e on Polygon. Lowercased to match the tokens-table key.
export const POLYGON_USDC = "0x2791bca1f2de4661ed88a30c99a7a9449aa84174";
const USDC_DECIMALS = 6;
// CTF outcome shares have no on-chain ERC-20 decimals; we use a fixed 1e6 convention internally for
// both the USDC leg and the share leg. Nothing downstream re-derives these (record-only).
const SHARE_DECIMALS = 6;

/** Convert a positive float amount to a raw bigint at the given decimals (clamped at 0). */
function toRaw(amount: number, decimals: number): bigint {
  if (!Number.isFinite(amount) || amount <= 0) return 0n;
  return BigInt(Math.round(amount * 10 ** decimals));
}

/**
 * Map a Polymarket Data API trade to a record-only candidate `TradeSignal`. A BUY spends USDC for
 * outcome shares (tokenIn=USDC, tokenOut=outcome); a SELL is the reverse. `decodeStatus:"candidate"`
 * makes `insertSignal` default `reviewStatus:"pending"` and keeps it out of scoring/auto-copy.
 */
export function tradeToCandidateSignal(trade: PolymarketTrade, walletId: string): TradeSignal {
  const side: "buy" | "sell" = trade.side === "BUY" ? "buy" : "sell";
  const usdc = toRaw(trade.size * trade.price, USDC_DECIMALS);
  const shares = toRaw(trade.size, SHARE_DECIMALS);

  const usdcToken = { chain: "polygon" as const, address: POLYGON_USDC, symbol: "USDC", decimals: USDC_DECIMALS };
  const outcomeToken = {
    chain: "polygon" as const,
    address: trade.asset,
    symbol: trade.outcome,
    name: trade.title,
    decimals: SHARE_DECIMALS,
  };

  const tokenIn = side === "buy" ? usdcToken : outcomeToken;
  const tokenOut = side === "buy" ? outcomeToken : usdcToken;
  const amountIn = side === "buy" ? usdc : shares;
  const amountOut = side === "buy" ? shares : usdc;

  const observedAt = trade.timestamp * 1000;
  const externalUrl = trade.eventSlug ? `https://polymarket.com/event/${trade.eventSlug}` : null;
  const reason = `Polymarket ${side.toUpperCase()} ${trade.outcome} @ $${trade.price} — "${trade.title}"`;

  return {
    id: randomUUID(),
    chain: "polygon",
    walletId,
    txHash: trade.transactionHash,
    source: "confirmed",
    side,
    tokenIn,
    tokenOut,
    amountIn,
    amountOut,
    venue: "polymarket",
    observedAt,
    confirmedAt: observedAt,
    blockNumber: null,
    decodeStatus: "candidate",
    confidence: null,
    reason,
    externalUrl,
    poolId: null,
  };
}

export interface PolymarketWatcherOptions {
  db: Db;
  pollMs: number;
  /** Data API base URL (default https://data-api.polymarket.com). */
  baseUrl: string;
  /** Injectable fetch for tests; forwarded to the client. */
  fetchImpl?: typeof fetch;
}

/**
 * Polls the Polymarket Data API per watched polygon wallet and records each new trade as a candidate
 * `TradeSignal`. Fully decoupled from the EVM bus/decoder/pricing/engine: it writes rows directly via
 * `insertSignal` and never emits on the core bus. Mirrors `ChainWatcher`'s 60s wallet reload and
 * `getHealth()` shape so the runner heartbeat and `/health` treat it uniformly.
 */
export class PolymarketWatcher {
  private readonly db: Db;
  private readonly pollMs: number;
  private readonly baseUrl: string;
  private readonly fetchOpts: Pick<FetchTradesOptions, "fetchImpl">;

  private wallets: { id: string; address: string }[] = [];
  // Per-wallet high-water trade timestamp (epoch seconds) to bound work; dedup is the DB constraint.
  private readonly cursor = new Map<string, number>();

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private walletReloadTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private running = false;

  private lastEventTs = 0;
  private connectFailures = 0;
  private connectionState: ConnectionState = "reconnecting";

  constructor(opts: PolymarketWatcherOptions) {
    this.db = opts.db;
    this.pollMs = opts.pollMs;
    this.baseUrl = opts.baseUrl;
    this.fetchOpts = opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {};
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.loadWallets();
    const reload = setInterval(() => void this.loadWallets(), WALLET_RELOAD_MS);
    reload.unref?.();
    this.walletReloadTimer = reload;

    void this.tick();
    const poll = setInterval(() => void this.tick(), this.pollMs);
    poll.unref?.();
    this.pollTimer = poll;
    logger.info({ pollMs: this.pollMs }, "PolymarketWatcher started");
  }

  stop(): void {
    this.stopped = true;
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    if (this.walletReloadTimer) { clearInterval(this.walletReloadTimer); this.walletReloadTimer = null; }
  }

  private async loadWallets(): Promise<void> {
    try {
      const wallets = await getActiveWallets(this.db, "polygon");
      this.wallets = wallets.map((w) => ({ id: w.id, address: w.address }));
    } catch (err) {
      logger.warn({ err }, "polygon wallet reload failed");
    }
  }

  /** One poll cycle: fetch recent trades per wallet and persist any new ones as candidates. */
  async tick(): Promise<void> {
    if (this.stopped || this.running) return;
    this.running = true;
    try {
      let maxTs = 0;
      let sawError = false;
      for (const wallet of this.wallets) {
        try {
          const trades = await fetchTrades(this.baseUrl, wallet.address, { limit: 100, ...this.fetchOpts });
          const cursor = this.cursor.get(wallet.address);
          for (const trade of trades) {
            // On a warm cursor, skip trades we've already passed; cold start records the page.
            if (cursor !== undefined && trade.timestamp <= cursor) continue;
            await this.recordTrade(trade, wallet.id);
            if (trade.timestamp > maxTs) maxTs = trade.timestamp;
          }
          const newest = trades.reduce((m, t) => Math.max(m, t.timestamp), cursor ?? 0);
          this.cursor.set(wallet.address, newest);
        } catch (err) {
          sawError = true;
          logger.warn({ err, wallet: wallet.address }, "polymarket trade fetch failed");
        }
      }

      if (sawError) {
        this.connectFailures++;
        this.connectionState = "reconnecting";
      } else {
        this.connectionState = "connected";
        this.lastEventTs = Date.now();
        // Bump chain_state.updated_at for polygon so /health freshness reflects the live poller.
        // lastBlock carries the newest trade timestamp seen this cycle (or now) — value is incidental.
        await upsertLastBlock(this.db, "polygon", maxTs > 0 ? maxTs : Math.floor(Date.now() / 1000))
          .catch((err: unknown) => logger.warn({ err }, "polygon chain_state bump failed"));
      }
    } finally {
      this.running = false;
    }
  }

  private async recordTrade(trade: PolymarketTrade, walletId: string): Promise<void> {
    const signal = tradeToCandidateSignal(trade, walletId);
    // Upsert readable token labels so the existing hydrateToken/TokenLink UI shows "Yes/No" + market
    // question and "USDC", rather than empty symbols (rowToSignal reads symbols from the tokens table).
    await upsertToken(this.db, {
      chain: "polygon",
      address: trade.asset,
      symbol: trade.outcome,
      name: trade.title,
      decimals: SHARE_DECIMALS,
      isBlocked: false,
    });
    await upsertToken(this.db, {
      chain: "polygon",
      address: POLYGON_USDC,
      symbol: "USDC",
      name: "USD Coin",
      decimals: USDC_DECIMALS,
      isBlocked: false,
    });
    await insertSignal(this.db, signal);
  }

  /** Snapshot for the runner heartbeat — same shape as ChainWatcher.getHealth(). */
  getHealth(): ChainWatcherHealth {
    return {
      chain: "polygon",
      connectionState: this.connectionState,
      usingFallback: false,
      lastEventAt: this.lastEventTs,
      connectFailures: this.connectFailures,
      backfillCount: 0,
      walletCount: this.wallets.length,
    };
  }
}
