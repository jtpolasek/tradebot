import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequire } from "module";
import type { RawTxEvent } from "@tradebot/core";
import { strategyA } from "./strategyA.js";
import type { TokenMetadataResolver } from "./tokenMetadata.js";

const require = createRequire(import.meta.url);
const v2Fixture = require("../test/fixtures/uniswap-v2-swap.json");
const v3Fixture = require("../test/fixtures/uniswap-v3-swap.json");
const v4Fixture = require("../test/fixtures/uniswap-v4-swap.json");
const aeroFixture = require("../test/fixtures/aerodrome-base-swap.json");
const inchFixture = require("../test/fixtures/1inch-aggregation.json");
const urFixture = require("../test/fixtures/universal-router-multihop.json");

const KNOWN_META: Record<string, { symbol: string; name: string; decimals: number }> = {
  "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2": { symbol: "WETH", name: "Wrapped Ether", decimals: 18 },
  "0x9506d37f70eb4c3d79c398d326c871abbf10521d": { symbol: "MOCK1", name: "Mock Token 1", decimals: 18 },
  "0x5998fb77b43a30b735ad0f1e6917cf3a30642c16": { symbol: "MOCK2", name: "Mock Token 2", decimals: 18 },
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": { symbol: "USDC", name: "USD Coin", decimals: 6 },
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": { symbol: "USDC", name: "USD Coin", decimals: 6 },
  "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf": { symbol: "cbBTC", name: "Coinbase Wrapped BTC", decimals: 8 },
};

function makeMeta(): TokenMetadataResolver {
  return {
    resolve: vi.fn().mockImplementation((_chain: string, addr: string) =>
      Promise.resolve(KNOWN_META[addr.toLowerCase()] ?? { symbol: "UNKNOWN", name: "Unknown", decimals: 18 })
    ),
  } as unknown as TokenMetadataResolver;
}

function makeEvent(fixture: { result: Record<string, unknown> }, chain: "eth" | "base" = "eth"): RawTxEvent {
  const r = fixture.result as Record<string, unknown>;
  const logs = (r["logs"] as Array<Record<string, unknown>>).map((l) => ({
    address: l["address"] as string,
    topics: l["topics"] as string[],
    data: l["data"] as string,
  }));
  return {
    chain,
    source: "confirmed",
    txHash: r["transactionHash"] as string,
    from: r["from"] as string,
    to: r["to"] as string | null,
    blockNumber: parseInt(r["blockNumber"] as string, 16),
    observedAt: Date.now(),
    logs,
    status: (r["status"] as string) === "0x1" ? "success" : "reverted",
  };
}

describe("strategyA", () => {
  let meta: TokenMetadataResolver;

  beforeEach(() => {
    meta = makeMeta();
  });

  it("decodes a Uniswap V2 swap — venue, tokenIn, tokenOut, amounts", async () => {
    const event = makeEvent(v2Fixture, "eth");
    const result = await strategyA(event, event.from, meta, "test-id");

    expect(result).not.toBeNull();
    expect(result!.venue).toBe("uniswap-v2");
    expect(result!.tokenIn.address).toBe("0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"); // WETH
    expect(result!.tokenOut.address).toBe("0x9506d37f70eb4c3d79c398d326c871abbf10521d");
    expect(result!.amountIn).toBeGreaterThan(0n);
    expect(result!.amountOut).toBeGreaterThan(0n);
  });

  it("decodes a Uniswap V3 swap — venue, tokenIn, tokenOut, amounts", async () => {
    const event = makeEvent(v3Fixture, "eth");
    const result = await strategyA(event, event.from, meta, "test-id");

    expect(result).not.toBeNull();
    expect(result!.venue).toBe("uniswap-v3");
    expect(result!.tokenIn.address).toBe("0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"); // WETH
    expect(result!.tokenOut.address).toBe("0x5998fb77b43a30b735ad0f1e6917cf3a30642c16");
    expect(result!.amountIn).toBeGreaterThan(0n);
    expect(result!.amountOut).toBeGreaterThan(0n);
  });

  it("returns null for a Uniswap V4 swap where the wallet has no direct Transfer logs", async () => {
    const event = makeEvent(v4Fixture, "eth");
    const result = await strategyA(event, event.from, meta, "test-id");

    // V4 hooks absorb Transfers — wallet address not in Transfer topics → null
    expect(result).toBeNull();
  });

  it("decodes an Aerodrome (Base) V3-style swap", async () => {
    const event = makeEvent(aeroFixture, "base");
    const result = await strategyA(event, event.from, meta, "test-id");

    expect(result).not.toBeNull();
    // Aerodrome uses V3 Swap event signature — detected as uniswap-v3 until venue registry is extended
    expect(result!.venue).toBe("uniswap-v3");
    expect(result!.tokenIn.address).toBe("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"); // USDC on Base
    expect(result!.tokenOut.address).toBe("0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf"); // cbBTC
    expect(result!.amountIn).toBeGreaterThan(0n);
    expect(result!.amountOut).toBeGreaterThan(0n);
  });

  it("returns null for a 1inch aggregation with mixed V2+V3+V4 swap logs", async () => {
    const event = makeEvent(inchFixture, "eth");
    const result = await strategyA(event, event.from, meta, "test-id");

    // Multiple distinct swap types → fall through to Strategy B
    expect(result).toBeNull();
  });

  it("returns null for a Universal Router multi-hop (multiple V3 Swap logs)", async () => {
    const event = makeEvent(urFixture, "eth");
    const result = await strategyA(event, event.from, meta, "test-id");

    // Multiple same-type swap logs → fall through to Strategy B
    expect(result).toBeNull();
  });
});
