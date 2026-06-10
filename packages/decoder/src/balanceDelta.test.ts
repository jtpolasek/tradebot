import { describe, expect, it } from "vitest";
import { analyzePairs } from "./balanceDelta.js";
import type { NormalizedTransfer } from "./types.js";

function transfer(overrides: Partial<NormalizedTransfer> & Pick<NormalizedTransfer, "symbol" | "direction">): NormalizedTransfer {
  return {
    tokenAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    decimals: 6,
    amountRaw: 100_000_000n,
    amountHuman: 100,
    ...overrides,
  };
}

function out(symbol: string, overrides?: Partial<NormalizedTransfer>): NormalizedTransfer {
  return transfer({ symbol, direction: "out", ...overrides });
}

function inb(symbol: string, overrides?: Partial<NormalizedTransfer>): NormalizedTransfer {
  return transfer({ symbol, direction: "in", ...overrides });
}

describe("analyzePairs", () => {
  it("decodes a likely buy from paired cash-out and token-in transfers", () => {
    const result = analyzePairs(
      [out("USDC", { amountHuman: 50, amountRaw: 50_000_000n })],
      [inb("PEPE", { tokenAddress: "0x0000000000000000000000000000000000001000", amountHuman: 1000, amountRaw: 1000n })]
    );

    expect(result).toMatchObject({
      status: "decoded",
      confidence: 0.9,
      side: "buy",
    });
    expect(result.tokenIn?.symbol).toBe("USDC");
    expect(result.tokenOut?.symbol).toBe("PEPE");
    expect(result.tokenOut?.tokenAddress).toBe("0x0000000000000000000000000000000000001000");
  });

  it("decodes a likely sell from token-out and cash-in transfers", () => {
    const result = analyzePairs(
      [out("PEPE", { tokenAddress: "0x0000000000000000000000000000000000001000", amountHuman: 1000, amountRaw: 1000n })],
      [inb("USDC", { amountHuman: 45, amountRaw: 45_000_000n })]
    );

    expect(result).toMatchObject({
      status: "decoded",
      side: "sell",
    });
    expect(result.tokenIn?.symbol).toBe("PEPE");
    expect(result.tokenIn?.tokenAddress).toBe("0x0000000000000000000000000000000000001000");
    expect(result.tokenOut?.symbol).toBe("USDC");
  });

  it("keeps ambiguous multi-transfer swaps as review candidates", () => {
    const result = analyzePairs(
      [
        out("USDC", { amountHuman: 50, amountRaw: 50_000_000n }),
        out("ETH", { tokenAddress: "", amountHuman: 0.01, amountRaw: 10_000_000_000_000_000n }),
      ],
      [inb("PEPE", { tokenAddress: "0x0000000000000000000000000000000000001000", amountHuman: 1000, amountRaw: 1000n })]
    );

    expect(result).toMatchObject({
      status: "candidate",
      confidence: 0.72,
      side: "buy",
    });
    expect(result.reason).toContain("Multiple inbound or outbound transfers");
  });

  it("selects the cash/native outbound leg for a buy when another outbound token is larger", () => {
    const result = analyzePairs(
      [
        out("ETH", { tokenAddress: "", amountHuman: 0.12, amountRaw: 120_000_000_000_000_000n }),
        out("DUST", { tokenAddress: "0x0000000000000000000000000000000000003000", amountHuman: 50_000, amountRaw: 50_000n }),
      ],
      [inb("PEPE", { tokenAddress: "0x0000000000000000000000000000000000001000", amountHuman: 1000, amountRaw: 1000n })]
    );

    expect(result).toMatchObject({
      status: "candidate",
      confidence: 0.72,
      side: "buy",
    });
    expect(result.tokenIn?.symbol).toBe("ETH");
    expect(result.tokenOut?.symbol).toBe("PEPE");
    expect(result.tokenOut?.tokenAddress).toBe("0x0000000000000000000000000000000000001000");
    expect(result.reason).toContain("selected the likely buy using ETH");
  });

  it("selects the token outbound leg for a sell when native value also leaves the wallet", () => {
    const result = analyzePairs(
      [
        out("PEPE", { tokenAddress: "0x0000000000000000000000000000000000001000", amountHuman: 1000, amountRaw: 1000n }),
        out("ETH", { tokenAddress: "", amountHuman: 0.01, amountRaw: 10_000_000_000_000_000n }),
      ],
      [inb("USDC", { amountHuman: 45, amountRaw: 45_000_000n })]
    );

    expect(result).toMatchObject({
      status: "candidate",
      confidence: 0.72,
      side: "sell",
    });
    expect(result.tokenIn?.symbol).toBe("PEPE");
    expect(result.tokenIn?.tokenAddress).toBe("0x0000000000000000000000000000000000001000");
    expect(result.tokenOut?.symbol).toBe("USDC");
    expect(result.reason).toContain("selected the likely sell of PEPE");
  });

  it("decodes a noisy sell when one token-out and one proceeds leg dominate a tiny native refund", () => {
    const result = analyzePairs(
      [out("PEPE", { tokenAddress: "0x0000000000000000000000000000000000001000", amountHuman: 1000, amountRaw: 1000n })],
      [
        inb("ETH", { tokenAddress: "", amountHuman: 0.08, amountRaw: 80_000_000_000_000_000n }),
        inb("ETH", { tokenAddress: "", amountHuman: 0.00002, amountRaw: 20_000_000_000_000n }),
      ]
    );

    expect(result).toMatchObject({
      status: "decoded",
      confidence: 0.9,
      side: "sell",
    });
    expect(result.tokenIn?.symbol).toBe("PEPE");
    expect(result.tokenIn?.tokenAddress).toBe("0x0000000000000000000000000000000000001000");
    expect(result.tokenOut?.symbol).toBe("ETH");
    expect(result.tokenOut?.amountHuman).toBe(0.08);
  });

  it("keeps a sell with competing same-asset proceeds in review", () => {
    const result = analyzePairs(
      [out("PEPE", { tokenAddress: "0x0000000000000000000000000000000000001000", amountHuman: 1000, amountRaw: 1000n })],
      [
        inb("ETH", { tokenAddress: "", amountHuman: 0.08, amountRaw: 80_000_000_000_000_000n }),
        inb("ETH", { tokenAddress: "", amountHuman: 0.04, amountRaw: 40_000_000_000_000_000n }),
      ]
    );

    expect(result).toMatchObject({
      status: "candidate",
      confidence: 0.72,
      side: "sell",
    });
    expect(result.tokenIn?.symbol).toBe("PEPE");
    expect(result.tokenOut?.symbol).toBe("ETH");
    expect(result.tokenOut?.amountHuman).toBe(0.08);
    expect(result.reason).toContain("Multiple inbound or outbound transfers");
  });

  it("decodes a routed sell with tiny unrelated erc20 reward noise", () => {
    const result = analyzePairs(
      [out("PEPE", { tokenAddress: "0x0000000000000000000000000000000000001000", amountHuman: 1000, amountRaw: 1000n })],
      [
        inb("USDC", { tokenAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", amountHuman: 92, amountRaw: 92_000_000n }),
        inb("POINTS", { tokenAddress: "0x0000000000000000000000000000000000004000", amountHuman: 0.25, amountRaw: 25n }),
      ]
    );

    expect(result).toMatchObject({
      status: "decoded",
      confidence: 0.9,
      side: "sell",
    });
    expect(result.tokenIn?.symbol).toBe("PEPE");
    expect(result.tokenIn?.tokenAddress).toBe("0x0000000000000000000000000000000000001000");
    expect(result.tokenOut?.symbol).toBe("USDC");
    expect(result.tokenOut?.amountHuman).toBe(92);
  });

  it("keeps a routed sell with large alternate erc20 inbound in review", () => {
    const result = analyzePairs(
      [out("PEPE", { tokenAddress: "0x0000000000000000000000000000000000001000", amountHuman: 1000, amountRaw: 1000n })],
      [
        inb("USDC", { tokenAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", amountHuman: 92, amountRaw: 92_000_000n }),
        inb("BONUS", { tokenAddress: "0x0000000000000000000000000000000000004001", amountHuman: 40, amountRaw: 40n }),
      ]
    );

    expect(result).toMatchObject({
      status: "candidate",
      confidence: 0.72,
      side: "sell",
    });
    expect(result.tokenIn?.symbol).toBe("PEPE");
    expect(result.tokenOut?.symbol).toBe("USDC");
    expect(result.reason).toContain("Multiple inbound or outbound transfers");
  });

  it("keeps a routed sell with a mixed buy shape in review", () => {
    const result = analyzePairs(
      [
        out("PEPE", { tokenAddress: "0x0000000000000000000000000000000000001000", amountHuman: 1000, amountRaw: 1000n }),
        out("ETH", { tokenAddress: "", amountHuman: 0.02, amountRaw: 20_000_000_000_000_000n }),
      ],
      [
        inb("USDC", { amountHuman: 92, amountRaw: 92_000_000n }),
        inb("NEWTOKEN", { tokenAddress: "0x0000000000000000000000000000000000004002", amountHuman: 500, amountRaw: 500n }),
      ]
    );

    expect(result).toMatchObject({
      status: "candidate",
      confidence: 0.4,
      side: "unknown",
    });
    expect(result.reason).toContain("plausible buy and sell shapes");
  });

  it("decodes a native ETH buy from ETH out and token in", () => {
    const result = analyzePairs(
      [out("ETH", { tokenAddress: "", amountHuman: 0.05, amountRaw: 50_000_000_000_000_000n })],
      [inb("BRETT", { tokenAddress: "0x0000000000000000000000000000000000002000", amountHuman: 250, amountRaw: 250n })]
    );

    expect(result).toMatchObject({
      status: "decoded",
      confidence: 0.9,
      side: "buy",
    });
    expect(result.tokenIn?.symbol).toBe("ETH");
    expect(result.tokenOut?.symbol).toBe("BRETT");
    expect(result.tokenOut?.tokenAddress).toBe("0x0000000000000000000000000000000000002000");
    expect(result.reason).toContain("likely buy using ETH");
  });

  it("decodes a native ETH buy equivalent to the real ECHO buy", () => {
    const result = analyzePairs(
      [out("ETH", { tokenAddress: "", amountHuman: 0.01, amountRaw: 10_000_000_000_000_000n })],
      [inb("ECHO", {
        tokenAddress: "0xcaaca3c22141bcfa3dad3662c465bb48ab6736ee",
        amountHuman: 339.6828751637203,
        amountRaw: 339682875163720300n,
      })]
    );

    expect(result).toMatchObject({
      status: "decoded",
      confidence: 0.9,
      side: "buy",
    });
    expect(result.tokenIn?.symbol).toBe("ETH");
    expect(result.tokenOut?.symbol).toBe("ECHO");
    expect(result.tokenOut?.tokenAddress).toBe("0xcaaca3c22141bcfa3dad3662c465bb48ab6736ee");
  });

  it("keeps a buy review-only when the received token address is missing", () => {
    // Real SNOWY tx: wallet spent ETH, received SNOWY (no contract address stored).
    const result = analyzePairs(
      [out("ETH", { tokenAddress: "", amountHuman: 0.2501, amountRaw: 250_100_000_000_000_000n })],
      [inb("SNOWY", { tokenAddress: "", amountHuman: 85709106.87, amountRaw: 85709106n })]
    );

    expect(result.side).toBe("buy");
    expect(result.status).toBe("candidate");
    expect(result.confidence).toBe(0.58);
    expect(result.reason).toContain("no contract address");
  });

  it("skips transactions without paired transfer directions", () => {
    const result = analyzePairs(
      [out("USDC", { amountHuman: 50, amountRaw: 50_000_000n })],
      []
    );

    expect(result).toMatchObject({
      status: "skipped",
      confidence: 0,
      side: "unknown",
    });
    expect(result.reason).toContain("No paired inbound and outbound");
  });

  it("skips when inbound is empty", () => {
    const result = analyzePairs([], [inb("PEPE", { tokenAddress: "0x1000", amountHuman: 1000, amountRaw: 1000n })]);

    expect(result).toMatchObject({ status: "skipped", confidence: 0 });
  });

  it("keeps a likely buy as review candidate when the traded token address is missing", () => {
    const result = analyzePairs(
      [out("USDC", { amountHuman: 50, amountRaw: 50_000_000n })],
      [inb("PEPE", { tokenAddress: "", amountHuman: 1000, amountRaw: 1000n })]
    );

    expect(result).toMatchObject({
      status: "candidate",
      confidence: 0.58,
      side: "buy",
    });
    expect(result.reason).toContain("no contract address");
  });

  it("keeps noisy buys with multiple possible received tokens in review", () => {
    const result = analyzePairs(
      [
        out("ETH", { tokenAddress: "", amountHuman: 0.08, amountRaw: 80_000_000_000_000_000n }),
        out("USDC", { amountHuman: 25, amountRaw: 25_000_000n }),
      ],
      [
        inb("PEPE", { tokenAddress: "0x0000000000000000000000000000000000001000", amountHuman: 1000, amountRaw: 1000n }),
        inb("AIRDROP", { tokenAddress: "0x0000000000000000000000000000000000001001", amountHuman: 50, amountRaw: 50n }),
      ]
    );

    expect(result).toMatchObject({
      status: "candidate",
      confidence: 0.52,
      side: "buy",
    });
    expect(result.tokenOut?.symbol).toBe("PEPE");
    expect(result.reason).toContain("Multiple possible received tokens");
  });

  it("keeps noisy sells with multiple possible sent tokens in review", () => {
    const result = analyzePairs(
      [
        out("PEPE", { tokenAddress: "0x0000000000000000000000000000000000001000", amountHuman: 1000, amountRaw: 1000n }),
        out("REWARD", { tokenAddress: "0x0000000000000000000000000000000000001002", amountHuman: 12, amountRaw: 12n }),
      ],
      [
        inb("USDC", { amountHuman: 45, amountRaw: 45_000_000n }),
        inb("ETH", { tokenAddress: "", amountHuman: 0.004, amountRaw: 4_000_000_000_000_000n }),
      ]
    );

    expect(result).toMatchObject({
      status: "candidate",
      confidence: 0.52,
      side: "sell",
    });
    expect(result.tokenIn?.symbol).toBe("PEPE");
    expect(result.reason).toContain("Multiple possible sent tokens");
  });

  it("decodes a sell from erc20 token-out and internal ETH-in (TALOS on Base)", () => {
    const tokenAddress = "0xdcb35db5e40d1b53e54bb7cfe8f9730ecddb9ba3";

    const result = analyzePairs(
      [out("TALOS", { tokenAddress, amountHuman: 89492134, amountRaw: 89492134n })],
      [inb("ETH", { tokenAddress: "", amountHuman: 0.5, amountRaw: 500_000_000_000_000_000n })]
    );

    expect(result.status).toBe("decoded");
    expect(result.side).toBe("sell");
    expect(result.tokenIn?.symbol).toBe("TALOS");
    expect(result.tokenIn?.tokenAddress).toBe(tokenAddress);
    expect(result.tokenOut?.symbol).toBe("ETH");
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("keeps a sell review-only when the token address is missing (TALOS no-addr case)", () => {
    const result = analyzePairs(
      [out("TALOS", { tokenAddress: "", amountHuman: 89492134, amountRaw: 89492134n })],
      [inb("ETH", { tokenAddress: "", amountHuman: 0.5, amountRaw: 500_000_000_000_000_000n })]
    );

    // Both token-less — side is unknown since neither is cash-like (TALOS) vs ETH (cash-like) wait...
    // TALOS out (not cash) + ETH in (cash) → SELL. But TALOS has no address.
    expect(result.side).toBe("sell");
    expect(result.status).toBe("candidate");
    expect(result.tokenIn?.tokenAddress).toBe("");
    expect(result.tokenOut?.symbol).toBe("ETH");
    expect(result.reason).toContain("no contract address");
  });

  it("decodes BREAD multi-router sell with tiny ETH noise leg below 1% threshold", () => {
    const breadContract = "0xf327abd3c9709c9834d0ad1dc253ff6eed86c04d";

    const result = analyzePairs(
      [out("BREAD", { tokenAddress: breadContract, amountHuman: 1618891.924372758, amountRaw: 1618891924372758n })],
      [
        inb("ETH", { tokenAddress: "", amountHuman: 0.5, amountRaw: 500_000_000_000_000_000n }),
        inb("ETH", { tokenAddress: "", amountHuman: 0.004, amountRaw: 4_000_000_000_000_000n }),
      ]
    );

    expect(result.status).toBe("decoded");
    expect(result.confidence).toBe(0.9);
    expect(result.side).toBe("sell");
    expect(result.tokenIn?.symbol).toBe("BREAD");
    expect(result.tokenIn?.tokenAddress).toBe(breadContract);
    expect(result.tokenOut?.symbol).toBe("ETH");
  });

  it("keeps BREAD sell review-only when two ETH proceeds legs both exceed 1% threshold", () => {
    const breadContract = "0xf327abd3c9709c9834d0ad1dc253ff6eed86c04d";

    const result = analyzePairs(
      [out("BREAD", { tokenAddress: breadContract, amountHuman: 1618891.924372758, amountRaw: 1618891924372758n })],
      [
        inb("ETH", { tokenAddress: "", amountHuman: 0.5, amountRaw: 500_000_000_000_000_000n }),
        inb("ETH", { tokenAddress: "", amountHuman: 0.1, amountRaw: 100_000_000_000_000_000n }),
      ]
    );

    expect(result.status).toBe("candidate");
    expect(result.confidence).toBe(0.72);
    expect(result.side).toBe("sell");
    expect(result.tokenIn?.symbol).toBe("BREAD");
    expect(result.tokenIn?.tokenAddress).toBe(breadContract);
    expect(result.tokenOut?.symbol).toBe("ETH");
  });

  it("skips when only outbound legs exist (no inbound proceeds)", () => {
    const breadContract = "0xf327abd3c9709c9834d0ad1dc253ff6eed86c04d";

    const result = analyzePairs(
      [
        out("BREAD", { tokenAddress: breadContract, amountHuman: 4140.18, amountRaw: 4140n }),
        out("BREAD", { tokenAddress: breadContract, amountHuman: 33038.61, amountRaw: 33038n }),
        out("BREAD", { tokenAddress: breadContract, amountHuman: 1618891.92, amountRaw: 1618891n }),
      ],
      []
    );

    expect(result.status).toBe("skipped");
    expect(result.reason).toContain("No paired inbound and outbound");
  });

  it("decodes a real Ethereum ECHO sell (erc20 out, ETH in)", () => {
    const echoContract = "0xcaaca3c22141bcfa3dad3662c465bb48ab6736ee";

    const result = analyzePairs(
      [out("ECHO", { tokenAddress: echoContract, amountHuman: 979.3225218159785, amountRaw: 979322521815978500n })],
      [inb("ETH", { tokenAddress: "", amountHuman: 0.009477321633601129, amountRaw: 9477321633601129n })]
    );

    expect(result.status).toBe("decoded");
    expect(result.confidence).toBe(0.9);
    expect(result.side).toBe("sell");
    expect(result.tokenIn?.symbol).toBe("ECHO");
    expect(result.tokenIn?.tokenAddress).toBe(echoContract);
    expect(result.tokenOut?.symbol).toBe("ETH");
  });

  it("decodes a real Ethereum OCEAN sell (erc20 out, ETH in)", () => {
    const oceanContract = "0x3d76e4399448015374981596209dd42a0ffec661";

    const result = analyzePairs(
      [out("OCEAN", { tokenAddress: oceanContract, amountHuman: 9.578480482840625, amountRaw: 9578480482840625n })],
      [inb("ETH", { tokenAddress: "", amountHuman: 0.021052929380662715, amountRaw: 21052929380662715n })]
    );

    expect(result.status).toBe("decoded");
    expect(result.confidence).toBe(0.9);
    expect(result.side).toBe("sell");
    expect(result.tokenIn?.symbol).toBe("OCEAN");
    expect(result.tokenIn?.tokenAddress).toBe(oceanContract);
    expect(result.tokenOut?.symbol).toBe("ETH");
  });

  it("keeps a CALI sell candidate review-only when the token has no contract address", () => {
    const result = analyzePairs(
      [
        out("ETH", { tokenAddress: "", amountHuman: 0.0001, amountRaw: 100_000_000_000_000n }),
        out("CALI", { tokenAddress: "", amountHuman: 3113779.254930278, amountRaw: 3113779254930278n }),
        out("ETH", { tokenAddress: "", amountHuman: 0.0001, amountRaw: 100_000_000_000_000n }),
      ],
      [inb("ETH", { tokenAddress: "", amountHuman: 0.2096273280957854, amountRaw: 209627328095785400n })]
    );

    expect(result.status).toBe("candidate");
    expect(result.confidence).toBe(0.58);
    expect(result.side).toBe("sell");
    expect(result.tokenIn?.symbol).toBe("CALI");
    expect(result.tokenIn?.tokenAddress).toBe("");
    expect(result.tokenOut?.symbol).toBe("ETH");
  });
});
