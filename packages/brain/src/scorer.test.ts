import { describe, expect, it, vi } from "vitest";
import { NATIVE_TOKEN_PLACEHOLDER, WETH } from "@tradebot/core";
import { baselineWeightForTradeCount, resolveQuoteUsdPrice } from "./scorer.js";

describe("baselineWeightForTradeCount", () => {
  it("uses 0.5 weight while the leader has fewer than five trades", () => {
    expect(baselineWeightForTradeCount(0)).toBe(0.5);
    expect(baselineWeightForTradeCount(4)).toBe(0.5);
  });

  it("uses neutral 1.0 weight once the leader reaches five trades", () => {
    expect(baselineWeightForTradeCount(5)).toBe(1.0);
    expect(baselineWeightForTradeCount(20)).toBe(1.0);
  });
});

describe("resolveQuoteUsdPrice", () => {
  const db = {} as never;
  const rpcClient = { readContract: vi.fn() };
  const baseCbBtc = "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf";

  it("keeps stablecoin quotes fixed at $1", async () => {
    const latestMarkLookup = vi.fn();
    const quotePriceLookup = vi.fn();

    await expect(resolveQuoteUsdPrice({
      db,
      chain: "base",
      address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      latestMarkLookup,
      quotePriceLookup,
    })).resolves.toBe(1);

    expect(latestMarkLookup).not.toHaveBeenCalled();
    expect(quotePriceLookup).not.toHaveBeenCalled();
  });

  it("prices cbBTC through live pricing instead of treating it as $1", async () => {
    const latestMarkLookup = vi.fn().mockResolvedValue(null);
    const quotePriceLookup = vi.fn().mockResolvedValue(102_500);

    await expect(resolveQuoteUsdPrice({
      db,
      chain: "base",
      address: baseCbBtc,
      rpcClient,
      latestMarkLookup,
      quotePriceLookup,
    })).resolves.toBe(102_500);

    expect(quotePriceLookup).toHaveBeenCalledWith("base", baseCbBtc, rpcClient);
  });

  it("uses a WETH mark for native ETH quote placeholders without requiring an open WETH position", async () => {
    const latestMarkLookup = vi.fn().mockResolvedValue({ priceUsd: 3_400 });
    const quotePriceLookup = vi.fn();

    await expect(resolveQuoteUsdPrice({
      db,
      chain: "eth",
      address: NATIVE_TOKEN_PLACEHOLDER,
      latestMarkLookup,
      quotePriceLookup,
    })).resolves.toBe(3_400);

    expect(latestMarkLookup).toHaveBeenCalledWith(db, "eth", WETH.eth);
    expect(quotePriceLookup).not.toHaveBeenCalled();
  });

  it("returns null for non-stable quotes when neither marks nor live pricing are available", async () => {
    await expect(resolveQuoteUsdPrice({
      db,
      chain: "base",
      address: baseCbBtc,
      latestMarkLookup: vi.fn().mockResolvedValue(null),
      quotePriceLookup: vi.fn().mockResolvedValue(null),
    })).resolves.toBeNull();
  });
});
