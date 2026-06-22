import { describe, expect, it } from "vitest";
import { isPolymarketOutcome, polymarketProfileUrl, tokenTitle } from "./api";

const CTF_ID = "71321045679252212594626385532706912750332728571942532289631379312455583992563";
const USDC = "0x2791bca1f2de4661ed88a30c99a7a9449aa84174";

describe("isPolymarketOutcome", () => {
  it("flags a polygon CTF outcome share", () => {
    expect(isPolymarketOutcome("polygon", { address: CTF_ID, symbol: "Yes" })).toBe(true);
  });

  it("excludes polygon ERC-20s like USDC", () => {
    expect(isPolymarketOutcome("polygon", { address: USDC, symbol: "USDC" })).toBe(false);
  });

  it("excludes non-polygon chains", () => {
    expect(isPolymarketOutcome("eth", { address: CTF_ID })).toBe(false);
  });

  it("uses token.chain over the chain arg when present", () => {
    expect(isPolymarketOutcome("", { chain: "polygon", address: CTF_ID })).toBe(true);
  });
});

describe("tokenTitle", () => {
  it("renders an outcome share as 'symbol — market question'", () => {
    expect(tokenTitle({ chain: "polygon", address: CTF_ID, symbol: "Yes", name: "Will it rain?" }))
      .toBe("Yes — Will it rain?");
  });

  it("keeps the EVM 'name (symbol)' form for ERC-20s", () => {
    expect(tokenTitle({ chain: "polygon", address: USDC, symbol: "USDC", name: "USD Coin" }))
      .toBe("USD Coin (USDC)");
  });
});

describe("polymarketProfileUrl", () => {
  it("builds a profile link for a polygon EVM address", () => {
    expect(polymarketProfileUrl("polygon", USDC)).toBe(`https://polymarket.com/profile/${USDC}`);
  });

  it("returns null for non-polygon chains", () => {
    expect(polymarketProfileUrl("eth", USDC)).toBeNull();
  });

  it("returns null for a non-EVM address", () => {
    expect(polymarketProfileUrl("polygon", CTF_ID)).toBeNull();
  });
});
