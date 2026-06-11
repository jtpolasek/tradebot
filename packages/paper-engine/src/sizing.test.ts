import { describe, expect, it } from "vitest";
import { calculateCashCappedBuyUsd, estimateSourceNotionalUsd, sizeCopyTrade } from "./sizing.js";
import type { SizingCandidate, SizingSettings, SizingPosition } from "./sizing.js";

const settings: SizingSettings = {
  mode: "fixed",
  fixedUsd: 100,
  percentOfSource: 100,
  maxTradeUsd: 500,
  blocklist: [],
  allowlist: [],
};

function candidate(overrides: Partial<SizingCandidate>): SizingCandidate {
  return {
    side: "buy",
    tokenInSymbol: "USDC",
    tokenInAddress: "0xusdc",
    tokenInAmountHuman: 100,
    tokenOutSymbol: "TOKEN",
    tokenOutAddress: "0x0000000000000000000000000000000000001000",
    tokenOutAmountHuman: 1000,
    ...overrides,
  };
}

describe("estimateSourceNotionalUsd", () => {
  it("uses cash input for buys", () => {
    expect(estimateSourceNotionalUsd(candidate({}), 3000)).toBe(100);
  });

  it("uses native input for buys", () => {
    expect(estimateSourceNotionalUsd(candidate({ tokenInSymbol: "ETH", tokenInAmountHuman: 0.1 }), 3000)).toBe(300);
  });
});

describe("sizeCopyTrade", () => {
  it("sizes fixed-dollar buys with a max cap", () => {
    const sized = sizeCopyTrade({
      candidate: candidate({}),
      settings: { ...settings, mode: "fixed", fixedUsd: 250, maxTradeUsd: 100 },
      nativeUsd: 3000,
      position: null,
    });

    expect(sized).toMatchObject({
      side: "buy",
      tokenAddress: "0x0000000000000000000000000000000000001000",
      usdAmount: 100,
    });
  });

  it("sizes percent-of-source buys", () => {
    const sized = sizeCopyTrade({
      candidate: candidate({ tokenInAmountHuman: 200 }),
      settings: { ...settings, mode: "proportional", percentOfSource: 25, maxTradeUsd: 500 },
      nativeUsd: 3000,
      position: null,
    });

    expect(sized).toMatchObject({ side: "buy", usdAmount: 50, sourceNotionalUsd: 200 });
  });

  it("rejects blocked tokens", () => {
    expect(() =>
      sizeCopyTrade({
        candidate: candidate({}),
        settings: { ...settings, blocklist: ["0x0000000000000000000000000000000000001000"] },
        nativeUsd: 3000,
        position: null,
      })
    ).toThrow("blocklist");
  });

  it("requires a position for copied sells", () => {
    expect(() =>
      sizeCopyTrade({
        candidate: candidate({
          side: "sell",
          tokenInSymbol: "TOKEN",
          tokenInAddress: "0x0000000000000000000000000000000000001000",
          tokenInAmountHuman: 20,
          tokenOutSymbol: "USDC",
          tokenOutAmountHuman: 100,
        }),
        settings,
        nativeUsd: 3000,
        position: null,
      })
    ).toThrow("no matching position");
  });

  it("caps copied sells to the current position quantity", () => {
    const position: SizingPosition = {
      quantity: 5,
      averageEntryUsd: 10,
    };
    const sized = sizeCopyTrade({
      candidate: candidate({
        side: "sell",
        tokenInSymbol: "TOKEN",
        tokenInAddress: "0x0000000000000000000000000000000000001000",
        tokenInAmountHuman: 20,
        tokenOutSymbol: "USDC",
        tokenOutAmountHuman: 100,
      }),
      settings: { ...settings, mode: "proportional", percentOfSource: 100, maxTradeUsd: 500 },
      nativeUsd: 3000,
      position,
    });

    expect(sized).toMatchObject({ side: "sell", tokenQuantity: 5 });
  });
});

describe("calculateCashCappedBuyUsd", () => {
  it("reserves fixed fees, slippage, and a safety buffer", () => {
    const capped = calculateCashCappedBuyUsd({
      cashUsd: 100,
      requestedUsd: 250,
      gasUsd: 10,
      dexFeeUsd: 2,
      slippageBps: 100,
      safetyBufferBps: 0,
    });

    expect(capped).toBeCloseTo(87.1287, 4);
  });

  it("does not increase an already affordable request", () => {
    expect(
      calculateCashCappedBuyUsd({
        cashUsd: 1000,
        requestedUsd: 100,
        gasUsd: 5,
        dexFeeUsd: 0,
        slippageBps: 50,
      })
    ).toBe(100);
  });

  it("returns zero when fixed fees consume available cash", () => {
    expect(
      calculateCashCappedBuyUsd({
        cashUsd: 5,
        requestedUsd: 100,
        gasUsd: 6,
        dexFeeUsd: 0,
        slippageBps: 50,
      })
    ).toBe(0);
  });
});
