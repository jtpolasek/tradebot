import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventBus, NATIVE_TOKEN_PLACEHOLDER } from "@tradebot/core";
import type { TradeSignal, RawTxEvent } from "@tradebot/core";
import { classifySide } from "./decoder.js";
import { SignalDeduper } from "./deduper.js";

// ---------------------------------------------------------------------------
// classifySide — exported for testing
// ---------------------------------------------------------------------------

const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const MEME1 = "0x1111111111111111111111111111111111111111";
const MEME2 = "0x2222222222222222222222222222222222222222";

describe("classifySide", () => {
  it("returns 'buy' when tokenIn is a quote asset (spending USDC for meme)", () => {
    expect(classifySide("eth", USDC, MEME1)).toBe("buy");
  });

  it("returns 'buy' when tokenIn is WETH", () => {
    expect(classifySide("eth", WETH, MEME1)).toBe("buy");
  });

  it("returns 'sell' when tokenOut is a quote asset (selling meme for USDC)", () => {
    expect(classifySide("eth", MEME1, USDC)).toBe("sell");
  });

  it("returns null when both tokens are quote assets (stable rotation — skip)", () => {
    expect(classifySide("eth", USDC, WETH)).toBeNull();
  });

  it("returns 'both' when neither token is a quote asset", () => {
    expect(classifySide("eth", MEME1, MEME2)).toBe("both");
  });

  it("treats native ETH placeholder (empty string) as a quote asset", () => {
    // tokenIn = native ETH (empty address), tokenOut = meme → buy
    expect(classifySide("eth", "", MEME1)).toBe("buy");
  });

  it("treats native ETH placeholder address as a Base buy quote asset", () => {
    expect(classifySide("base", NATIVE_TOKEN_PLACEHOLDER, MEME1)).toBe("buy");
  });
});

// ---------------------------------------------------------------------------
// SignalDeduper — deduplication logic
// ---------------------------------------------------------------------------

function makeSignal(overrides: Partial<TradeSignal> = {}): TradeSignal {
  return {
    id: "signal-1",
    chain: "eth",
    walletId: "0xaaa",
    txHash: "0xabc123",
    source: "mempool",
    side: "buy",
    tokenIn: { chain: "eth", address: WETH, symbol: "WETH", decimals: 18 },
    tokenOut: { chain: "eth", address: MEME1, symbol: "MEME", decimals: 18 },
    amountIn: 1_000_000_000_000_000_000n,
    amountOut: 1_000_000n,
    venue: "uniswap-v2",
    observedAt: Date.now(),
    confirmedAt: null,
    blockNumber: null,
    decodeStatus: "decoded",
    ...overrides,
  };
}

function makeEvent(overrides: Partial<RawTxEvent> = {}): RawTxEvent {
  return {
    chain: "eth",
    source: "confirmed",
    txHash: "0xabc123",
    from: "0xaaa",
    to: "0xbbb",
    blockNumber: 100,
    observedAt: Date.now(),
    status: "success",
    ...overrides,
  };
}

describe("SignalDeduper", () => {
  let deduper: SignalDeduper;

  beforeEach(() => {
    deduper = new SignalDeduper();
  });

  it("resolveConfirmed returns 'new' when no pending mempool signal exists", () => {
    const signal = makeSignal({ source: "confirmed" });
    const event = makeEvent();
    expect(deduper.resolveConfirmed(event, signal)).toEqual({ action: "new" });
  });

  it("resolveConfirmed returns 'update' with original when mempool signal was tracked", () => {
    const mempool = makeSignal({ source: "mempool" });
    deduper.trackMempool(mempool);

    const confirmed = makeSignal({ source: "confirmed" });
    const event = makeEvent();
    const result = deduper.resolveConfirmed(event, confirmed);

    expect(result.action).toBe("update");
    expect((result as { action: "update"; original: TradeSignal }).original.id).toBe("signal-1");
  });

  it("resolveConfirmed cleans up the pending entry after resolving", () => {
    const mempool = makeSignal();
    deduper.trackMempool(mempool);

    const event = makeEvent();
    deduper.resolveConfirmed(event, makeSignal({ source: "confirmed" }));

    // Second call for the same txHash → no longer pending
    expect(deduper.resolveConfirmed(event, makeSignal({ source: "confirmed" }))).toEqual({ action: "new" });
  });

  it("tracks and resolves multiple pending signals for one transaction", () => {
    const sell = makeSignal({ id: "signal-sell", side: "sell", tokenIn: { chain: "eth", address: MEME1, symbol: "M1", decimals: 18 }, tokenOut: { chain: "eth", address: MEME2, symbol: "M2", decimals: 18 } });
    const buy = makeSignal({ id: "signal-buy", side: "buy", tokenIn: { chain: "eth", address: MEME1, symbol: "M1", decimals: 18 }, tokenOut: { chain: "eth", address: MEME2, symbol: "M2", decimals: 18 } });
    deduper.trackMempoolWithNonce(sell, "0xaaa", 42);
    deduper.trackMempoolWithNonce(buy, "0xaaa", 42);

    expect(deduper.pendingCount).toBe(2);

    const confirmedBuy = makeSignal({ source: "confirmed", side: "buy", tokenIn: buy.tokenIn, tokenOut: buy.tokenOut });
    const buyResult = deduper.resolveConfirmed(makeEvent(), confirmedBuy);
    expect(buyResult.action).toBe("update");
    expect((buyResult as { action: "update"; original: TradeSignal }).original.id).toBe("signal-buy");
    expect(deduper.pendingCount).toBe(1);

    const confirmedSell = makeSignal({ source: "confirmed", side: "sell", tokenIn: sell.tokenIn, tokenOut: sell.tokenOut });
    const sellResult = deduper.resolveConfirmed(makeEvent(), confirmedSell);
    expect(sellResult.action).toBe("update");
    expect((sellResult as { action: "update"; original: TradeSignal }).original.id).toBe("signal-sell");
    expect(deduper.pendingCount).toBe(0);
  });

  it("resolveReverted returns the pending signal and removes it", () => {
    const mempool = makeSignal();
    deduper.trackMempool(mempool);

    const revertedEvent = makeEvent({ status: "reverted" });
    const voided = deduper.resolveReverted(revertedEvent);

    expect(voided).not.toBeNull();
    expect(voided!.id).toBe("signal-1");
    // Now gone
    expect(deduper.resolveReverted(revertedEvent)).toBeNull();
  });

  it("resolveReverted returns null when no pending signal exists", () => {
    expect(deduper.resolveReverted(makeEvent({ status: "reverted" }))).toBeNull();
  });

  it("resolveReplaced returns the signal when same from+nonce arrives with a different hash", () => {
    const mempool = makeSignal({ txHash: "0xoriginal" });
    deduper.trackMempoolWithNonce(mempool, "0xaaa", 42);

    // Different txHash, same from+nonce
    const replaced = deduper.resolveReplaced("eth", "0xaaa", 42);
    expect(replaced).not.toBeNull();
    expect(replaced!.txHash).toBe("0xoriginal");
  });

  it("resolveReplaced returns null for a different nonce", () => {
    const mempool = makeSignal({ txHash: "0xoriginal" });
    deduper.trackMempoolWithNonce(mempool, "0xaaa", 42);

    expect(deduper.resolveReplaced("eth", "0xaaa", 99)).toBeNull();
  });

  it("hasPending returns correct state before and after resolution", () => {
    const mempool = makeSignal();
    expect(deduper.hasPending("eth", "0xabc123")).toBe(false);

    deduper.trackMempool(mempool);
    expect(deduper.hasPending("eth", "0xabc123")).toBe(true);

    deduper.resolveConfirmed(makeEvent(), makeSignal({ source: "confirmed" }));
    expect(deduper.hasPending("eth", "0xabc123")).toBe(false);
  });

  it("evicts mempool signals that never confirm (TTL prune)", () => {
    let clock = 1_000_000;
    const ttlDeduper = new SignalDeduper(() => clock);

    // A dropped tx that never confirms.
    ttlDeduper.trackMempoolWithNonce(makeSignal({ txHash: "0xdropped" }), "0xaaa", 1);
    expect(ttlDeduper.pendingCount).toBe(1);

    // Advance past the 15-min TTL + prune interval; the next insert triggers a prune.
    clock += 16 * 60_000;
    ttlDeduper.trackMempool(makeSignal({ txHash: "0xfresh" }));

    // The stale entry is gone (and its nonce mapping too), only the fresh one remains.
    expect(ttlDeduper.pendingCount).toBe(1);
    expect(ttlDeduper.hasPending("eth", "0xdropped")).toBe(false);
    expect(ttlDeduper.hasPending("eth", "0xfresh")).toBe(true);
    expect(ttlDeduper.resolveReplaced("eth", "0xaaa", 1)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Decoder class — signal emission and void dispatch
// ---------------------------------------------------------------------------

vi.mock("@tradebot/store", () => ({
  getToken: vi.fn().mockResolvedValue(null),
  upsertToken: vi.fn().mockResolvedValue(undefined),
  getDb: vi.fn().mockReturnValue({}),
  closeDb: vi.fn(),
}));

vi.mock("./tokenMetadata.js", () => ({
  TokenMetadataResolver: vi.fn().mockImplementation(() => ({
    resolve: vi.fn().mockImplementation((_chain: string, addr: string) => {
      const known: Record<string, { symbol: string; name: string; decimals: number }> = {
        [WETH]: { symbol: "WETH", name: "Wrapped Ether", decimals: 18 },
        [USDC]: { symbol: "USDC", name: "USD Coin", decimals: 6 },
      };
      return Promise.resolve(known[addr.toLowerCase()] ?? { symbol: "MOCK", name: "Mock", decimals: 18 });
    }),
  })),
}));

async function tick(ms = 100) {
  await new Promise((r) => setTimeout(r, ms));
}

describe("Decoder class", () => {
  const WALLET = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
  const WALLET_ID = "11111111-1111-1111-1111-111111111111";

  it("emits no signal-voided when a reverted tx has no pending mempool signal", async () => {
    const { Decoder } = await import("./decoder.js");
    const bus = new EventBus();
    const decoder = new Decoder({ bus, db: {} as never, wallets: [{ address: WALLET, id: WALLET_ID, chain: "eth" }], rpcUrls: { eth: "http://0.0.0.0:1", base: "http://0.0.0.0:1" } });
    decoder.start();

    const voided: unknown[] = [];
    bus.on("signal-voided", (v) => voided.push(v));

    bus.emit("raw-tx", {
      chain: "eth", source: "confirmed", txHash: "0x111", from: WALLET, to: "0x1",
      blockNumber: 1, observedAt: Date.now(), status: "reverted",
    });

    await tick();
    expect(voided).toHaveLength(0);
  });

  it("ignores raw-tx events from untracked wallets", async () => {
    const { Decoder } = await import("./decoder.js");
    const bus = new EventBus();
    const decoder = new Decoder({ bus, db: {} as never, wallets: [{ address: WALLET, id: WALLET_ID, chain: "eth" }], rpcUrls: { eth: "http://0.0.0.0:1", base: "http://0.0.0.0:1" } });
    decoder.start();

    const signals: unknown[] = [];
    bus.on("trade-signal", (s) => signals.push(s));

    bus.emit("raw-tx", {
      chain: "eth", source: "confirmed", txHash: "0x222", from: "0x9999999999999999999999999999999999999999", to: "0x1",
      blockNumber: 2, observedAt: Date.now(), status: "success",
    });

    await tick();
    expect(signals).toHaveLength(0);
  });

  it("emits trade-signal for a confirmed tx with recognisable Transfer logs (Strategy B buy)", async () => {
    const { Decoder } = await import("./decoder.js");
    const bus = new EventBus();
    const decoder = new Decoder({ bus, db: {} as never, wallets: [{ address: WALLET, id: WALLET_ID, chain: "eth" }], rpcUrls: { eth: "http://0.0.0.0:1", base: "http://0.0.0.0:1" } });
    decoder.start();

    const signals: TradeSignal[] = [];
    bus.on("trade-signal", (s) => signals.push(s));

    const ROUTER = "0xcccccccccccccccccccccccccccccccccccccccc";
    const MEME   = "0x4444444444444444444444444444444444444444";
    const padded = (addr: string) => `0x000000000000000000000000${addr.slice(2)}`;
    const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

    // Wallet sends WETH to router, receives MEME from router — pure Transfer logs, no Swap event
    const logs = [
      {
        address: WETH,
        topics: [TRANSFER, padded(WALLET), padded(ROUTER)],
        data: "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000", // 1 WETH
      },
      {
        address: MEME,
        topics: [TRANSFER, padded(ROUTER), padded(WALLET)],
        data: "0x000000000000000000000000000000000000000000003635c9adc5dea00000", // some MEME
      },
    ];

    const event: RawTxEvent = {
      chain: "eth", source: "confirmed", txHash: "0x333", from: WALLET, to: ROUTER,
      blockNumber: 3, observedAt: Date.now(), status: "success", logs,
    };

    bus.emit("raw-tx", event);
    await tick();

    expect(signals).toHaveLength(1);
    expect(signals[0]!.side).toBe("buy"); // spent WETH (quote) for MEME
    expect(signals[0]!.tokenIn.address).toBe(WETH);
    expect(signals[0]!.tokenOut.address).toBe(MEME);
    expect(signals[0]!.venue).toBe("balance-delta");
    expect(signals[0]!.walletId).toBe(WALLET_ID); // carries the DB UUID, never the raw address
  });

  it("emits sell and buy signals when both Strategy B tokens are non-quote assets", async () => {
    const { Decoder } = await import("./decoder.js");
    const bus = new EventBus();
    const decoder = new Decoder({ bus, db: {} as never, wallets: [{ address: WALLET, id: WALLET_ID, chain: "eth" }], rpcUrls: { eth: "http://0.0.0.0:1", base: "http://0.0.0.0:1" } });
    decoder.start();

    const signals: TradeSignal[] = [];
    bus.on("trade-signal", (s) => signals.push(s));

    const ROUTER = "0xcccccccccccccccccccccccccccccccccccccccc";
    const padded = (addr: string) => `0x000000000000000000000000${addr.slice(2)}`;
    const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

    const logs = [
      {
        address: MEME1,
        topics: [TRANSFER, padded(WALLET), padded(ROUTER)],
        data: "0x0000000000000000000000000000000000000000000000056bc75e2d63100000",
      },
      {
        address: MEME2,
        topics: [TRANSFER, padded(ROUTER), padded(WALLET)],
        data: "0x00000000000000000000000000000000000000000000000ad78ebc5ac6200000",
      },
    ];

    bus.emit("raw-tx", {
      chain: "eth", source: "confirmed", txHash: "0x334", from: WALLET, to: ROUTER,
      blockNumber: 3, observedAt: Date.now(), status: "success", logs,
    });
    await tick();

    expect(signals).toHaveLength(2);
    expect(signals.map((signal) => signal.side).sort()).toEqual(["buy", "sell"]);
    expect(new Set(signals.map((signal) => signal.id)).size).toBe(2);
    for (const signal of signals) {
      expect(signal.tokenIn.address).toBe(MEME1);
      expect(signal.tokenOut.address).toBe(MEME2);
      expect(signal.venue).toBe("balance-delta");
      expect(signal.walletId).toBe(WALLET_ID);
    }
  });

  it("tags a clean balance-delta buy as decoded and persists a candidate for an ambiguous tx", async () => {
    const { Decoder } = await import("./decoder.js");
    const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
    const ROUTER = "0xcccccccccccccccccccccccccccccccccccccccc";
    const padded = (addr: string) => `0x000000000000000000000000${addr.slice(2)}`;
    const ONE_WETH = "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000";
    const SOME_MEME = "0x00000000000000000000000000000000000000000000003635c9adc5dea00000";
    const SOME_MEME2 = "0x0000000000000000000000000000000000000000000000056bc75e2d63100000";
    const SOME_USDC = "0x000000000000000000000000000000000000000000000000000000003b9aca00";

    // Clean buy: spend WETH (quote) for MEME1 → decoded.
    {
      const bus = new EventBus();
      const decoder = new Decoder({ bus, db: {} as never, wallets: [{ address: WALLET, id: WALLET_ID, chain: "eth" }], rpcUrls: { eth: "http://0.0.0.0:1", base: "http://0.0.0.0:1" } });
      decoder.start();

      const signals: TradeSignal[] = [];
      bus.on("trade-signal", (s) => signals.push(s));
      bus.emit("raw-tx", {
        chain: "eth", source: "confirmed", txHash: "0x501", from: WALLET, to: ROUTER,
        blockNumber: 5, observedAt: Date.now(), status: "success",
        logs: [
          { address: WETH, topics: [TRANSFER, padded(WALLET), padded(ROUTER)], data: ONE_WETH },
          { address: MEME1, topics: [TRANSFER, padded(ROUTER), padded(WALLET)], data: SOME_MEME },
        ],
      });
      await tick();

      expect(signals).toHaveLength(1);
      expect(signals[0]!.decodeStatus).toBe("decoded");
    }

    // Ambiguous tx carrying both a buy shape (WETH→MEME2) and a sell shape (MEME1→USDC).
    // This was previously dropped; it must now be persisted as a candidate.
    {
      const bus = new EventBus();
      const decoder = new Decoder({ bus, db: {} as never, wallets: [{ address: WALLET, id: WALLET_ID, chain: "eth" }], rpcUrls: { eth: "http://0.0.0.0:1", base: "http://0.0.0.0:1" } });
      decoder.start();

      const signals: TradeSignal[] = [];
      bus.on("trade-signal", (s) => signals.push(s));
      bus.emit("raw-tx", {
        chain: "eth", source: "confirmed", txHash: "0x502", from: WALLET, to: ROUTER,
        blockNumber: 5, observedAt: Date.now(), status: "success",
        logs: [
          { address: WETH, topics: [TRANSFER, padded(WALLET), padded(ROUTER)], data: ONE_WETH },
          { address: MEME1, topics: [TRANSFER, padded(WALLET), padded(ROUTER)], data: SOME_MEME2 },
          { address: USDC, topics: [TRANSFER, padded(ROUTER), padded(WALLET)], data: SOME_USDC },
          { address: MEME2, topics: [TRANSFER, padded(ROUTER), padded(WALLET)], data: SOME_MEME },
        ],
      });
      await tick();

      expect(signals.length).toBeGreaterThanOrEqual(1);
      expect(signals.every((s) => s.decodeStatus === "candidate")).toBe(true);
    }
  });

  it("skips a tracked address that has no resolved wallet id (no bad FK)", async () => {
    const { Decoder } = await import("./decoder.js");
    const bus = new EventBus();
    // setWallets with an address-only identity leaves the id map without this address.
    const decoder = new Decoder({ bus, db: {} as never, wallets: [], rpcUrls: { eth: "http://0.0.0.0:1", base: "http://0.0.0.0:1" } });
    (decoder as unknown as { wallets: Set<string> }).wallets = new Set([`eth:${WALLET}`]);
    decoder.start();

    const signals: unknown[] = [];
    bus.on("trade-signal", (s) => signals.push(s));

    bus.emit("raw-tx", {
      chain: "eth", source: "confirmed", txHash: "0x444", from: WALLET, to: "0x1",
      blockNumber: 4, observedAt: Date.now(), status: "success",
    });

    await tick();
    expect(signals).toHaveLength(0);
  });

  it("decodes a token→ETH sell from a WETH Withdrawal log (no ERC-20 inbound)", async () => {
    const { Decoder } = await import("./decoder.js");
    const bus = new EventBus();
    const decoder = new Decoder({ bus, db: {} as never, wallets: [{ address: WALLET, id: WALLET_ID, chain: "eth" }], rpcUrls: { eth: "http://0.0.0.0:1", base: "http://0.0.0.0:1" } });
    decoder.start();

    const signals: TradeSignal[] = [];
    bus.on("trade-signal", (s) => signals.push(s));

    const ROUTER = "0xcccccccccccccccccccccccccccccccccccccccc";
    const MEME = "0x4444444444444444444444444444444444444444";
    const padded = (addr: string) => `0x000000000000000000000000${addr.slice(2)}`;
    const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
    const WITHDRAWAL = "0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65";

    // Wallet sends MEME to router; router unwraps WETH and sends raw ETH back (Withdrawal log,
    // no ERC-20 inbound Transfer to the wallet).
    const logs = [
      {
        address: MEME,
        topics: [TRANSFER, padded(WALLET), padded(ROUTER)],
        data: "0x000000000000000000000000000000000000000000003635c9adc5dea00000",
      },
      {
        address: WETH,
        topics: [WITHDRAWAL, padded(ROUTER)],
        data: "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000", // 1 WETH
      },
    ];

    const event: RawTxEvent = {
      chain: "eth", source: "confirmed", txHash: "0x444", from: WALLET, to: ROUTER,
      blockNumber: 4, observedAt: Date.now(), status: "success", logs,
    };

    bus.emit("raw-tx", event);
    await tick();

    expect(signals).toHaveLength(1);
    expect(signals[0]!.side).toBe("sell"); // sold MEME for ETH
    expect(signals[0]!.tokenIn.address).toBe(MEME);
    expect(signals[0]!.tokenOut.address).toBe(WETH);
    expect(signals[0]!.venue).toBe("balance-delta");
  });
});
