import { randomUUID } from "crypto";
import { createLogger } from "@tradebot/core";
import type { TradeSignal, ChainWatcherHealth, ConnectionState } from "@tradebot/core";
import {
  getActiveWallets,
  insertSignal,
  upsertToken,
  upsertLastBlock,
  getPolymarketPollCursors,
  upsertPolymarketPollFailure,
  upsertPolymarketPollSuccess,
  type Db,
} from "@tradebot/store";
import { fetchTrades, type PolymarketTrade, type FetchTradesOptions } from "./client.js";

const logger = createLogger("ingest:polygon");

const WALLET_RELOAD_MS = 60_000;
const TRADE_PAGE_LIMIT = 100;
// The Data API rejects offsets past 3000 with a 400 ("max historical activity offset of 3000
// exceeded"). Cap pagination at that ceiling so we never request a page that is guaranteed to fail:
// pages 0..30 cover offsets 0..3000 at limit 100. A wallet that made more new trades than that since
// its last cursor leaves a permanent gap (the older trades are unreachable via this API), which is
// acceptable for record-only candidates — the cursor still advances each cycle, so the poller keeps
// making forward progress instead of failing on every poll forever.
const MAX_HISTORY_OFFSET = 3000;
const MAX_PAGES_PER_WALLET = Math.floor(MAX_HISTORY_OFFSET / TRADE_PAGE_LIMIT) + 1; // 31

// Polymarket settles in bridged USDC.e on Polygon. Lowercased to match the tokens-table key.
export const POLYGON_USDC = "0x2791bca1f2de4661ed88a30c99a7a9449aa84174";
const USDC_DECIMALS = 6;
// CTF outcome shares have no on-chain ERC-20 decimals; we use a fixed 1e6 convention internally for
// both the USDC leg and the share leg. Nothing downstream re-derives these (record-only).
const SHARE_DECIMALS = 6;
type Cursor = { timestamp: number; seenKeysAtTimestamp: Set<string> };
type PollWalletStats = {
  maxSeenTs: number;
  cursorTimestamp: number | null;
  cursorKeys: string[];
  fetchedCount: number;
  recordedCount: number;
  duplicateCount: number;
  pageCount: number;
};

/** Convert a positive float amount to a raw bigint at the given decimals (clamped at 0). */
function toRaw(amount: number, decimals: number): bigint {
  if (!Number.isFinite(amount) || amount <= 0) return 0n;
  return BigInt(Math.round(amount * 10 ** decimals));
}

function tradeKey(trade: PolymarketTrade): string {
  return `${trade.transactionHash.toLowerCase()}:${trade.side}:${trade.asset}`;
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
  // Per-wallet high-water trade timestamp (epoch seconds) plus trade keys at that exact second.
  // Polymarket timestamps are second-granular, so timestamp alone is not a safe cursor.
  private readonly cursor = new Map<string, Cursor>();

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
      const activeAddresses = new Set(this.wallets.map((w) => w.address));
      for (const address of this.cursor.keys()) {
        if (!activeAddresses.has(address)) this.cursor.delete(address);
      }

      const cursors = await getPolymarketPollCursors(this.db).catch((err: unknown) => {
        logger.warn({ err }, "polymarket cursor load failed");
        return [];
      });
      const cursorsByWalletId = new Map(cursors.map((cursor) => [cursor.walletId, cursor]));
      for (const wallet of this.wallets) {
        if (this.cursor.has(wallet.address)) continue;
        const cursor = cursorsByWalletId.get(wallet.id);
        if (!cursor) continue;
        this.cursor.set(wallet.address, {
          timestamp: cursor.cursorTimestamp,
          seenKeysAtTimestamp: new Set(cursor.cursorKeys),
        });
      }
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
        const startedAt = Date.now();
        try {
          const stats = await this.pollWallet(wallet);
          maxTs = Math.max(maxTs, stats.maxSeenTs);
          await upsertPolymarketPollSuccess(this.db, {
            walletId: wallet.id,
            lastPolledAt: Date.now(),
            cursorTimestamp: stats.cursorTimestamp,
            cursorKeys: stats.cursorKeys,
            fetchedCount: stats.fetchedCount,
            recordedCount: stats.recordedCount,
            duplicateCount: stats.duplicateCount,
            pageCount: stats.pageCount,
            durationMs: Date.now() - startedAt,
          }).catch((stateErr: unknown) => logger.warn({ err: stateErr, wallet: wallet.address }, "polymarket poll state write failed"));
        } catch (err) {
          sawError = true;
          logger.warn({ err, wallet: wallet.address }, "polymarket trade fetch failed");
          await upsertPolymarketPollFailure(this.db, {
            walletId: wallet.id,
            lastPolledAt: Date.now(),
            error: err instanceof Error ? err.message : String(err),
            durationMs: Date.now() - startedAt,
          }).catch((stateErr: unknown) => logger.warn({ err: stateErr, wallet: wallet.address }, "polymarket poll failure state write failed"));
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

  private async pollWallet(wallet: { id: string; address: string }): Promise<PollWalletStats> {
    const cursor = this.cursor.get(wallet.address);
    let newestTs = cursor?.timestamp ?? 0;
    let newestKeys = new Set(cursor?.seenKeysAtTimestamp ?? []);
    let maxSeenTs = 0;
    let fetchedCount = 0;
    let recordedCount = 0;
    let duplicateCount = 0;
    let pageCount = 0;

    for (let page = 0; page < MAX_PAGES_PER_WALLET; page++) {
      const trades = await fetchTrades(this.baseUrl, wallet.address, {
        limit: TRADE_PAGE_LIMIT,
        offset: page * TRADE_PAGE_LIMIT,
        ...this.fetchOpts,
      });
      if (trades.length === 0) break;
      pageCount++;
      fetchedCount += trades.length;

      let reachedCursor = false;
      for (const trade of trades) {
        maxSeenTs = Math.max(maxSeenTs, trade.timestamp);
        const key = tradeKey(trade);

        if (cursor && trade.timestamp < cursor.timestamp) {
          reachedCursor = true;
          break;
        }
        if (cursor && trade.timestamp === cursor.timestamp && cursor.seenKeysAtTimestamp.has(key)) {
          duplicateCount++;
          continue;
        }

        await this.recordTrade(trade, wallet.id);
        recordedCount++;

        if (trade.timestamp > newestTs) {
          newestTs = trade.timestamp;
          newestKeys = new Set([key]);
        } else if (trade.timestamp === newestTs) {
          newestKeys.add(key);
        }
      }

      // Cold start intentionally records only the newest page rather than importing full history.
      if (!cursor || reachedCursor || trades.length < TRADE_PAGE_LIMIT) break;

      if (page === MAX_PAGES_PER_WALLET - 1) {
        // Hit the API's history-depth ceiling before reaching the cursor: trades older than this page
        // but newer than the cursor are unrecoverable. Advance the cursor anyway (below) and warn.
        logger.warn({ wallet: wallet.address, pages: MAX_PAGES_PER_WALLET, maxOffset: MAX_HISTORY_OFFSET }, "polymarket history-depth ceiling reached; advancing cursor past gap");
      }
    }

    if (newestTs > 0) {
      this.cursor.set(wallet.address, { timestamp: newestTs, seenKeysAtTimestamp: newestKeys });
    }
    return {
      maxSeenTs,
      cursorTimestamp: newestTs > 0 ? newestTs : null,
      cursorKeys: Array.from(newestKeys).sort(),
      fetchedCount,
      recordedCount,
      duplicateCount,
      pageCount,
    };
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
