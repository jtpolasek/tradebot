import { describe, it, expect, vi } from "vitest";
import { EventBus } from "./bus.js";
import type { RawTxEvent, TradeSignal } from "./types.js";

const rawTx: RawTxEvent = {
  chain: "eth",
  source: "confirmed",
  txHash: "0xabc",
  from: "0x1234567890123456789012345678901234567890",
  to: "0x0987654321098765432109876543210987654321",
  blockNumber: 1,
  observedAt: Date.now(),
};

describe("EventBus", () => {
  it("emits and receives raw-tx events", () => {
    const bus = new EventBus();
    const listener = vi.fn();
    bus.on("raw-tx", listener);
    bus.emit("raw-tx", rawTx);
    expect(listener).toHaveBeenCalledWith(rawTx);
  });

  it("emits and receives trade-signal events", () => {
    const bus = new EventBus();
    const listener = vi.fn();
    const signal: TradeSignal = {
      id: "1",
      chain: "eth",
      walletId: "w1",
      txHash: "0xabc",
      source: "confirmed",
      side: "buy",
      tokenIn: { chain: "eth", address: "0xusdc", symbol: "USDC", decimals: 6 },
      tokenOut: { chain: "eth", address: "0xweth", symbol: "WETH", decimals: 18 },
      amountIn: 1000_000n,
      amountOut: 500_000_000_000_000n,
      venue: "uniswap-v3",
      observedAt: Date.now(),
      confirmedAt: null,
      blockNumber: 100,
      decodeStatus: "decoded",
    };
    bus.on("trade-signal", listener);
    bus.emit("trade-signal", signal);
    expect(listener).toHaveBeenCalledWith(signal);
  });

  it("supports off to remove listeners", () => {
    const bus = new EventBus();
    const listener = vi.fn();
    bus.on("raw-tx", listener);
    bus.off("raw-tx", listener);
    bus.emit("raw-tx", rawTx);
    expect(listener).not.toHaveBeenCalled();
  });

  it("once fires only once", () => {
    const bus = new EventBus();
    const listener = vi.fn();
    bus.once("raw-tx", listener);
    bus.emit("raw-tx", rawTx);
    bus.emit("raw-tx", rawTx);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
