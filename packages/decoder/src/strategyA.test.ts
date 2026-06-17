import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequire } from "module";
import type { RawTxEvent } from "@tradebot/core";
import { strategyA } from "./strategyA.js";
import type { StrategyAClients } from "./strategyA.js";
import type { TokenMetadataResolver } from "./tokenMetadata.js";
import { TRANSFER_TOPIC } from "./venues.js";

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
  "0xaebb159c997a36d6de9efe1da4bf8262060899b3": { symbol: "ROOK", name: "Robinhook", decimals: 18 },
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

function makeStrategyAClient(poolAddress: string, verified = true): StrategyAClients {
  const normalizedPool = poolAddress.toLowerCase();
  return {
    eth: {
      readContract: vi.fn().mockImplementation(({ functionName }: { functionName: string }) => {
        if (functionName === "fee") return Promise.resolve(3000);
        if (functionName === "getPair" || functionName === "getPool") {
          return Promise.resolve(verified ? normalizedPool : "0x0000000000000000000000000000000000000000");
        }
        return Promise.reject(new Error(`unexpected readContract: ${functionName}`));
      }),
    },
    base: {
      readContract: vi.fn().mockImplementation(({ functionName }: { functionName: string }) => {
        if (functionName === "fee") return Promise.resolve(3000);
        if (functionName === "getPair" || functionName === "getPool") {
          return Promise.resolve(verified ? normalizedPool : "0x0000000000000000000000000000000000000000");
        }
        return Promise.reject(new Error(`unexpected readContract: ${functionName}`));
      }),
    },
  };
}

function firstSwapLogAddress(event: RawTxEvent): string {
  const swapLog = event.logs?.find((log) => log.topics[0]?.startsWith("0xd78ad95f") || log.topics[0]?.startsWith("0xc42079f9"));
  if (!swapLog) throw new Error("fixture missing swap log");
  return swapLog.address;
}

function paddedTopicAddress(address: string): string {
  return address.replace("0x", "0x000000000000000000000000").toLowerCase();
}

function uint256Data(value: bigint): string {
  return `0x${value.toString(16).padStart(64, "0")}`;
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

  it("verifies a Uniswap V2 swap against the chain factory", async () => {
    const event = makeEvent(v2Fixture, "eth");
    const poolAddress = firstSwapLogAddress(event);
    const clients = makeStrategyAClient(poolAddress);

    const result = await strategyA(event, event.from, meta, "test-id", clients);

    expect(result).not.toBeNull();
    expect(clients.eth!.readContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: "getPair" }));
  });

  it("returns null when V2 factory verification rejects the emitting pool", async () => {
    const event = makeEvent(v2Fixture, "eth");
    const rejectedPool = "0x1111111111111111111111111111111111111111";
    const originalPool = firstSwapLogAddress(event).toLowerCase();
    if (!event.logs) throw new Error("fixture missing logs");
    event.logs = event.logs.map((log) =>
      log.address.toLowerCase() === originalPool ? { ...log, address: rejectedPool } : log
    );
    const clients = makeStrategyAClient(rejectedPool, false);

    const result = await strategyA(event, event.from, meta, "test-id", clients);

    expect(result).toBeNull();
    expect(meta.resolve).not.toHaveBeenCalled();
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

  it("verifies a Uniswap V3 swap against pool fee and factory getPool", async () => {
    const event = makeEvent(v3Fixture, "eth");
    const poolAddress = firstSwapLogAddress(event);
    const clients = makeStrategyAClient(poolAddress);

    const result = await strategyA(event, event.from, meta, "test-id", clients);

    expect(result).not.toBeNull();
    expect(clients.eth!.readContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: "fee" }));
    expect(clients.eth!.readContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: "getPool" }));
  });

  it("returns null for a Uniswap V4 swap where the wallet has no direct Transfer logs", async () => {
    const event = makeEvent(v4Fixture, "eth");
    const result = await strategyA(event, event.from, meta, "test-id");

    // V4 hooks absorb Transfers — wallet address not in Transfer topics → null
    expect(result).toBeNull();
  });

  it("uses wallet Transfer amounts for Uniswap V4 token amounts", async () => {
    const wallet = "0xe817be59f62f827c3e691c28bb0b7955cfb34204";
    const router = "0x1111111111111111111111111111111111111111";
    const usdc = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
    const rook = "0xaebb159c997a36d6de9efe1da4bf8262060899b3";
    const fixtureEvent = makeEvent(v4Fixture, "eth");
    const swapLog = fixtureEvent.logs?.find((log) => log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC);
    if (!swapLog) throw new Error("fixture missing v4 swap log");
    const event: RawTxEvent = {
      chain: "eth",
      source: "confirmed",
      txHash: "0x29ca243cc75cef339b603053a96186bae1ae2dfd490bb6941f23ff0c9da6d010",
      from: wallet,
      to: router,
      blockNumber: 1,
      observedAt: Date.now(),
      logs: [
        swapLog,
        {
          address: usdc,
          topics: [TRANSFER_TOPIC, paddedTopicAddress(wallet), paddedTopicAddress(router)],
          data: uint256Data(2_300_000_000n),
        },
        {
          address: rook,
          topics: [TRANSFER_TOPIC, paddedTopicAddress(router), paddedTopicAddress(wallet)],
          data: uint256Data(4191885454906961716550886n),
        },
      ],
      status: "success",
    };

    const result = await strategyA(event, wallet, meta, "test-id");

    expect(result).not.toBeNull();
    expect(result!.venue).toBe("uniswap-v4");
    expect(result!.tokenIn.address).toBe(usdc);
    expect(result!.tokenOut.address).toBe(rook);
    expect(result!.amountIn).toBe(2_300_000_000n);
    expect(result!.amountOut).toBe(4191885454906961716550886n);
    // poolId is the Swap event's indexed bytes32 id (topics[1]); pricing reads it back for V4.
    expect(result!.poolId).toBe("0xe500210c7ea6bfd9f69dce044b09ef384ec2b34832f132baec3b418208e3a657");
  });

  it("decodes an Aerodrome (Base) V3-style swap", async () => {
    const event = makeEvent(aeroFixture, "base");
    const result = await strategyA(event, event.from, meta, "test-id");

    expect(result).not.toBeNull();
    expect(result!.venue).toBe("uniswap-v3");
    expect(result!.tokenIn.address).toBe("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"); // USDC on Base
    expect(result!.tokenOut.address).toBe("0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf"); // cbBTC
    expect(result!.amountIn).toBeGreaterThan(0n);
    expect(result!.amountOut).toBeGreaterThan(0n);
  });

  it("assigns Aerodrome venue when a Base V3-style pool verifies through Slipstream", async () => {
    const event = makeEvent(aeroFixture, "base");
    const poolAddress = firstSwapLogAddress(event).toLowerCase();
    const clients: StrategyAClients = {
      base: {
        readContract: vi.fn().mockImplementation(({ functionName }: { functionName: string }) => {
          if (functionName === "fee") return Promise.reject(new Error("not a Uniswap V3 pool"));
          if (functionName === "tickSpacing") return Promise.resolve(100);
          if (functionName === "getPool") return Promise.resolve(poolAddress);
          return Promise.reject(new Error(`unexpected readContract: ${functionName}`));
        }),
      },
    };

    const result = await strategyA(event, event.from, meta, "test-id", clients);

    expect(result).not.toBeNull();
    expect(result!.venue).toBe("aerodrome");
    expect(clients.base!.readContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: "tickSpacing" }));
    expect(clients.base!.readContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: "getPool" }));
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
