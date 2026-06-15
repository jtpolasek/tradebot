import { describe, it, expect, vi, beforeEach } from "vitest";
import { getUsdPrice, getUsdPriceResult, getLiquidityUsd, getLiquidityUsdResult, sqrtPriceX96ToPrice, tickToPrice, clearCaches } from "./price.js";
import { NATIVE_TOKEN_PLACEHOLDER, WETH, QUOTE_ASSETS } from "@tradebot/core";

const Q96 = 2 ** 96;
const ETH_USDC = QUOTE_ASSETS.eth[0]!; // 0xa0b86991c...
const ETH_WETH = WETH.eth;             // 0xc02aaa39b...
const BASE_USDC = QUOTE_ASSETS.base[0]!;
const BASE_WETH = WETH.base;
const CHAINLINK_FEED_ETH = "0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419";
const CHAINLINK_FEED_BASE = "0x71041dddad3595f9ced3dccfbe3d1f4b0a16bb70";
const UNI_FACTORY = "0x1f98431c8ad98523631ae4a59f267346ea31f984";
const BASE_UNI_FACTORY = "0x33128a8fc17869897dce68ed026d694621f6fdfd";
const BASE_AERODROME_FACTORY = "0x5e7bb104d84c7cb9b682aac2f3d509f5f406809a";
const NULL_ADDR = "0x0000000000000000000000000000000000000000";
const FAKE_POOL = "0xaabbccddaabbccddaabbccddaabbccddaabbccdd";

// 0x11... < all quote asset addresses → always token0 in pools with USDC/WETH
const FAKE_TOKEN_LO = "0x1111111111111111111111111111111111111111";
// 0xde... > all quote asset addresses → always token1 in pools with USDC/WETH
const FAKE_TOKEN_HI = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

// Chainlink latestRoundData tuple [roundId, answer, startedAt, updatedAt, answeredInRound].
// updatedAt defaults to "now" so the staleness gate accepts the round.
function chainlinkRound(
  answer: bigint,
  updatedAtSec: number = Math.floor(Date.now() / 1000)
): [bigint, bigint, bigint, bigint, bigint] {
  return [0n, answer, 0n, BigInt(updatedAtSec), 0n];
}

// Args-aware mock: handler can be a plain value or a function called with (args)
type Handler = ((args?: unknown[]) => unknown) | unknown;
function makeClient(overrides: Record<string, Handler> = {}) {
  return {
    readContract: vi.fn(async ({ address, functionName, args }: {
      address: string;
      functionName: string;
      args?: unknown[];
    }) => {
      const key = `${address.toLowerCase()}:${functionName}`;
      if (key in overrides) {
        const h = overrides[key];
        return typeof h === "function" ? h(args) : h;
      }
      if (functionName === "getPool") return NULL_ADDR;
      throw new Error(`Unmocked: ${key}`);
    }),
  };
}

// ─── sqrtPriceX96 math ────────────────────────────────────────────────────────

describe("sqrtPriceX96ToPrice", () => {
  it("returns 1.0 when sqrtPriceX96 = 2^96 and equal decimals", () => {
    // sqrt(1) * 2^96 → price = 1.0
    const price = sqrtPriceX96ToPrice(BigInt(Math.round(Q96)), 18, 18);
    expect(price).toBeCloseTo(1.0, 10);
  });

  it("case: token0 (18 dec) is target token, token1 (18 dec) is WETH, price = 0.0005 WETH/token", () => {
    // price_token0_in_token1_raw = 0.0005 (same as human since both 18 dec)
    // sqrtPriceX96 = sqrt(0.0005) * 2^96
    const sqrtPriceX96 = BigInt(Math.round(Math.sqrt(0.0005) * Q96));
    const price = sqrtPriceX96ToPrice(sqrtPriceX96, 18, 18);
    expect(price).toBeCloseTo(0.0005, 6);
  });

  it("case: token0 (18 dec) is WETH, token1 (18 dec) is target; caller must invert", () => {
    // price_WETH_in_token1_raw = 2000 → sqrtPriceX96 encodes sqrt(2000)
    const sqrtPriceX96 = BigInt(Math.round(Math.sqrt(2000) * Q96));
    const priceWethInToken = sqrtPriceX96ToPrice(sqrtPriceX96, 18, 18);
    expect(priceWethInToken).toBeCloseTo(2000, 0);
    // caller inverts to get token price in WETH
    expect(1 / priceWethInToken).toBeCloseTo(0.0005, 6);
  });

  it("handles decimal mismatch: USDC (6 dec) as token0, WETH (18 dec) as token1", () => {
    // 1 USDC = 0.0005 WETH (ETH at $2000)
    // price_USDC_in_WETH_raw = 0.0005 * 10^(18-6) = 0.0005 * 1e12 = 5e8
    const rawPrice = 0.0005 * 10 ** (18 - 6);
    const sqrtPriceX96 = BigInt(Math.round(Math.sqrt(rawPrice) * Q96));
    const price = sqrtPriceX96ToPrice(sqrtPriceX96, 6, 18);
    expect(price).toBeCloseTo(0.0005, 4);
  });

  it("converts ticks into decimal-adjusted token0/token1 prices", () => {
    expect(tickToPrice(0, 18, 18)).toBeCloseTo(1, 10);
    const price = tickToPrice(0, 18, 6);
    expect(price).toBeCloseTo(1e12, 0);
  });
});

// ─── getUsdPrice with mocked RPC ──────────────────────────────────────────────

describe("getUsdPrice", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    clearCaches();
  });

  it("returns 1.0 for USDC (stablecoin) without any RPC calls", async () => {
    const client = makeClient();
    const price = await getUsdPrice("eth", ETH_USDC, client);
    expect(price).toBe(1.0);
    expect(client.readContract).not.toHaveBeenCalled();
  });

  it("returns stablecoin provenance", async () => {
    const client = makeClient();
    const price = await getUsdPriceResult("eth", ETH_USDC, client);

    expect(price).toMatchObject({
      priceUsd: 1.0,
      source: "stablecoin",
      chain: "eth",
      tokenAddress: ETH_USDC,
      warnings: [],
    });
  });

  it("returns Chainlink price for WETH", async () => {
    // Chainlink answer: 2500 USD with 8 decimal places
    const answer = BigInt(Math.round(2500 * 1e8));
    const client = makeClient({
      [`${CHAINLINK_FEED_ETH}:latestRoundData`]: chainlinkRound(answer),
    });
    const price = await getUsdPrice("eth", ETH_WETH, client);
    expect(price).toBeCloseTo(2500, 0);
  });

  it("returns Chainlink provenance for WETH", async () => {
    const answer = BigInt(Math.round(2500 * 1e8));
    const client = makeClient({
      [`${CHAINLINK_FEED_ETH}:latestRoundData`]: chainlinkRound(answer),
    });

    const price = await getUsdPriceResult("eth", ETH_WETH, client);

    expect(price).toMatchObject({
      priceUsd: expect.closeTo(2500, 0),
      source: "chainlink",
      chain: "eth",
      tokenAddress: ETH_WETH,
      warnings: [],
    });
  });

  it("prices the native placeholder as chain WETH", async () => {
    const answer = BigInt(Math.round(2600 * 1e8));
    const client = makeClient({
      [`${CHAINLINK_FEED_BASE}:latestRoundData`]: chainlinkRound(answer),
    });

    const price = await getUsdPrice("base", NATIVE_TOKEN_PLACEHOLDER, client);

    expect(price).toBeCloseTo(2600, 0);
    expect(client.readContract).toHaveBeenCalledWith(expect.objectContaining({
      address: CHAINLINK_FEED_BASE,
      functionName: "latestRoundData",
    }));
  });

  it("falls back to DefiLlama when Chainlink fails, returns null when both fail", async () => {
    // Chainlink throws on call (handler is a function that throws)
    const client = makeClient({
      [`${CHAINLINK_FEED_ETH}:latestRoundData`]: () => { throw new Error("RPC down"); },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    const price = await getUsdPrice("eth", ETH_WETH, client);
    expect(price).toBeNull();
  });

  it("accepts a fresh Chainlink round", async () => {
    const answer = BigInt(Math.round(2500 * 1e8));
    const updatedAt = Math.floor(Date.now() / 1000) - 60; // 1 minute old, well within the window
    const client = makeClient({
      [`${CHAINLINK_FEED_ETH}:latestRoundData`]: chainlinkRound(answer, updatedAt),
    });
    const price = await getUsdPrice("eth", ETH_WETH, client);
    expect(price).toBeCloseTo(2500, 0);
  });

  it("rejects a stale Chainlink round and falls back to DefiLlama", async () => {
    const answer = BigInt(Math.round(2500 * 1e8));
    const updatedAt = Math.floor(Date.now() / 1000) - 7200; // 2 hours old (> 1h default window)
    const client = makeClient({
      [`${CHAINLINK_FEED_ETH}:latestRoundData`]: chainlinkRound(answer, updatedAt),
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ coins: { [`ethereum:${ETH_WETH}`]: { price: 2490 } } }),
    }));

    const price = await getUsdPriceResult("eth", ETH_WETH, client);
    // Stale Chainlink is treated as unavailable → DefiLlama fallback (which buys then veto).
    expect(price?.source).toBe("defillama");
    expect(price?.priceUsd).toBeCloseTo(2490, 0);
  });

  it("prices a non-quote token via V3 pool — token is token0 (FAKE_TOKEN_LO < USDC)", async () => {
    // FAKE_TOKEN_LO (18 dec) is token0, USDC (6 dec) is token1
    // We want price_FAKE_TOKEN_LO_in_USDC_human = 0.00025 USDC/token
    // price_raw = 0.00025 * 10^(6-18) = 0.00025 / 1e12 = 2.5e-16
    const rawPrice = 0.00025 * 10 ** (6 - 18);
    const sqrtPriceX96 = BigInt(Math.round(Math.sqrt(rawPrice) * Q96));

    const client = makeClient({
      // getPool: only return FAKE_POOL for USDC pairs, null otherwise
      [`${UNI_FACTORY}:getPool`]: (args?: unknown[]) => {
        const a = (args?.[0] as string)?.toLowerCase();
        const b = (args?.[1] as string)?.toLowerCase();
        return (a === ETH_USDC || b === ETH_USDC) ? FAKE_POOL : NULL_ADDR;
      },
      [`${FAKE_POOL}:slot0`]: [sqrtPriceX96, 0, 0, 0, 0, 0, true],
      [`${FAKE_POOL}:observe`]: [[-450n, 0n], [0n, 0n]],
      [`${FAKE_POOL}:liquidity`]: 1_000_000n,
      [`${FAKE_POOL}:token0`]: FAKE_TOKEN_LO,
      [`${FAKE_POOL}:token1`]: ETH_USDC,
      [`${FAKE_TOKEN_LO}:decimals`]: 18,
      [`${ETH_USDC}:decimals`]: 6,
    });

    const price = await getUsdPrice("eth", FAKE_TOKEN_LO, client);
    // USDC = $1.00, so USD price = 0.00025
    expect(price).toBeCloseTo(0.00025, 6);

    const result = await getUsdPriceResult("eth", FAKE_TOKEN_LO, client);
    expect(result).toMatchObject({
      source: "v3-spot",
      chain: "eth",
      tokenAddress: FAKE_TOKEN_LO,
      quoteTokenAddress: ETH_USDC,
      poolAddress: FAKE_POOL,
      venue: "uniswap-v3",
      warnings: [],
    });
    expect(result?.priceUsd).toBeCloseTo(0.00025, 6);
    expect(result?.twapPriceUsd).toBeGreaterThan(0);
    expect(result?.spotTwapDivergenceBps).toBeGreaterThan(1000);
  });

  it("prices a non-quote token via V3 pool — token is token1 (FAKE_TOKEN_HI > WETH)", async () => {
    // WETH (18 dec) is token0, FAKE_TOKEN_HI (18 dec) is token1
    // price_WETH_in_FAKE_TOKEN_raw = 2000 (both 18 dec, ratio = 1:1)
    // WETH price = $2500 via Chainlink
    // FAKE_TOKEN price = (1/2000) WETH * $2500 = $1.25
    const sqrtPriceX96 = BigInt(Math.round(Math.sqrt(2000) * Q96));
    const chainlinkAnswer = BigInt(Math.round(2500 * 1e8));

    const client = makeClient({
      [`${CHAINLINK_FEED_ETH}:latestRoundData`]: chainlinkRound(chainlinkAnswer),
      // getPool: only return FAKE_POOL for WETH pairs
      [`${UNI_FACTORY}:getPool`]: (args?: unknown[]) => {
        const a = (args?.[0] as string)?.toLowerCase();
        const b = (args?.[1] as string)?.toLowerCase();
        return (a === ETH_WETH || b === ETH_WETH) ? FAKE_POOL : NULL_ADDR;
      },
      [`${FAKE_POOL}:slot0`]: [sqrtPriceX96, 0, 0, 0, 0, 0, true],
      [`${FAKE_POOL}:liquidity`]: 5_000_000n,
      [`${FAKE_POOL}:token0`]: ETH_WETH,
      [`${FAKE_POOL}:token1`]: FAKE_TOKEN_HI,
      [`${ETH_WETH}:decimals`]: 18,
      [`${FAKE_TOKEN_HI}:decimals`]: 18,
    });

    const price = await getUsdPrice("eth", FAKE_TOKEN_HI, client);
    expect(price).toBeCloseTo(1.25, 2);
  });

  it("falls back to DefiLlama when no V3 pool exists", async () => {
    const client = makeClient(); // all getPool → NULL_ADDR by default

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        coins: { [`ethereum:${FAKE_TOKEN_HI}`]: { price: 0.042 } },
      }),
    }));

    const price = await getUsdPrice("eth", FAKE_TOKEN_HI, client);
    expect(price).toBeCloseTo(0.042, 4);

    const result = await getUsdPriceResult("eth", FAKE_TOKEN_HI, client);
    expect(result).toMatchObject({
      priceUsd: expect.closeTo(0.042, 4),
      source: "defillama",
      chain: "eth",
      tokenAddress: FAKE_TOKEN_HI,
      warnings: ["fallback-price-source"],
    });
  });

  it("prices a Base token through an Aerodrome CL pool when no Uniswap V3 pool exists", async () => {
    const rawPrice = 0.50 * 10 ** (6 - 18);
    const sqrtPriceX96 = BigInt(Math.round(Math.sqrt(rawPrice) * Q96));

    const client = makeClient({
      [`${BASE_UNI_FACTORY}:getPool`]: NULL_ADDR,
      [`${BASE_AERODROME_FACTORY}:getPool`]: (args?: unknown[]) => {
        const a = (args?.[0] as string)?.toLowerCase();
        const b = (args?.[1] as string)?.toLowerCase();
        return (a === BASE_USDC || b === BASE_USDC) ? FAKE_POOL : NULL_ADDR;
      },
      [`${FAKE_POOL}:slot0`]: [sqrtPriceX96, 0, 0, 0, 0, true],
      [`${FAKE_POOL}:liquidity`]: 1_000_000n,
      [`${FAKE_POOL}:token0`]: FAKE_TOKEN_LO,
      [`${FAKE_POOL}:token1`]: BASE_USDC,
      [`${FAKE_TOKEN_LO}:decimals`]: 18,
      [`${BASE_USDC}:decimals`]: 6,
    });

    const price = await getUsdPrice("base", FAKE_TOKEN_LO, client);

    expect(price).toBeCloseTo(0.50, 6);
    expect(client.readContract).toHaveBeenCalledWith(expect.objectContaining({
      address: BASE_AERODROME_FACTORY,
      functionName: "getPool",
    }));

    const result = await getUsdPriceResult("base", FAKE_TOKEN_LO, client);
    expect(result).toMatchObject({
      source: "v3-spot",
      chain: "base",
      tokenAddress: FAKE_TOKEN_LO,
      quoteTokenAddress: BASE_USDC,
      poolAddress: FAKE_POOL,
      venue: "aerodrome-cl",
      warnings: ["twap-unavailable"],
    });
  });
});

// ─── getLiquidityUsd with mocked RPC ─────────────────────────────────────────

describe("getLiquidityUsd", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    clearCaches();
  });

  it("returns quote reserve × quoteUsdPrice × 2", async () => {
    // Pool: FAKE_TOKEN_LO(token0,18dec) / USDC(token1,6dec)
    // USDC balance in pool = 500_000 human USDC = 500_000 * 1e6 raw
    // liquidityUsd = 500_000 * 1.0 * 2 = 1_000_000
    const sqrtPriceX96 = BigInt(Math.round(Q96)); // arbitrary, just needs to be non-zero

    const client = makeClient({
      // Only a USDC pool exists; the WETH quote finds nothing (keeps the test offline).
      [`${UNI_FACTORY}:getPool`]: (args?: unknown[]) => {
        const a = (args?.[0] as string)?.toLowerCase();
        const b = (args?.[1] as string)?.toLowerCase();
        return (a === ETH_USDC || b === ETH_USDC) ? FAKE_POOL : NULL_ADDR;
      },
      [`${FAKE_POOL}:slot0`]: [sqrtPriceX96, 0, 0, 0, 0, 0, true],
      [`${FAKE_POOL}:liquidity`]: 1_000_000n,
      [`${FAKE_POOL}:token0`]: FAKE_TOKEN_LO,
      [`${FAKE_POOL}:token1`]: ETH_USDC,
      [`${FAKE_TOKEN_LO}:decimals`]: 18,
      [`${ETH_USDC}:decimals`]: 6,
      [`${ETH_USDC}:balanceOf`]: BigInt(500_000 * 1e6),
    });

    const liq = await getLiquidityUsd("eth", FAKE_TOKEN_LO, client);
    expect(liq).toBeCloseTo(1_000_000, 0);

    clearCaches();
    const result = await getLiquidityUsdResult("eth", FAKE_TOKEN_LO, client);
    expect(result).toMatchObject({
      liquidityUsd: expect.closeTo(1_000_000, 0),
      chain: "eth",
      tokenAddress: FAKE_TOKEN_LO,
      quoteTokenAddress: ETH_USDC,
      poolAddress: FAKE_POOL,
      venue: "uniswap-v3",
      method: "quote-balance-x2",
      warnings: [],
    });
  });

  it("returns null when no pool found", async () => {
    const client = makeClient(); // all getPool → NULL_ADDR
    const liq = await getLiquidityUsd("eth", FAKE_TOKEN_HI, client);
    expect(liq).toBeNull();
  });

  it("selects the deeper USD market across quote assets for both price and liquidity", async () => {
    const POOL_USDC = "0xaaaa1111aaaa1111aaaa1111aaaa1111aaaa1111";
    const POOL_WETH = "0xbbbb2222bbbb2222bbbb2222bbbb2222bbbb2222";
    // USDC pool: shallow ($200k). WETH pool: deep ($5M at $2500/ETH) → must win.
    const usdcSqrt = BigInt(Math.round(Math.sqrt(2.40 * 10 ** (6 - 18)) * Q96)); // $2.40 via USDC
    const wethSqrt = BigInt(Math.round(Math.sqrt(0.001) * Q96)); // 0.001 WETH/token → $2.50 via WETH
    const chainlinkAnswer = BigInt(Math.round(2500 * 1e8));

    const client = makeClient({
      [`${CHAINLINK_FEED_ETH}:latestRoundData`]: chainlinkRound(chainlinkAnswer),
      [`${UNI_FACTORY}:getPool`]: (args?: unknown[]) => {
        const a = (args?.[0] as string)?.toLowerCase();
        const b = (args?.[1] as string)?.toLowerCase();
        if (a === ETH_USDC || b === ETH_USDC) return POOL_USDC;
        if (a === ETH_WETH || b === ETH_WETH) return POOL_WETH;
        return NULL_ADDR;
      },
      [`${POOL_USDC}:slot0`]: [usdcSqrt, 0, 0, 0, 0, 0, true],
      [`${POOL_USDC}:liquidity`]: 9_999_999n, // larger L, but USD balance is what should decide
      [`${POOL_USDC}:token0`]: FAKE_TOKEN_LO,
      [`${POOL_USDC}:token1`]: ETH_USDC,
      [`${POOL_USDC}:observe`]: [[0n, 0n], [0n, 0n]],
      [`${ETH_USDC}:balanceOf`]: BigInt(100_000 * 1e6), // $200k
      [`${POOL_WETH}:slot0`]: [wethSqrt, 0, 0, 0, 0, 0, true],
      [`${POOL_WETH}:liquidity`]: 1n,
      [`${POOL_WETH}:token0`]: FAKE_TOKEN_LO,
      [`${POOL_WETH}:token1`]: ETH_WETH,
      [`${POOL_WETH}:observe`]: [[0n, 0n], [0n, 0n]],
      [`${ETH_WETH}:balanceOf`]: BigInt(1000) * 10n ** 18n, // 1000 WETH → $5M
      [`${FAKE_TOKEN_LO}:decimals`]: 18,
      [`${ETH_USDC}:decimals`]: 6,
      [`${ETH_WETH}:decimals`]: 18,
    });

    const liq = await getLiquidityUsdResult("eth", FAKE_TOKEN_LO, client);
    expect(liq).toMatchObject({
      poolAddress: POOL_WETH,
      quoteTokenAddress: ETH_WETH,
      venue: "uniswap-v3",
    });
    expect(liq?.liquidityUsd).toBeCloseTo(5_000_000, 0);

    const price = await getUsdPriceResult("eth", FAKE_TOKEN_LO, client);
    expect(price).toMatchObject({ poolAddress: POOL_WETH, quoteTokenAddress: ETH_WETH });
    expect(price?.priceUsd).toBeCloseTo(2.5, 6); // from the WETH pool, not the USDC pool's $2.40
  });

  it("uses WETH pools when liquidity is requested for the native placeholder", async () => {
    const sqrtPriceX96 = BigInt(Math.round(Q96));
    const client = makeClient({
      [`${BASE_UNI_FACTORY}:getPool`]: (args?: unknown[]) => {
        const a = (args?.[0] as string)?.toLowerCase();
        const b = (args?.[1] as string)?.toLowerCase();
        return (a === BASE_WETH || b === BASE_WETH) ? FAKE_POOL : NULL_ADDR;
      },
      [`${FAKE_POOL}:slot0`]: [sqrtPriceX96, 0, 0, 0, 0, 0, true],
      [`${FAKE_POOL}:liquidity`]: 1_000_000n,
      [`${FAKE_POOL}:token0`]: BASE_WETH,
      [`${FAKE_POOL}:token1`]: BASE_USDC,
      [`${BASE_WETH}:decimals`]: 18,
      [`${BASE_USDC}:decimals`]: 6,
      [`${BASE_USDC}:balanceOf`]: BigInt(250_000 * 1e6),
    });

    const liq = await getLiquidityUsd("base", NATIVE_TOKEN_PLACEHOLDER, client);

    expect(liq).toBeCloseTo(500_000, 0);
    expect(client.readContract).toHaveBeenCalledWith(expect.objectContaining({
      address: BASE_UNI_FACTORY,
      functionName: "getPool",
      args: expect.arrayContaining([BASE_WETH]),
    }));
  });
});
