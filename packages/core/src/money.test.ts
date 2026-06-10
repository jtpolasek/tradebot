import { describe, expect, it } from "vitest";
import { formatUsdPrice, normalizeAddressInput, toBaseUnits, fromBaseUnits, normalizeAddress } from "./money.js";

describe("formatUsdPrice", () => {
  it("keeps tiny token prices visible", () => {
    expect(formatUsdPrice(252.89 / 806_939_880.629991)).toBe("$3.134e-7");
  });

  it("formats small non-tiny prices with decimal precision", () => {
    expect(formatUsdPrice(0.012345)).toBe("$0.012345");
  });
});

describe("normalizeAddressInput", () => {
  it("accepts a plain address", () => {
    expect(normalizeAddressInput("0xC5A6bd7693E41b33f7f6FD6De3d82Bd8B124Ad8D")).toBe(
      "0xc5a6bd7693e41b33f7f6fd6de3d82bd8b124ad8d"
    );
  });

  it("extracts an address from a GMGN wallet URL", () => {
    expect(normalizeAddressInput("https://gmgn.ai/base/address/0xc5a6bd7693e41b33f7f6fd6de3d82bd8b124ad8d")).toBe(
      "0xc5a6bd7693e41b33f7f6fd6de3d82bd8b124ad8d"
    );
  });

  it("rejects values without an address", () => {
    expect(() => normalizeAddressInput("https://gmgn.ai/base/address/not-an-address")).toThrow(
      "Enter a valid Ethereum address or GMGN wallet URL."
    );
  });
});

describe("toBaseUnits / fromBaseUnits", () => {
  it("round-trips 1.5 USDC (6 decimals)", () => {
    const raw = toBaseUnits(1.5, 6);
    expect(raw).toBe("1500000");
    expect(fromBaseUnits(raw, 6)).toBe(1.5);
  });

  it("round-trips 0.001 ETH (18 decimals)", () => {
    const raw = toBaseUnits(0.001, 18);
    expect(raw).toBe("1000000000000000");
    expect(fromBaseUnits(raw, 18)).toBe(0.001);
  });

  it("throws on zero amount", () => {
    expect(() => toBaseUnits(0, 18)).toThrow("Amount must be greater than zero.");
  });
});

describe("normalizeAddress", () => {
  it("lowercases a checksum address", () => {
    expect(normalizeAddress("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48")).toBe(
      "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"
    );
  });

  it("throws on invalid input", () => {
    expect(() => normalizeAddress("not-an-address")).toThrow("Enter a valid Ethereum address.");
  });
});
