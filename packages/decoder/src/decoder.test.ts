import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventBus } from "@tradebot/core";
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

  it("emits no signal-voided when a reverted tx has no pending mempool signal", async () => {
    const { Decoder } = await import("./decoder.js");
    const bus = new EventBus();
    const decoder = new Decoder({ bus, db: {} as never, wallets: [WALLET], rpcUrls: { eth: "http://0.0.0.0:1", base: "http://0.0.0.0:1" } });
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
    const decoder = new Decoder({ bus, db: {} as never, wallets: [WALLET], rpcUrls: { eth: "http://0.0.0.0:1", base: "http://0.0.0.0:1" } });
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
    const decoder = new Decoder({ bus, db: {} as never, wallets: [WALLET], rpcUrls: { eth: "http://0.0.0.0:1", base: "http://0.0.0.0:1" } });
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
  });
});
