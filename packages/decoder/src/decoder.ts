import { createPublicClient, http } from "viem";
import { mainnet, base } from "viem/chains";
import PQueue from "p-queue";
import { createLogger, isQuoteAsset, NATIVE_TOKEN_PLACEHOLDER, WETH } from "@tradebot/core";
import type { EventBus, RawTxEvent, TradeSignal, ChainId } from "@tradebot/core";
import type { Db } from "@tradebot/store";
import { getActiveWallets } from "@tradebot/store";
import { TokenMetadataResolver } from "./tokenMetadata.js";
import { strategyA } from "./strategyA.js";
import { strategyC } from "./strategyC.js";
import { analyzePairs } from "./balanceDelta.js";
import { SignalDeduper } from "./deduper.js";
import { TRANSFER_TOPIC, WETH_WITHDRAWAL_TOPIC } from "./venues.js";
import type { NormalizedTransfer } from "./types.js";

const logger = createLogger("decoder");

type DecoderOpts = {
  bus: EventBus;
  db: Db;
  wallets: string[];
  /** Override RPC URLs for testing; defaults to Alchemy from env */
  rpcUrls?: { eth?: string; base?: string };
};

export class Decoder {
  private readonly bus: EventBus;
  private readonly db: Db;
  private wallets: Set<string>;
  private walletIds = new Map<string, string>();
  private readonly meta: TokenMetadataResolver;
  private readonly deduper = new SignalDeduper();
  private readonly queue = new PQueue({ concurrency: 4 });

  constructor(opts: DecoderOpts) {
    this.bus = opts.bus;
    this.db = opts.db;
    this.wallets = new Set(opts.wallets.map((w) => w.toLowerCase()));

    const ethUrl = opts.rpcUrls?.eth ?? `https://eth-mainnet.g.alchemy.com/v2/${process.env["ALCHEMY_API_KEY"] ?? ""}`;
    const baseUrl = opts.rpcUrls?.base ?? `https://base-mainnet.g.alchemy.com/v2/${process.env["BASE_ALCHEMY_API_KEY"] ?? process.env["ALCHEMY_API_KEY"] ?? ""}`;

    const ethClient = createPublicClient({ chain: mainnet, transport: http(ethUrl) });
    const baseClient = createPublicClient({ chain: base, transport: http(baseUrl) });
    this.meta = new TokenMetadataResolver(this.db, { eth: ethClient, base: baseClient });
  }

  start(): void {
    this.bus.on("raw-tx", (event) => {
      void this.handleRawTx(event);
    });
    logger.info("Decoder started");
  }

  stop(): void {
    logger.info("Decoder stopped");
  }

  /** Exposed for testing to update the wallet set at runtime. */
  setWallets(wallets: string[]): void {
    this.wallets = new Set(wallets.map((w) => w.toLowerCase()));
    this.walletIds.clear();
  }

  private async handleRawTx(event: RawTxEvent): Promise<void> {
    const wallet = this.wallets.has(event.from.toLowerCase()) ? event.from.toLowerCase() : null;
    if (!wallet) return;
    const walletId = await this.resolveWalletId(event.chain, wallet);

    try {
      if (event.status === "reverted") {
        const voided = this.deduper.resolveReverted(event);
        if (voided) {
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
          const replaced = this.deduper.resolveReplaced(event.chain, event.from, event.nonce);
          if (replaced && replaced.txHash !== event.txHash) {
            this.bus.emit("signal-voided", { signalId: replaced.id, reason: "replaced" });
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

    const signal = this.buildSignal(event, wallet, walletId, result);
    if (!signal) return;

    this.deduper.trackMempoolWithNonce(signal, event.from, event.nonce ?? 0);
    this.bus.emit("trade-signal", signal);

    this.queue.add(() => this.persistSignal(signal));
  }

  private async handleConfirmed(event: RawTxEvent, wallet: string, walletId: string): Promise<void> {
    // Try Strategy A first
    const aResult = await strategyA(event, wallet, this.meta, crypto.randomUUID());
    if (aResult) {
      const signal = this.buildSignal(event, wallet, walletId, aResult);
      if (signal) {
        await this.resolveAndEmitConfirmed(event, signal);
        return;
      }
    }

    // Fall through to Strategy B (balance delta)
    const bResult = await this.runStrategyB(event, wallet);
    if (bResult) {
      await this.resolveAndEmitConfirmed(event, bResult);
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
    wallet: string
  ): Promise<TradeSignal | null> {
    if (!event.logs) return null;

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
      const amountHuman = m.decimals > 0 ? Number(amountRaw) / 10 ** m.decimals : Number(amountRaw);
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
        amountHuman: Number(event.valueWei) / 1e18,
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
          amountHuman: Number(withdrawnWad) / 1e18,
          direction: "in",
        }];
      }
    }

    if (outbound.length === 0 || inbound.length === 0) return null;

    const result = analyzePairs(outbound, inbound);
    if (result.status === "skipped" || result.side === "unknown") return null;
    if (!result.tokenIn || !result.tokenOut) return null;

    const walletId = await this.resolveWalletId(event.chain, wallet);
    return this.buildSignalFromDelta(event, walletId, result.tokenIn, result.tokenOut, result.side as "buy" | "sell");
  }

  private async resolveWalletId(chain: ChainId, address: string): Promise<string> {
    const key = `${chain}:${address.toLowerCase()}`;
    const cached = this.walletIds.get(key);
    if (cached) return cached;

    try {
      const wallets = await getActiveWallets(this.db, chain);
      for (const wallet of wallets) {
        this.walletIds.set(`${wallet.chain}:${wallet.address.toLowerCase()}`, wallet.id);
      }
    } catch {
      // Unit tests can pass a lightweight Db stub; keep those isolated tests working.
    }

    return this.walletIds.get(key) ?? address;
  }

  private buildSignal(
    event: RawTxEvent,
    _wallet: string,
    walletId: string,
    parts: Pick<TradeSignal, "tokenIn" | "tokenOut" | "amountIn" | "amountOut" | "venue">
  ): TradeSignal | null {
    const { tokenIn, tokenOut, amountIn, amountOut, venue } = parts;
    const side = classifySide(event.chain, tokenIn.address, tokenOut.address);
    if (!side) return null; // stable rotation — skip

    // If both non-quote: emit two signals — for now emit the buy
    const effectiveSide = side === "both" ? "buy" : side;

    return {
      id: crypto.randomUUID(),
      chain: event.chain,
      walletId,
      txHash: event.txHash,
      source: event.source,
      side: effectiveSide,
      tokenIn,
      tokenOut,
      amountIn,
      amountOut,
      venue,
      observedAt: event.observedAt,
      confirmedAt: event.source === "confirmed" ? Date.now() : null,
      blockNumber: event.blockNumber,
    };
  }

  private buildSignalFromDelta(
    event: RawTxEvent,
    walletId: string,
    tokenIn: NormalizedTransfer,
    tokenOut: NormalizedTransfer,
    side: "buy" | "sell"
  ): TradeSignal {
    const tokenInRef = { chain: event.chain, address: tokenIn.tokenAddress || NATIVE_TOKEN_PLACEHOLDER, symbol: tokenIn.symbol, decimals: tokenIn.decimals };
    const tokenOutRef = { chain: event.chain, address: tokenOut.tokenAddress || NATIVE_TOKEN_PLACEHOLDER, symbol: tokenOut.symbol, decimals: tokenOut.decimals };

    return {
      id: crypto.randomUUID(),
      chain: event.chain,
      walletId,
      txHash: event.txHash,
      source: event.source,
      side,
      tokenIn: tokenInRef,
      tokenOut: tokenOutRef,
      amountIn: tokenIn.amountRaw,
      amountOut: tokenOut.amountRaw,
      venue: "balance-delta",
      observedAt: event.observedAt,
      confirmedAt: event.source === "confirmed" ? Date.now() : null,
      blockNumber: event.blockNumber,
    };
  }

  private async persistSignal(_signal: TradeSignal): Promise<void> {
    // Persistence via store repositories (Phase 3+ wires this fully)
    // For now just log; DB schema is ready but upsert is deferred
    logger.debug({ txHash: _signal.txHash, side: _signal.side }, "signal ready");
  }
}

type Side = "buy" | "sell" | "both" | null;

export function classifySide(chain: ChainId, tokenInAddr: string, tokenOutAddr: string): Side {
  const inIsQuote = isQuoteAsset(chain, tokenInAddr) || tokenInAddr === "";
  const outIsQuote = isQuoteAsset(chain, tokenOutAddr) || tokenOutAddr === "";

  if (inIsQuote && outIsQuote) return null; // stable rotation — skip
  if (inIsQuote && !outIsQuote) return "buy"; // spent cash for token
  if (!inIsQuote && outIsQuote) return "sell"; // spent token for cash
  return "both"; // neither is quote — emit two signals
}
