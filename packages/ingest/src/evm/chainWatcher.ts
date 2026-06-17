import { createPublicClient, webSocket, parseAbi } from "viem";
import { mainnet, base } from "viem/chains";
import WebSocket from "ws";
import { createLogger, type ChainId, type RawTxEvent, type EventBus, type ChainWatcherHealth, type ConnectionState } from "@tradebot/core";
import { getActiveWallets, upsertLastBlock, getLastBlock, type Db } from "@tradebot/store";
import { LruSet } from "../dedupe.js";
import { backoffMs, sleep } from "../backoff.js";
import type { Recorder } from "../recorder.js";
import { TRANSFER_TOPIC, chunk } from "./topics.js";

const CHUNK_SIZE = 50;
const DEDUPE_SIZE = 50_000;
const BACKFILL_CHUNK_BY_CHAIN: Record<ChainId, number> = {
  eth: 10,
  base: 10,
};
const BACKFILL_ADDRESS_CHUNK_BY_CHAIN: Record<ChainId, number> = {
  eth: CHUNK_SIZE,
  base: 5,
};
// Cap how far back a reconnect will backfill — roughly 30 minutes of blocks per chain.
// When the gap is larger (e.g. the DB was stopped for hours during testing) we skip to
// live rather than replaying long-dead trades at the current price. The engine's
// staleness veto is the second line of defense for anything within this window.
const MAX_BACKFILL_BLOCKS_BY_CHAIN: Record<ChainId, number> = {
  eth: 150, // ~12s blocks → ~30 min
  base: 900, // ~2s blocks → ~30 min
};
const FAILOVER_TIMEOUT_MS = 60_000;
const WALLET_RELOAD_MS = 60_000;
const MEMPOOL_RECONNECT_MS = 1_000;
const GET_LOGS_RATE_LIMIT_RETRIES = 4;

const VIEM_CHAINS = { eth: mainnet, base: base } as const;

const TRANSFER_ABI = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

type ViemLog = {
  transactionHash: `0x${string}` | null;
  topics: readonly string[];
  address: string;
  data: string;
};

type ReceiptLog = { address: string; topics: readonly string[]; data: string };

type Client = {
  getBlockNumber(): Promise<bigint>;
  watchEvent(p: {
    event: (typeof TRANSFER_ABI)[0];
    args: { from?: readonly `0x${string}`[] } | { to?: readonly `0x${string}`[] };
    onLogs(logs: ViemLog[]): void;
    onError(err: Error): void;
  }): () => void;
  watchBlockNumber(p: {
    onBlockNumber(n: bigint): void;
    onError(err: Error): void;
  }): () => void;
  getLogs(p: {
    fromBlock: bigint;
    toBlock: bigint;
    event: (typeof TRANSFER_ABI)[0];
    args: { from?: readonly `0x${string}`[] } | { to?: readonly `0x${string}`[] };
  }): Promise<ViemLog[]>;
  getTransactionReceipt(p: { hash: `0x${string}` }): Promise<{
    from: string;
    to: string | null;
    blockNumber: bigint | null;
    logs: ReceiptLog[];
    status: "success" | "reverted";
  }>;
  getTransaction(p: { hash: `0x${string}` }): Promise<{
    input: `0x${string}`;
    nonce: number;
    value: bigint;
  }>;
  getBlock(p: { blockNumber: bigint }): Promise<{ timestamp: bigint }>;
};

const BLOCK_TS_CACHE_MAX = 2_000;

export interface ChainWatcherOptions {
  chain: ChainId;
  primaryWsUrl: string;
  fallbackWsUrl?: string;
  db: Db;
  bus: EventBus;
  recorder: Recorder;
}

export class ChainWatcher {
  private readonly chain: ChainId;
  private readonly primaryWsUrl: string;
  private readonly fallbackWsUrl: string | undefined;
  private readonly db: Db;
  private readonly bus: EventBus;
  private readonly recorder: Recorder;
  private readonly logger;

  private wallets: string[] = [];
  private readonly dedupe = new LruSet<string>(DEDUPE_SIZE);
  // Block number → block timestamp (epoch ms). Many txs share a block during backfill bursts.
  private readonly blockTsCache = new Map<number, number>();

  private stopped = false;
  private client: Client | null = null;
  private cleanupFns: Array<() => void> = [];
  private mempoolWs: WebSocket | null = null;
  private mempoolReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private walletReloadTimer: ReturnType<typeof setInterval> | null = null;
  private lastEventTs = 0;
  private usingFallback = false;
  private primaryDownSince: number | null = null;
  private connectionState: ConnectionState = "reconnecting";
  private connectFailures = 0;

  _backfillCallCount = 0;

  constructor(opts: ChainWatcherOptions) {
    this.chain = opts.chain;
    this.primaryWsUrl = opts.primaryWsUrl;
    this.fallbackWsUrl = opts.fallbackWsUrl;
    this.db = opts.db;
    this.bus = opts.bus;
    this.recorder = opts.recorder;
    this.logger = createLogger(`ingest:${opts.chain}`);
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.loadWallets();
    this.startWalletReload();
    void this.runLoop();
  }

  stop(): void {
    this.stopped = true;
    if (this.walletReloadTimer) {
      clearInterval(this.walletReloadTimer);
      this.walletReloadTimer = null;
    }
    this.teardown();
  }

  /** Poll the DB for wallet changes and reconnect so new wallets get subscribed (Phase 6 hot-reload). */
  private startWalletReload(): void {
    const timer = setInterval(() => void this.reloadWallets(), WALLET_RELOAD_MS);
    timer.unref?.();
    this.walletReloadTimer = timer;
  }

  private async reloadWallets(): Promise<void> {
    if (this.stopped) return;
    const before = this.wallets.join(",");
    try {
      await this.loadWallets();
    } catch (err) {
      this.logger.warn({ err }, "wallet reload failed");
      return;
    }
    if (this.wallets.join(",") !== before) {
      this.logger.info({ count: this.wallets.length }, "wallet set changed — reconnecting");
      // Tearing down resolves the in-flight connect(), so runLoop reconnects and re-subscribes.
      this.teardown();
    }
  }

  private async loadWallets(): Promise<void> {
    const wallets = await getActiveWallets(this.db, this.chain);
    this.wallets = wallets.map((w) => w.address);
    this.logger.info({ count: this.wallets.length }, "loaded wallets");
  }

  private teardown(): void {
    for (const fn of this.cleanupFns) {
      try { fn(); } catch { /* ignore */ }
    }
    this.cleanupFns = [];
    if (this.mempoolReconnectTimer) {
      clearTimeout(this.mempoolReconnectTimer);
      this.mempoolReconnectTimer = null;
    }
    if (this.mempoolWs) {
      // Null first so the 'close' handler doesn't schedule an independent reconnect.
      const ws = this.mempoolWs;
      this.mempoolWs = null;
      ws.close();
    }
    this.client = null;
  }

  private async runLoop(): Promise<void> {
    let attempt = 0;
    while (!this.stopped) {
      try {
        await this.connect();
        attempt = 0;
      } catch (err) {
        // Tear down the failed connection's watchers/sockets before retrying so they don't leak.
        this.teardown();
        this.connectionState = "reconnecting";
        this.connectFailures++;
        if (this.stopped) break;
        this.onConnectionFailure();
        const delay = backoffMs(attempt++, 1_000, 30_000);
        this.logger.error({ err, attempt, delay, usingFallback: this.usingFallback }, "connection error — reconnecting");
        await sleep(delay);
      }
    }
  }

  /** On a failed attempt, flip to the QuickNode fallback; if the fallback also failed, retry primary. */
  private onConnectionFailure(): void {
    if (!this.fallbackWsUrl) return;
    if (!this.usingFallback) {
      this.usingFallback = true;
      this.primaryDownSince = Date.now();
    } else {
      this.usingFallback = false;
      this.primaryDownSince = null;
    }
  }

  private async connect(): Promise<void> {
    const wsUrl = this.resolveWsUrl();
    this.logger.info({ wsUrl: wsUrl.replace(/\/v2\/.+/, "/v2/***") }, "connecting");

    const savedBlock = await getLastBlock(this.db, this.chain);

    const rawClient = createPublicClient({
      chain: VIEM_CHAINS[this.chain],
      transport: webSocket(wsUrl, { reconnect: false }),
    });
    this.client = rawClient as unknown as Client;

    const currentBlock = Number(await this.client.getBlockNumber());

    const plan = planBackfill(savedBlock, currentBlock, MAX_BACKFILL_BLOCKS_BY_CHAIN[this.chain]);
    if (plan.action === "backfill") {
      await this.backfillGap(plan.fromBlock, plan.toBlock);
    } else if (plan.action === "skip-to-live") {
      this.logger.warn(
        {
          savedBlock,
          currentBlock,
          gap: currentBlock - (savedBlock ?? currentBlock),
          maxBlocks: MAX_BACKFILL_BLOCKS_BY_CHAIN[this.chain],
        },
        "gap exceeds backfill cap — skipping to live to avoid replaying stale trades"
      );
      await upsertLastBlock(this.db, this.chain, plan.toBlock);
    }

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        this.logger.warn({ err: err.message }, "subscription error");
        reject(err);
      };

      this.subscribeConfirmedLogs(onError);
      this.subscribeNewHeads(onError);
      this.subscribeMempoolPending();

      // Subscriptions are live at this point; report the steady state. usingFallback distinguishes
      // the primary endpoint from a QuickNode failover.
      this.connectionState = this.usingFallback ? "fallback" : "connected";

      this.cleanupFns.push(() => resolve());
    });
  }

  private resolveWsUrl(): string {
    if (this.fallbackWsUrl && this.usingFallback) {
      // After the failover window expires, give the primary another chance.
      if (this.primaryDownSince !== null && Date.now() - this.primaryDownSince >= FAILOVER_TIMEOUT_MS) {
        this.usingFallback = false;
        this.primaryDownSince = null;
        return this.primaryWsUrl;
      }
      return this.fallbackWsUrl;
    }
    return this.primaryWsUrl;
  }

  // ── Confirmed logs ──────────────────────────────────────────────────────────

  private subscribeConfirmedLogs(onError: (err: Error) => void): void {
    if (this.wallets.length === 0) return;
    const chunks = chunk(this.wallets, CHUNK_SIZE);

    for (const batch of chunks) {
      const typedBatch = batch as `0x${string}`[];

      const unwatchFrom = this.client!.watchEvent({
        event: TRANSFER_ABI[0]!,
        args: { from: typedBatch },
        onLogs: (logs) => void this.handleConfirmedLogs(logs),
        onError,
      });

      const unwatchTo = this.client!.watchEvent({
        event: TRANSFER_ABI[0]!,
        args: { to: typedBatch },
        onLogs: (logs) => void this.handleConfirmedLogs(logs),
        onError,
      });

      this.cleanupFns.push(unwatchFrom, unwatchTo);
    }
  }

  private async handleConfirmedLogs(logs: ViemLog[]): Promise<void> {
    const hashes = [
      ...new Set(logs.map((l) => l.transactionHash).filter((h): h is `0x${string}` => h !== null)),
    ];
    for (const txHash of hashes) {
      const dedupeKey = `confirmed:${txHash}`;
      if (!this.dedupe.add(dedupeKey)) continue;
      try {
        const receipt = await this.client!.getTransactionReceipt({ hash: txHash });
        const tx = await this.client!.getTransaction({ hash: txHash });
        const blockNumber = receipt.blockNumber !== null ? Number(receipt.blockNumber) : null;
        const blockTimestamp = blockNumber !== null ? await this.blockTimestampMs(blockNumber) : undefined;
        const event: RawTxEvent = {
          chain: this.chain,
          source: "confirmed",
          txHash,
          from: receipt.from.toLowerCase(),
          to: receipt.to?.toLowerCase() ?? null,
          blockNumber,
          observedAt: Date.now(),
          ...(blockTimestamp !== undefined ? { blockTimestamp } : {}),
          ...(tx.input ? { input: tx.input } : {}),
          logs: receipt.logs.map((l) => ({
            address: l.address.toLowerCase(),
            topics: l.topics as string[],
            data: l.data,
          })),
          status: receipt.status,
          nonce: tx.nonce,
          valueWei: tx.value,
        };
        this.emitAndRecord(event);
      } catch (err) {
        this.logger.warn({ err, txHash }, "failed to fetch receipt");
      }
    }
  }

  // ── New heads ───────────────────────────────────────────────────────────────

  private subscribeNewHeads(onError: (err: Error) => void): void {
    let blocksSinceLog = 0;
    const logInterval = this.chain === "base" ? 1 : 5;

    const unwatch = this.client!.watchBlockNumber({
      onBlockNumber: (blockNumber) => {
        const num = Number(blockNumber);
        void upsertLastBlock(this.db, this.chain, num);
        this.lastEventTs = Date.now();
        blocksSinceLog++;
        if (blocksSinceLog >= logInterval) {
          this.logger.debug({ block: num }, "new head");
          blocksSinceLog = 0;
        }
      },
      onError,
    });

    this.cleanupFns.push(unwatch);
  }

  // ── Mempool (Alchemy pending txs) ──────────────────────────────────────────

  private subscribeMempoolPending(): void {
    if (this.wallets.length === 0) return;

    const ws = new WebSocket(this.primaryWsUrl);
    this.mempoolWs = ws;

    ws.on("open", () => {
      const chunks = chunk(this.wallets, CHUNK_SIZE);
      for (const batch of chunks) {
        ws.send(
          JSON.stringify({
            id: 1,
            jsonrpc: "2.0",
            method: "eth_subscribe",
            params: ["alchemy_pendingTransactions", { fromAddress: batch, hashesOnly: false }],
          })
        );
      }
    });

    ws.on("message", (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString()) as {
          method?: string;
          params?: {
            result?: {
              hash?: string;
              from?: string;
              to?: string;
              input?: string;
              nonce?: string;
              value?: string;
            };
          };
        };

        if (msg.method !== "eth_subscription") return;
        const tx = msg.params?.result;
        if (!tx?.hash || !tx.from) return;

        const dedupeKey = `mempool:${tx.hash}`;
        if (!this.dedupe.add(dedupeKey)) return;

        const event: RawTxEvent = {
          chain: this.chain,
          source: "mempool",
          txHash: tx.hash,
          from: tx.from.toLowerCase(),
          to: tx.to?.toLowerCase() ?? null,
          blockNumber: null,
          observedAt: Date.now(),
          ...(tx.input ? { input: tx.input as `0x${string}` } : {}),
          ...(tx.nonce !== undefined ? { nonce: parseInt(tx.nonce, 16) } : {}),
          ...(tx.value ? { valueWei: BigInt(tx.value) } : {}),
        };

        this.emitAndRecord(event);
      } catch (err) {
        this.logger.debug({ err }, "mempool parse error");
      }
    });

    ws.on("error", (err) => {
      this.logger.warn({ err: err.message }, "mempool WS error");
    });

    ws.on("close", () => {
      // Reopen the mempool socket independently — the main confirmed/heads connection may stay
      // healthy, in which case connect() never re-runs and the mempool feed would be lost.
      if (this.stopped || this.mempoolWs !== ws) return;
      this.mempoolWs = null;
      this.logger.warn("mempool WS closed — reopening");
      this.mempoolReconnectTimer = setTimeout(() => {
        this.mempoolReconnectTimer = null;
        if (!this.stopped) this.subscribeMempoolPending();
      }, MEMPOOL_RECONNECT_MS);
    });
  }

  // ── Gap backfill ────────────────────────────────────────────────────────────

  // planBackfill (module-level, exported) decides whether a reconnect backfills the gap,
  // skips it as too large, or has nothing to do.

  async backfillGap(fromBlock: number, toBlock: number): Promise<void> {
    this._backfillCallCount++;
    this.logger.info({ fromBlock, toBlock }, "backfilling gap");

    const addrs = this.wallets;
    if (addrs.length === 0) return;

    const backfillChunk = BACKFILL_CHUNK_BY_CHAIN[this.chain];
    const addressChunk = BACKFILL_ADDRESS_CHUNK_BY_CHAIN[this.chain];
    for (let start = fromBlock; start <= toBlock; start += backfillChunk) {
      const end = Math.min(start + backfillChunk - 1, toBlock);
      for (const batch of chunk(addrs, addressChunk)) {
        try {
          const typedAddrs = batch as `0x${string}`[];
          const fromLogs = await this.getLogsWithRateLimitRetry({
            fromBlock: BigInt(start),
            toBlock: BigInt(end),
            event: TRANSFER_ABI[0]!,
            args: { from: typedAddrs },
          });
          const toLogs = await this.getLogsWithRateLimitRetry({
            fromBlock: BigInt(start),
            toBlock: BigInt(end),
            event: TRANSFER_ABI[0]!,
            args: { to: typedAddrs },
          });

          const seen = new Set<string>();
          const relevant = [...fromLogs, ...toLogs].filter((l) => {
            if (!l.transactionHash) return false;
            if (seen.has(l.transactionHash)) return false;
            seen.add(l.transactionHash);
            return true;
          });

          await this.handleConfirmedLogs(relevant);
        } catch (err) {
          this.logger.warn({ err, start, end, addressCount: batch.length }, "backfill chunk failed");
        }
      }
    }
  }

  private async getLogsWithRateLimitRetry(p: Parameters<Client["getLogs"]>[0]): Promise<ViemLog[]> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.client!.getLogs(p);
      } catch (err) {
        if (!isRateLimitError(err) || attempt >= GET_LOGS_RATE_LIMIT_RETRIES) throw err;
        const delay = backoffMs(attempt, 1_000, 15_000);
        this.logger.info({ error: errorMessage(err), attempt: attempt + 1, delay }, "backfill getLogs rate-limited — retrying");
        await sleep(delay);
      }
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  /** Fetch a block's timestamp (epoch ms), cached by block number. Returns undefined on failure. */
  private async blockTimestampMs(blockNumber: number): Promise<number | undefined> {
    const cached = this.blockTsCache.get(blockNumber);
    if (cached !== undefined) return cached;
    try {
      const block = await this.client!.getBlock({ blockNumber: BigInt(blockNumber) });
      const ms = Number(block.timestamp) * 1000;
      if (this.blockTsCache.size >= BLOCK_TS_CACHE_MAX) {
        const oldest = this.blockTsCache.keys().next().value;
        if (oldest !== undefined) this.blockTsCache.delete(oldest);
      }
      this.blockTsCache.set(blockNumber, ms);
      return ms;
    } catch (err) {
      this.logger.debug({ err, blockNumber }, "failed to fetch block timestamp");
      return undefined;
    }
  }

  emitAndRecord(event: RawTxEvent): void {
    this.lastEventTs = Date.now();
    this.bus.emit("raw-tx", event);
    void this.recorder.record(event);
  }

  /** Snapshot of this watcher's connection health for the runner heartbeat. */
  getHealth(): ChainWatcherHealth {
    return {
      chain: this.chain,
      connectionState: this.connectionState,
      usingFallback: this.usingFallback,
      lastEventAt: this.lastEventTs,
      connectFailures: this.connectFailures,
      backfillCount: this._backfillCallCount,
      walletCount: this.wallets.length,
    };
  }
}

export type BackfillPlan =
  | { action: "backfill"; fromBlock: number; toBlock: number }
  | { action: "skip-to-live"; toBlock: number }
  | { action: "none" };

/**
 * Decide what a reconnect should do given the last persisted block and the current head.
 * Gaps wider than `maxBlocks` are skipped to live so a long downtime doesn't replay
 * stale trades; smaller gaps are backfilled; an unknown or already-current head does nothing.
 */
export function planBackfill(savedBlock: number | null, currentBlock: number, maxBlocks: number): BackfillPlan {
  if (savedBlock === null || currentBlock <= savedBlock + 1) return { action: "none" };
  if (currentBlock - savedBlock > maxBlocks) return { action: "skip-to-live", toBlock: currentBlock };
  return { action: "backfill", fromBlock: savedBlock + 1, toBlock: currentBlock };
}

function isRateLimitError(err: unknown): boolean {
  const message = errorMessage(err);
  const normalized = message.toLowerCase();
  return normalized.includes("rate limit")
    || normalized.includes("too many requests")
    || normalized.includes("exceeded")
    || normalized.includes("compute units per second");
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
