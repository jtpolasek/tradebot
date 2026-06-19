import { createPublicClient, http } from "viem";
import { mainnet, base } from "viem/chains";
import PQueue from "p-queue";
import { createLogger, fromBaseUnits, isEvmChain, isQuoteAsset, NATIVE_TOKEN_PLACEHOLDER, WETH } from "@tradebot/core";
import type { EventBus, RawTxEvent, TradeSignal, ChainId, EvmChainId } from "@tradebot/core";
import type { Db } from "@tradebot/store";
import { getActiveWallets } from "@tradebot/store";
import { TokenMetadataResolver } from "./tokenMetadata.js";

/** A tracked wallet's address + its DB UUID + chain, so signals carry a valid FK per chain. */
export type WalletIdentity = { address: string; id: string; chain: ChainId };

const WALLET_RELOAD_MS = 60_000;
import { strategyA } from "./strategyA.js";
import { strategyC } from "./strategyC.js";
import { analyzePairs } from "./balanceDelta.js";
import { SignalDeduper } from "./deduper.js";
import { TRANSFER_TOPIC, WETH_WITHDRAWAL_TOPIC, VENUE_TOPIC_MAP } from "./venues.js";
import type { NormalizedTransfer, BalanceDeltaResult } from "./types.js";
import type { StrategyAClients } from "./strategyA.js";

const logger = createLogger("decoder");

type DecoderOpts = {
  bus: EventBus;
  db: Db;
  wallets: WalletIdentity[];
  /** Override RPC URLs for testing; defaults to Alchemy from env */
  rpcUrls?: { eth?: string; base?: string };
};

export class Decoder {
  private readonly bus: EventBus;
  private readonly db: Db;
  private wallets: Set<string>;
  private walletIds = new Map<string, string>();
  private readonly meta: TokenMetadataResolver;
  private readonly rpcClients: StrategyAClients;
  private readonly deduper = new SignalDeduper();
  private readonly queue = new PQueue({ concurrency: 4 });
  private walletReloadTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: DecoderOpts) {
    this.bus = opts.bus;
    this.db = opts.db;
    this.wallets = new Set();
    this.applyWallets(opts.wallets);

    const ethUrl = opts.rpcUrls?.eth ?? `https://eth-mainnet.g.alchemy.com/v2/${process.env["ALCHEMY_API_KEY"] ?? ""}`;
    const baseUrl = opts.rpcUrls?.base ?? `https://base-mainnet.g.alchemy.com/v2/${process.env["BASE_ALCHEMY_API_KEY"] ?? process.env["ALCHEMY_API_KEY"] ?? ""}`;

    const ethClient = createPublicClient({ chain: mainnet, transport: http(ethUrl) });
    const baseClient = createPublicClient({ chain: base, transport: http(baseUrl) });
    this.rpcClients = { eth: ethClient, base: baseClient };
    this.meta = new TokenMetadataResolver(this.db, { eth: ethClient, base: baseClient });
  }

  start(): void {
    this.bus.on("raw-tx", (event) => {
      void this.handleRawTx(event);
    });
    const timer = setInterval(() => void this.reloadWallets(), WALLET_RELOAD_MS);
    timer.unref?.();
    this.walletReloadTimer = timer;
    logger.info("Decoder started");
  }

  stop(): void {
    if (this.walletReloadTimer) {
      clearInterval(this.walletReloadTimer);
      this.walletReloadTimer = null;
    }
    logger.info("Decoder stopped");
  }

  /** Replace the tracked wallet set + id map (Phase 6 hot-reload). */
  setWallets(wallets: WalletIdentity[]): void {
    this.applyWallets(wallets);
  }

  private applyWallets(wallets: WalletIdentity[]): void {
    const next = new Set<string>();
    const nextIds = new Map<string, string>();
    for (const w of wallets) {
      if (!isEvmChain(w.chain)) continue;
      // Key by chain:address so an address tracked on both chains resolves to the right UUID.
      const key = `${w.chain}:${w.address.toLowerCase()}`;
      next.add(key);
      nextIds.set(key, w.id);
    }
    this.wallets = next;
    this.walletIds = nextIds;
  }

  /** Poll the DB so wallets added at runtime start producing signals without a restart. */
  private async reloadWallets(): Promise<void> {
    try {
      const wallets = await getActiveWallets(this.db);
      this.applyWallets(wallets.map((w) => ({ address: w.address, id: w.id, chain: w.chain })));
    } catch (err) {
      logger.warn({ err }, "wallet reload failed");
    }
  }

  private async handleRawTx(event: RawTxEvent): Promise<void> {
    const addr = event.from.toLowerCase();
    const walletKey = `${event.chain}:${addr}`;
    const wallet = this.wallets.has(walletKey) ? addr : null;
    if (!wallet) return;
    const walletId = this.walletIds.get(walletKey);
    if (!walletId) {
      // Tracked address with no resolved UUID — skip rather than write a bad FK.
      logger.warn({ chain: event.chain, wallet }, "no wallet id for tracked address — skipping");
      return;
    }

    try {
      if (event.status === "reverted") {
        const voidedSignals = this.deduper.resolveRevertedAll(event);
        for (const voided of voidedSignals) {
          this.bus.emit("signal-voided", { signalId: voided.id, reason: "reverted" });
        }
        return;
      }

      if (event.source === "mempool") {
        await this.handleMempool(event, wallet, walletId);
        return;
      }

      if (event.source === "confirmed") {
        // Check for replaced tx (same from+nonce, different hash)
        if (event.nonce !== undefined) {
          const replacedSignals = this.deduper.resolveReplacedAll(event.chain, event.from, event.nonce, event.txHash);
          for (const replaced of replacedSignals) {
            if (replaced.txHash !== event.txHash) {
              this.bus.emit("signal-voided", { signalId: replaced.id, reason: "replaced" });
            }
          }
        }
        await this.handleConfirmed(event, wallet, walletId);
      }
    } catch (err) {
      logger.error({ err, txHash: event.txHash }, "Error processing raw-tx");
    }
  }

  private async handleMempool(event: RawTxEvent, wallet: string, walletId: string): Promise<void> {
    const result = await strategyC(event, wallet, this.meta);
    if (!result) return;

    const signals = this.buildSignals(event, wallet, walletId, result);
    if (signals.length === 0) return;

    for (const signal of signals) {
      this.deduper.trackMempoolWithNonce(signal, event.from, event.nonce ?? 0);
      this.bus.emit("trade-signal", signal);

      this.queue.add(() => this.persistSignal(signal));
    }
  }

  private async handleConfirmed(event: RawTxEvent, wallet: string, walletId: string): Promise<void> {
    // Try Strategy A first
    const aResult = await strategyA(event, wallet, this.meta, crypto.randomUUID(), this.rpcClients);
    if (aResult) {
      const signals = this.buildSignals(event, wallet, walletId, aResult);
      if (signals.length > 0) {
        for (const signal of signals) {
          await this.resolveAndEmitConfirmed(event, signal);
        }
        return;
      }
    }

    // Fall through to Strategy B (balance delta)
    const bSignals = await this.runStrategyB(event, wallet, walletId);
    for (const signal of bSignals) {
      await this.resolveAndEmitConfirmed(event, signal);
    }
  }

  private async resolveAndEmitConfirmed(event: RawTxEvent, signal: TradeSignal): Promise<void> {
    const resolution = this.deduper.resolveConfirmed(event, signal);
    if (resolution.action === "update") {
      const updated: TradeSignal = {
        ...signal,
        id: resolution.original.id,
        source: "confirmed",
        confirmedAt: Date.now(),
        blockNumber: event.blockNumber,
      };
      this.bus.emit("signal-confirmed", { signalId: resolution.original.id, confirmed: updated });
      this.queue.add(() => this.persistSignal(updated));
    } else {
      this.bus.emit("trade-signal", signal);
      this.queue.add(() => this.persistSignal(signal));
    }
  }

  private async runStrategyB(
    event: RawTxEvent,
    wallet: string,
    walletId: string
  ): Promise<TradeSignal[]> {
    if (!event.logs) return [];

    const padded = (addr: string) => addr.replace("0x", "0x000000000000000000000000").toLowerCase();
    const paddedWallet = padded(wallet);

    const transferLogs = event.logs.filter((l) => l.topics[0]?.toLowerCase() === TRANSFER_TOPIC);

    // Build outbound/inbound transfers for the wallet
    const outboundRaw = transferLogs.filter((l) => l.topics[1]?.toLowerCase() === paddedWallet);
    const inboundRaw = transferLogs.filter((l) => l.topics[2]?.toLowerCase() === paddedWallet);

    // Resolve token metadata for all unique addresses
    const tokenAddrs = new Set([
      ...outboundRaw.map((l) => l.address.toLowerCase()),
      ...inboundRaw.map((l) => l.address.toLowerCase()),
    ]);
    const metaMap = new Map<string, { symbol: string; decimals: number }>();
    await Promise.all(
      [...tokenAddrs].map(async (addr) => {
        const m = await this.meta.resolve(event.chain, addr).catch(() => ({ symbol: "UNKNOWN", name: "Unknown", decimals: 18 }));
        metaMap.set(addr, m);
      })
    );

    const toTransfer = (log: typeof event.logs[number], direction: "in" | "out"): NormalizedTransfer => {
      const addr = log.address.toLowerCase();
      const m = metaMap.get(addr) ?? { symbol: "UNKNOWN", decimals: 18 };
      // amount is in log.data (uint256)
      const amountRaw = log.data && log.data !== "0x" ? BigInt(log.data) : 0n;
      const amountHuman = fromBaseUnits(amountRaw, m.decimals);
      return { tokenAddress: addr, symbol: m.symbol, decimals: m.decimals, amountRaw, amountHuman, direction };
    };

    const outbound = outboundRaw.map((l) => toTransfer(l, "out"));
    let inbound = inboundRaw.map((l) => toTransfer(l, "in"));

    // Handle native ETH: if event.valueWei > 0 and wallet is sender
    if (event.valueWei && event.valueWei > 0n && event.from.toLowerCase() === wallet) {
      outbound.push({
        tokenAddress: "",
        symbol: "ETH",
        decimals: 18,
        amountRaw: event.valueWei,
        amountHuman: fromBaseUnits(event.valueWei, 18),
        direction: "out",
      });
    }

    // Native ETH received: routers unwrap WETH→ETH and send raw ETH to the wallet, which produces
    // no ERC-20 Transfer log. Detect it via WETH Withdrawal events when the wallet received no
    // token (i.e. a token→ETH sell). This is the workhorse path for sells into native ETH.
    if (inbound.length === 0 && outbound.length > 0) {
      const wethAddr = WETH[event.chain];
      let withdrawnWad = 0n;
      for (const l of event.logs) {
        if (l.topics[0]?.toLowerCase() === WETH_WITHDRAWAL_TOPIC && l.address.toLowerCase() === wethAddr) {
          withdrawnWad += l.data && l.data !== "0x" ? BigInt(l.data) : 0n;
        }
      }
      if (withdrawnWad > 0n) {
        inbound = [{
          tokenAddress: wethAddr,
          symbol: "WETH",
          decimals: 18,
          amountRaw: withdrawnWad,
          amountHuman: fromBaseUnits(withdrawnWad, 18),
          direction: "in",
        }];
      }
    }

    if (outbound.length === 0 || inbound.length === 0) return [];

    const result = analyzePairs(outbound, inbound);
    if (result.status === "skipped") return [];
    if (!result.tokenIn || !result.tokenOut) return [];

    // Ambiguous decodes (including mixed buy/sell shapes that analyzePairs flags via
    // ambiguousDirection) are no longer dropped — they're persisted as candidates for human
    // review. The engine refuses to auto-copy anything that isn't decode_status 'decoded', so a
    // wrong-side guess here can't trigger a trade; it only surfaces the missed activity.
    return this.buildSignalsFromDelta(event, walletId, result.tokenIn, result.tokenOut, result);
  }

  private buildSignals(
    event: RawTxEvent,
    _wallet: string,
    walletId: string,
    parts: Pick<TradeSignal, "tokenIn" | "tokenOut" | "amountIn" | "amountOut" | "venue"> &
      Partial<Pick<TradeSignal, "decodeStatus" | "confidence" | "reason" | "poolId">>
  ): TradeSignal[] {
    const { tokenIn, tokenOut, amountIn, amountOut, venue } = parts;
    const side = classifySide(event.chain, tokenIn.address, tokenOut.address);
    if (!side) return []; // stable rotation — skip

    // Capture the V4 poolId for any single-V4-swap tx, even when strategyA bailed and the trade was
    // recovered via balance-delta (e.g. native-ETH-funded buys, where strategyA can't map both
    // sides). Pricing reads it back to value V4-only tokens. strategyA's own poolId wins if present.
    const poolId = parts.poolId ?? extractV4PoolId(event);

    const makeSignal = (signalSide: "buy" | "sell"): TradeSignal => ({
      id: crypto.randomUUID(),
      chain: event.chain,
      walletId,
      txHash: event.txHash,
      source: event.source,
      side: signalSide,
      tokenIn,
      tokenOut,
      amountIn,
      amountOut,
      venue,
      observedAt: event.observedAt,
      confirmedAt: event.source === "confirmed" ? Date.now() : null,
      blockNumber: event.blockNumber,
      blockTimestamp: event.blockTimestamp ?? null,
      decodeStatus: parts.decodeStatus ?? "decoded",
      confidence: parts.confidence ?? null,
      reason: parts.reason ?? null,
      poolId: poolId ?? null,
    });

    return side === "both" ? [makeSignal("sell"), makeSignal("buy")] : [makeSignal(side)];
  }

  private buildSignalsFromDelta(
    event: RawTxEvent,
    walletId: string,
    tokenIn: NormalizedTransfer,
    tokenOut: NormalizedTransfer,
    result: BalanceDeltaResult
  ): TradeSignal[] {
    const tokenInRef = { chain: event.chain, address: tokenIn.tokenAddress || NATIVE_TOKEN_PLACEHOLDER, symbol: tokenIn.symbol, decimals: tokenIn.decimals };
    const tokenOutRef = { chain: event.chain, address: tokenOut.tokenAddress || NATIVE_TOKEN_PLACEHOLDER, symbol: tokenOut.symbol, decimals: tokenOut.decimals };

    return this.buildSignals(event, "", walletId, {
      tokenIn: tokenInRef,
      tokenOut: tokenOutRef,
      amountIn: tokenIn.amountRaw,
      amountOut: tokenOut.amountRaw,
      venue: "balance-delta",
      // analyzePairs returns only "decoded" | "candidate" here (skipped already returned above).
      decodeStatus: result.status === "candidate" ? "candidate" : "decoded",
      confidence: result.confidence,
      reason: result.reason,
    });
  }

  private async persistSignal(_signal: TradeSignal): Promise<void> {
    // Persistence via store repositories (Phase 3+ wires this fully)
    // For now just log; DB schema is ready but upsert is deferred
    logger.debug({ txHash: _signal.txHash, side: _signal.side }, "signal ready");
  }
}

type Side = "buy" | "sell" | "both" | null;

/**
 * The Uniswap V4 poolId (the Swap event's indexed `bytes32 id`) when the tx contains exactly one V4
 * Swap log. Multiple V4 swaps (multi-hop / aggregator split) are ambiguous → undefined, matching
 * strategyA's single-swap rule. Mempool events carry no logs, so this is a no-op there.
 */
function extractV4PoolId(event: RawTxEvent): string | undefined {
  if (!event.logs) return undefined;
  const v4Logs = event.logs.filter((l) => {
    const t0 = l.topics[0]?.toLowerCase();
    return t0 !== undefined && VENUE_TOPIC_MAP[t0] === "UNISWAP_V4_SWAP";
  });
  if (v4Logs.length !== 1) return undefined;
  return v4Logs[0]!.topics[1]?.toLowerCase();
}

export function classifySide(chain: EvmChainId, tokenInAddr: string, tokenOutAddr: string): Side {
  const inIsQuote = isQuoteAsset(chain, tokenInAddr) || tokenInAddr === "";
  const outIsQuote = isQuoteAsset(chain, tokenOutAddr) || tokenOutAddr === "";

  if (inIsQuote && outIsQuote) return null; // stable rotation — skip
  if (inIsQuote && !outIsQuote) return "buy"; // spent cash for token
  if (!inIsQuote && outIsQuote) return "sell"; // spent token for cash
  return "both"; // neither is quote — emit two signals
}
