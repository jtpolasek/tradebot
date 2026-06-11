import { createPublicClient, webSocket, parseAbi } from "viem";
import { mainnet, base } from "viem/chains";
import WebSocket from "ws";
import { createLogger, type ChainId, type RawTxEvent, type EventBus } from "@tradebot/core";
import { getActiveWallets, upsertLastBlock, getLastBlock, type Db } from "@tradebot/store";
import { LruSet } from "../dedupe.js";
import { backoffMs, sleep } from "../backoff.js";
import type { Recorder } from "../recorder.js";
import { TRANSFER_TOPIC, chunk } from "./topics.js";

const CHUNK_SIZE = 50;
const DEDUPE_SIZE = 50_000;
const BACKFILL_CHUNK_BY_CHAIN: Record<ChainId, number> = {
  eth: 500,
  base: 10,
};
const FAILOVER_TIMEOUT_MS = 60_000;

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
};

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

  private stopped = false;
  private client: Client | null = null;
  private cleanupFns: Array<() => void> = [];
  private mempoolWs: WebSocket | null = null;
  private lastEventTs = 0;
  private usingFallback = false;
  private primaryDownSince: number | null = null;

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
    void this.runLoop();
  }

  stop(): void {
    this.stopped = true;
    this.teardown();
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
    if (this.mempoolWs) {
      this.mempoolWs.close();
      this.mempoolWs = null;
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
        if (this.stopped) break;
        const delay = backoffMs(attempt++, 1_000, 30_000);
        this.logger.error({ err, attempt, delay }, "connection error — reconnecting");
        await sleep(delay);
      }
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

    if (savedBlock !== null && currentBlock > savedBlock + 1) {
      await this.backfillGap(savedBlock + 1, currentBlock);
    }

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        this.logger.warn({ err: err.message }, "subscription error");
        reject(err);
      };

      this.subscribeConfirmedLogs(onError);
      this.subscribeNewHeads(onError);
      this.subscribeMempoolPending();

      this.cleanupFns.push(() => resolve());
    });
  }

  private resolveWsUrl(): string {
    if (
      this.fallbackWsUrl &&
      this.usingFallback &&
      this.primaryDownSince !== null &&
      Date.now() - this.primaryDownSince < FAILOVER_TIMEOUT_MS
    ) {
      return this.fallbackWsUrl;
    }
    this.usingFallback = false;
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
        const event: RawTxEvent = {
          chain: this.chain,
          source: "confirmed",
          txHash,
          from: receipt.from.toLowerCase(),
          to: receipt.to?.toLowerCase() ?? null,
          blockNumber: receipt.blockNumber !== null ? Number(receipt.blockNumber) : null,
          observedAt: Date.now(),
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
      if (!this.stopped) {
        this.logger.debug("mempool WS closed — will reopen on next connect");
      }
    });
  }

  // ── Gap backfill ────────────────────────────────────────────────────────────

  async backfillGap(fromBlock: number, toBlock: number): Promise<void> {
    this._backfillCallCount++;
    this.logger.info({ fromBlock, toBlock }, "backfilling gap");

    const addrs = this.wallets;
    if (addrs.length === 0) return;

    const backfillChunk = BACKFILL_CHUNK_BY_CHAIN[this.chain];
    for (let start = fromBlock; start <= toBlock; start += backfillChunk) {
      const end = Math.min(start + backfillChunk - 1, toBlock);
      try {
        const typedAddrs = addrs as `0x${string}`[];
        const [fromLogs, toLogs] = await Promise.all([
          this.client!.getLogs({ fromBlock: BigInt(start), toBlock: BigInt(end), event: TRANSFER_ABI[0]!, args: { from: typedAddrs } }),
          this.client!.getLogs({ fromBlock: BigInt(start), toBlock: BigInt(end), event: TRANSFER_ABI[0]!, args: { to: typedAddrs } }),
        ]);

        const seen = new Set<string>();
        const relevant = [...fromLogs, ...toLogs].filter((l) => {
          if (!l.transactionHash) return false;
          if (seen.has(l.transactionHash)) return false;
          seen.add(l.transactionHash);
          return true;
        });

        await this.handleConfirmedLogs(relevant);
      } catch (err) {
        this.logger.warn({ err, start, end }, "backfill chunk failed");
      }
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  emitAndRecord(event: RawTxEvent): void {
    this.lastEventTs = Date.now();
    this.bus.emit("raw-tx", event);
    void this.recorder.record(event);
  }
}
