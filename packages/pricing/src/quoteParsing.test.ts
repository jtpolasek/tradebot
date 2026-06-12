import { describe, expect, it } from "vitest";
import { assertUsableUniswapQuote } from "./uniswapQuote.js";
import { assertUsableZeroxQuote, summarizeDexFees } from "./zerox.js";
import type { NormalizedUniswapQuote } from "./uniswapQuote.js";
import type { NormalizedZeroxQuote } from "./zerox.js";

function zeroxQuote(buyAmount: string): NormalizedZeroxQuote {
  return {
    provider: "0x",
    endpoint: "/swap/allowance-holder/price",
    chainId: 1,
    sellToken: "0xsell",
    buyToken: "0xbuy",
    sellAmount: "1",
    buyAmount,
    gasUnits: 0,
    gasPriceWei: 0,
    dexFeeUsd: 0,
    unpricedFees: [],
    warnings: [],
    rawResponse: {},
  };
}

function uniswapQuote(buyAmount: string): NormalizedUniswapQuote {
  return {
    provider: "Uniswap",
    endpoint: "/quote",
    chainId: 1,
    sellToken: "0xsell",
    buyToken: "0xbuy",
    sellAmount: "1",
    buyAmount,
    gasUsd: 0,
    dexFeeUsd: 0,
    warnings: [],
    rawResponse: {},
  };
}

describe("quote raw amount parsing", () => {
  it("accepts very large 0x buy amounts without Number coercion", () => {
    expect(() => assertUsableZeroxQuote(zeroxQuote("100000000000000000000000000000000000001"), "buy")).not.toThrow();
  });

  it("accepts very large Uniswap buy amounts without Number coercion", () => {
    expect(() => assertUsableUniswapQuote(uniswapQuote("100000000000000000000000000000000000001"))).not.toThrow();
  });

  it("keeps unpriced 0x fees only when the raw amount is a positive integer", () => {
    const { unpriced } = summarizeDexFees({
      fees: {
        zeroExFee: {
          token: "0xnotusdc",
          amount: "100000000000000000000000000000000000001",
        },
        integratorFee: {
          token: "0xnotusdc",
          amount: "0",
        },
      },
    });

    expect(unpriced).toEqual([
      {
        type: "zeroExFee",
        token: "0xnotusdc",
        amount: "100000000000000000000000000000000000001",
      },
    ]);
  });
});
