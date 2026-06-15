import type { ChainId } from "@tradebot/core";
import { WETH, QUOTE_ASSETS, CHAINLINK_ETH_USD, NATIVE_TOKEN_PLACEHOLDER, bigintRatioToNumber, createLogger, fromBaseUnits } from "@tradebot/core";

const logger = createLogger("pricing");

// Loose structural interface avoids viem type-identity issues across pnpm packages
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RpcClient = { readContract: (args: any) => Promise<any> };

// ─── ABIs ────────────────────────────────────────────────────────────────────

const CHAINLINK_ABI = [
  {
    type: "function",
    name: "latestRoundData",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
    stateMutability: "view",
  },
] as const;

const UNI_V3_FACTORY_ABI = [
  {
    type: "function",
    name: "getPool",
    inputs: [
      { name: "tokenA", type: "address" },
      { name: "tokenB", type: "address" },
      { name: "fee", type: "uint24" },
    ],
    outputs: [{ name: "pool", type: "address" }],
    stateMutability: "view",
  },
] as const;

const AERODROME_CL_FACTORY_ABI = [
  {
    type: "function",
    name: "getPool",
    inputs: [
      { name: "tokenA", type: "address" },
      { name: "tokenB", type: "address" },
      { name: "tickSpacing", type: "int24" },
    ],
    outputs: [{ name: "pool", type: "address" }],
    stateMutability: "view",
  },
] as const;

const UNI_V3_POOL_ABI = [
  {
    type: "function",
    name: "slot0",
    inputs: [],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "observationIndex", type: "uint16" },
      { name: "observationCardinality", type: "uint16" },
      { name: "observationCardinalityNext", type: "uint16" },
      { name: "feeProtocol", type: "uint8" },
      { name: "unlocked", type: "bool" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "liquidity",
    inputs: [],
    outputs: [{ name: "", type: "uint128" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "observe",
    inputs: [{ name: "secondsAgos", type: "uint32[]" }],
    outputs: [
      { name: "tickCumulatives", type: "int56[]" },
      { name: "secondsPerLiquidityCumulativeX128s", type: "uint160[]" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "token0",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "token1",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
] as const;

const AERODROME_CL_POOL_ABI = [
  {
    type: "function",
    name: "slot0",
    inputs: [],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "observationIndex", type: "uint16" },
      { name: "observationCardinality", type: "uint16" },
      { name: "observationCardinalityNext", type: "uint16" },
      { name: "unlocked", type: "bool" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "liquidity",
    inputs: [],
    outputs: [{ name: "", type: "uint128" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "observe",
    inputs: [{ name: "secondsAgos", type: "uint32[]" }],
    outputs: [
      { name: "tickCumulatives", type: "int56[]" },
      { name: "secondsPerLiquidityCumulativeX128s", type: "uint160[]" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "token0",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "token1",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
] as const;

// Uniswap V3 pool balance of a token
const ERC20_BALANCE_ABI = [
  {
    type: "function",
    name: "balanceOf",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "decimals",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
    stateMutability: "view",
  },
] as const;

// ─── Constants ───────────────────────────────────────────────────────────────

const UNI_V3_FACTORIES: Record<ChainId, string> = {
  eth: "0x1f98431c8ad98523631ae4a59f267346ea31f984",
  base: "0x33128a8fc17869897dce68ed026d694621f6fdfd",
};

const AERODROME_CL_FACTORY_BASE = "0x5e7bb104d84c7cb9b682aac2f3d509f5f406809a";

// Fee tiers to probe in priority order (deepest pool wins by liquidity)
const V3_FEE_TIERS = [500, 3000, 10000] as const;
const AERODROME_TICK_SPACINGS = [1, 50, 100, 200, 2000] as const;

// Stablecoins that are always exactly $1.00 USD (not WETH, which needs real price)
const STABLECOINS: Record<ChainId, Set<string>> = {
  eth: new Set([
    "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", // USDC
    "0xdac17f958d2ee523a2206206994597c13d831ec7", // USDT
    "0x6b175474e89094c44da98b954eedeac495271d0f", // DAI
  ]),
  base: new Set([
    "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", // USDC
  ]),
};

const NULL_ADDRESS = "0x0000000000000000000000000000000000000000";

// ─── Caches ──────────────────────────────────────────────────────────────────

// DefiLlama: 30s TTL
type LlamaEntry = { price: number; fetchedAt: number };
const llamaCache = new Map<string, LlamaEntry>();

// Liquidity: 5-minute TTL
type LiqEntry = LiquidityResult & { fetchedAt: number };
const liqCache = new Map<string, LiqEntry>();

// Pool discovery: static pool facts (address, tokens, decimals) are immutable, but the
// "deepest" pool choice can drift, so 10-minute TTL. Negative results are cached too —
// otherwise tokens with no V3 pool re-probe every factory/fee-tier on each lookup.
type CachedPool = {
  address: string;
  venue: "uniswap-v3" | "aerodrome-cl";
  token0: string;
  token1: string;
  decimals0: number;
  decimals1: number;
  poolAbi: typeof UNI_V3_POOL_ABI | typeof AERODROME_CL_POOL_ABI;
};
type PoolEntry = { pool: CachedPool | null; fetchedAt: number };
const poolCache = new Map<string, PoolEntry>();

// Chainlink ETH/USD: 30s TTL — shared across every token priced against WETH in a tick
type ChainlinkEntry = { price: number; fetchedAt: number };
const chainlinkCache = new Map<ChainId, ChainlinkEntry>();

const LLAMA_TTL_MS = 30_000;
const LIQ_TTL_MS = 5 * 60_000;
const POOL_TTL_MS = 10 * 60_000;
const CHAINLINK_TTL_MS = 30_000;
const TWAP_WINDOW_SECONDS = 300;

// Reject Chainlink rounds whose last update is older than this, so a frozen feed can't drive
// auto-buys. Read from env (set by the app's config) with a 1-hour default.
const DEFAULT_CHAINLINK_STALENESS_SEC = 3600;
function maxChainlinkStalenessSec(): number {
  const raw = process.env["MAX_CHAINLINK_STALENESS_SEC"];
  if (raw === undefined) return DEFAULT_CHAINLINK_STALENESS_SEC;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CHAINLINK_STALENESS_SEC;
}

export function clearCaches() {
  llamaCache.clear();
  liqCache.clear();
  poolCache.clear();
  chainlinkCache.clear();
}

export type PriceSource = "stablecoin" | "chainlink" | "v3-spot" | "defillama";

export type PriceResult = {
  priceUsd: number;
  source: PriceSource;
  chain: ChainId;
  tokenAddress: string;
  quoteTokenAddress?: string;
  poolAddress?: string;
  venue?: "uniswap-v3" | "aerodrome-cl";
  twapPriceUsd?: number;
  spotTwapDivergenceBps?: number;
  warnings: string[];
};

export type LiquidityResult = {
  liquidityUsd: number;
  chain: ChainId;
  tokenAddress: string;
  quoteTokenAddress: string;
  poolAddress: string;
  venue: "uniswap-v3" | "aerodrome-cl";
  method: "quote-balance-x2";
  warnings: string[];
};

// ─── sqrtPriceX96 math ───────────────────────────────────────────────────────

/**
 * Converts a Uniswap V3 sqrtPriceX96 to the price of token0 in terms of token1,
 * adjusted for token decimals.
 *
 * sqrtPriceX96 = sqrt(reserve1_raw / reserve0_raw) * 2^96
 * price_token0_in_token1_human = (sqrtPriceX96 / 2^96)^2 * 10^(decimals0 - decimals1)
 */
export function sqrtPriceX96ToPrice(
  sqrtPriceX96: bigint,
  decimals0: number,
  decimals1: number
): number {
  const Q96 = 2n ** 96n;
  const ratio = bigintRatioToNumber(sqrtPriceX96, Q96);
  const rawPrice = ratio * ratio;
  return rawPrice * 10 ** (decimals0 - decimals1);
}

export function tickToPrice(tick: number, decimals0: number, decimals1: number): number {
  return 1.0001 ** tick * 10 ** (decimals0 - decimals1);
}

function divergenceBps(left: number, right: number): number | null {
  if (!Number.isFinite(left) || !Number.isFinite(right) || left <= 0 || right <= 0) return null;
  return Math.round((Math.abs(left - right) / right) * 10_000);
}

// ─── Chainlink ───────────────────────────────────────────────────────────────

async function getChainlinkEthUsd(chain: ChainId, client: RpcClient): Promise<number | null> {
  const cached = chainlinkCache.get(chain);
  if (cached && Date.now() - cached.fetchedAt < CHAINLINK_TTL_MS) return cached.price;
  try {
    const feed = CHAINLINK_ETH_USD[chain] as `0x${string}`;
    const result = await client.readContract({
      address: feed,
      abi: CHAINLINK_ABI,
      functionName: "latestRoundData",
    }) as [bigint, bigint, bigint, bigint, bigint];
    const answer = result[1]; // int256 with 8 decimals
    if (answer <= 0n) return null;

    // Staleness gate: reject a frozen feed (treated as unavailable → caller falls back to DefiLlama,
    // which then hits the existing fallback-price-source buy veto).
    const updatedAt = result[3]; // uint256 unix seconds of the round's last update
    const ageSec = Math.floor(Date.now() / 1000) - Number(updatedAt);
    const maxAgeSec = maxChainlinkStalenessSec();
    if (ageSec > maxAgeSec) {
      logger.warn({ chain, ageSec, maxAgeSec }, "Chainlink ETH/USD round is stale — treating as unavailable");
      return null;
    }

    const price = fromBaseUnits(answer, 8);
    chainlinkCache.set(chain, { price, fetchedAt: Date.now() });
    return price;
  } catch (err) {
    logger.warn({ err, chain }, "Chainlink ETH/USD read failed");
    return null;
  }
}

// ─── Uniswap V3 pool discovery ───────────────────────────────────────────────

type V3VenueConfig = {
  venue: "uniswap-v3" | "aerodrome-cl";
  factory: `0x${string}`;
  factoryAbi: typeof UNI_V3_FACTORY_ABI | typeof AERODROME_CL_FACTORY_ABI;
  poolAbi: typeof UNI_V3_POOL_ABI | typeof AERODROME_CL_POOL_ABI;
  spacings: readonly number[];
};

function v3VenueConfigs(chain: ChainId): V3VenueConfig[] {
  const configs: V3VenueConfig[] = [
    {
      venue: "uniswap-v3",
      factory: UNI_V3_FACTORIES[chain] as `0x${string}`,
      factoryAbi: UNI_V3_FACTORY_ABI,
      poolAbi: UNI_V3_POOL_ABI,
      spacings: V3_FEE_TIERS,
    },
  ];

  if (chain === "base") {
    configs.push({
      venue: "aerodrome-cl",
      factory: AERODROME_CL_FACTORY_BASE as `0x${string}`,
      factoryAbi: AERODROME_CL_FACTORY_ABI,
      poolAbi: AERODROME_CL_POOL_ABI,
      spacings: AERODROME_TICK_SPACINGS,
    });
  }

  return configs;
}

async function findDeepestV3Pool(
  chain: ChainId,
  tokenA: string,
  tokenB: string,
  client: RpcClient
): Promise<CachedPool | null> {
  const cacheKey = `${chain}:${tokenA.toLowerCase()}:${tokenB.toLowerCase()}`;
  const cached = poolCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < POOL_TTL_MS) return cached.pool;

  const addrA = tokenA as `0x${string}`;
  const addrB = tokenB as `0x${string}`;

  let best: (CachedPool & { liquidityVal: bigint }) | null = null;

  for (const venue of v3VenueConfigs(chain)) {
    for (const spacing of venue.spacings) {
      try {
        const poolAddr = await client.readContract({
          address: venue.factory,
          abi: venue.factoryAbi,
          functionName: "getPool",
          args: [addrA, addrB, spacing],
        }) as string;

        if (!poolAddr || poolAddr === NULL_ADDRESS) continue;

        const pool = poolAddr as `0x${string}`;

        const [slot0Result, liquidityResult, token0Result, token1Result] = await Promise.all([
          client.readContract({ address: pool, abi: venue.poolAbi, functionName: "slot0" }),
          client.readContract({ address: pool, abi: venue.poolAbi, functionName: "liquidity" }),
          client.readContract({ address: pool, abi: venue.poolAbi, functionName: "token0" }),
          client.readContract({ address: pool, abi: venue.poolAbi, functionName: "token1" }),
        ]) as [unknown[], bigint, string, string];

        const sqrtPriceX96 = slot0Result[0] as bigint;
        if (sqrtPriceX96 === 0n) continue;

        const t0 = (token0Result as string).toLowerCase();
        const t1 = (token1Result as string).toLowerCase();

        const [dec0, dec1] = await Promise.all([
          client.readContract({ address: t0 as `0x${string}`, abi: ERC20_BALANCE_ABI, functionName: "decimals" }).catch(() => 18),
          client.readContract({ address: t1 as `0x${string}`, abi: ERC20_BALANCE_ABI, functionName: "decimals" }).catch(() => 18),
        ]) as [number, number];

        if (!best || liquidityResult > best.liquidityVal) {
          best = {
            address: poolAddr.toLowerCase(),
            venue: venue.venue,
            token0: t0,
            token1: t1,
            decimals0: dec0,
            decimals1: dec1,
            poolAbi: venue.poolAbi,
            liquidityVal: liquidityResult,
          };
        }
      } catch {
        // pool not found or call failed — try next fee tier/tick spacing
      }
    }
  }

  const pool = best ? (({ liquidityVal: _dropped, ...info }) => info)(best) : null;
  poolCache.set(cacheKey, { pool, fetchedAt: Date.now() });
  return pool;
}

// ─── V3 spot price ───────────────────────────────────────────────────────────

async function getV3SpotPriceResult(
  chain: ChainId,
  token: string,
  quoteToken: string,
  client: RpcClient,
  quoteUsdPrice: number
): Promise<PriceResult | null> {
  const pool = await findDeepestV3Pool(chain, token, quoteToken, client);
  if (!pool) return null;

  // Spot price must be fresh even when the pool itself came from cache
  let sqrtPriceX96: bigint;
  try {
    const slot0 = await client.readContract({
      address: pool.address as `0x${string}`,
      abi: pool.poolAbi,
      functionName: "slot0",
    }) as unknown[];
    sqrtPriceX96 = slot0[0] as bigint;
  } catch (err) {
    logger.warn({ err, chain, pool: pool.address }, "slot0 read failed");
    return null;
  }
  if (sqrtPriceX96 === 0n) return null;

  const tokenLc = token.toLowerCase();
  // Determine which direction: is our token token0 or token1?
  const tokenIsToken0 = pool.token0 === tokenLc;

  let priceInQuote: number;
  if (tokenIsToken0) {
    // price of token0 in token1 (=quote)
    priceInQuote = sqrtPriceX96ToPrice(sqrtPriceX96, pool.decimals0, pool.decimals1);
  } else {
    // price of token0 (=quote) in token1 (=our token)
    const priceQuoteInToken = sqrtPriceX96ToPrice(sqrtPriceX96, pool.decimals0, pool.decimals1);
    if (priceQuoteInToken <= 0) return null;
    priceInQuote = 1 / priceQuoteInToken;
  }

  const priceUsd = priceInQuote * quoteUsdPrice;
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) return null;
  const twap = await getV3TwapPriceUsd(pool, tokenLc, quoteUsdPrice, client);
  const warnings: string[] = [];
  if (twap === null) warnings.push("twap-unavailable");
  const spotTwapDivergenceBps = twap !== null ? divergenceBps(priceUsd, twap) ?? undefined : undefined;
  return {
    priceUsd,
    source: "v3-spot",
    chain,
    tokenAddress: token.toLowerCase(),
    quoteTokenAddress: quoteToken.toLowerCase(),
    poolAddress: pool.address,
    venue: pool.venue,
    ...(twap !== null ? { twapPriceUsd: twap } : {}),
    ...(spotTwapDivergenceBps !== undefined ? { spotTwapDivergenceBps } : {}),
    warnings,
  };
}

async function getV3TwapPriceUsd(
  pool: CachedPool,
  tokenLc: string,
  quoteUsdPrice: number,
  client: RpcClient
): Promise<number | null> {
  try {
    const result = await client.readContract({
      address: pool.address as `0x${string}`,
      abi: pool.poolAbi,
      functionName: "observe",
      args: [[TWAP_WINDOW_SECONDS, 0]],
    }) as [bigint[], bigint[]];
    const tickCumulatives = result[0];
    const start = tickCumulatives[0];
    const end = tickCumulatives[1];
    if (start === undefined || end === undefined) return null;
    const averageTick = Number((end - start) / BigInt(TWAP_WINDOW_SECONDS));
    if (!Number.isFinite(averageTick)) return null;

    const tokenIsToken0 = pool.token0 === tokenLc;
    if (tokenIsToken0) {
      return tickToPrice(averageTick, pool.decimals0, pool.decimals1) * quoteUsdPrice;
    }
    const quoteInToken = tickToPrice(averageTick, pool.decimals0, pool.decimals1);
    if (quoteInToken <= 0) return null;
    return (1 / quoteInToken) * quoteUsdPrice;
  } catch {
    return null;
  }
}

// ─── DefiLlama fallback ──────────────────────────────────────────────────────

const LLAMA_CHAIN_SLUG: Record<ChainId, string> = {
  eth: "ethereum",
  base: "base",
};

async function getLlamaPrice(chain: ChainId, address: string): Promise<number | null> {
  const key = `${chain}:${address}`;
  const cached = llamaCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < LLAMA_TTL_MS) return cached.price;

  try {
    const slug = LLAMA_CHAIN_SLUG[chain];
    const url = `https://coins.llama.fi/prices/current/${slug}:${address}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = (await res.json()) as { coins?: Record<string, { price?: number }> };
    const coinKey = `${slug}:${address}`;
    const price = json.coins?.[coinKey]?.price;
    if (typeof price !== "number" || !Number.isFinite(price)) return null;
    llamaCache.set(key, { price, fetchedAt: Date.now() });
    return price;
  } catch (err) {
    logger.warn({ err, chain, address }, "DefiLlama price fetch failed");
    return null;
  }
}

async function getLlamaPriceResult(chain: ChainId, address: string): Promise<PriceResult | null> {
  const price = await getLlamaPrice(chain, address);
  if (price === null) return null;
  return {
    priceUsd: price,
    source: "defillama",
    chain,
    tokenAddress: address.toLowerCase(),
    warnings: ["fallback-price-source"],
  };
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Returns the USD price of a token. Routing priority:
 *  1. Stablecoin → 1.0
 *  2. WETH → Chainlink ETH/USD
 *  3. Other → deepest V3 pool vs quote asset × quote USD price
 *  4. Fallback → DefiLlama (30s cache)
 */
export async function getUsdPrice(
  chain: ChainId,
  address: string,
  client: RpcClient
): Promise<number | null> {
  return (await getUsdPriceResult(chain, address, client))?.priceUsd ?? null;
}

export async function getUsdPriceResult(
  chain: ChainId,
  address: string,
  client: RpcClient
): Promise<PriceResult | null> {
  const addr = normalizePricedAddress(chain, address);

  // 1. Stablecoin
  if (STABLECOINS[chain].has(addr)) {
    return { priceUsd: 1.0, source: "stablecoin", chain, tokenAddress: addr, warnings: [] };
  }

  // 2. WETH → Chainlink
  if (addr === WETH[chain]) {
    const price = await getChainlinkEthUsd(chain, client);
    if (price !== null) {
      return { priceUsd: price, source: "chainlink", chain, tokenAddress: addr, warnings: [] };
    }
    // Chainlink failed — fall through to DefiLlama
    logger.warn({ chain }, "Chainlink failed for WETH — falling back to DefiLlama");
    return getLlamaPriceResult(chain, addr);
  }

  // 3. V3 pool spot price — try each quote asset until one works
  const quoteAssets = QUOTE_ASSETS[chain];
  for (const quoteAddr of quoteAssets) {
    if (quoteAddr === addr) continue; // token IS a quote asset, price it directly
    // Get quote asset USD price (recursive, but quote assets are stablecoins or WETH — no infinite loop)
    const quoteUsdPrice = await getUsdPrice(chain, quoteAddr, client);
    if (quoteUsdPrice === null) continue;

    const price = await getV3SpotPriceResult(chain, addr, quoteAddr, client, quoteUsdPrice);
    if (price !== null && price.priceUsd > 0) return price;
  }

  // 4. DefiLlama fallback
  return getLlamaPriceResult(chain, addr);
}

/**
 * Returns the USD value of the quote-side reserves in the deepest V3 pool.
 * Approximation: quote reserve × quote USD price × 2 (assumes 50/50 pool).
 * Cache: 5 minutes.
 */
export async function getLiquidityUsd(
  chain: ChainId,
  address: string,
  client: RpcClient
): Promise<number | null> {
  return (await getLiquidityUsdResult(chain, address, client))?.liquidityUsd ?? null;
}

export async function getLiquidityUsdResult(
  chain: ChainId,
  address: string,
  client: RpcClient
): Promise<LiquidityResult | null> {
  const addr = normalizePricedAddress(chain, address);
  const cacheKey = `${chain}:${addr}`;
  const cached = liqCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < LIQ_TTL_MS) {
    const { fetchedAt: _fetchedAt, ...result } = cached;
    return result;
  }

  const quoteAssets = QUOTE_ASSETS[chain];
  for (const quoteAddr of quoteAssets) {
    if (quoteAddr === addr) continue;

    const pool = await findDeepestV3Pool(chain, addr, quoteAddr, client);
    if (!pool) continue;

    const quoteUsdPrice = await getUsdPrice(chain, quoteAddr, client);
    if (quoteUsdPrice === null) continue;

    try {
      // Get quote token balance in the pool
      const quoteIsToken0 = pool.token0 === quoteAddr;
      const quoteTokenAddr = (quoteIsToken0 ? pool.token0 : pool.token1) as `0x${string}`;
      const quoteDecimals = quoteIsToken0 ? pool.decimals0 : pool.decimals1;

      const balanceRaw = await client.readContract({
        address: quoteTokenAddr,
        abi: ERC20_BALANCE_ABI,
        functionName: "balanceOf",
        args: [pool.address as `0x${string}`],
      }) as bigint;

      const balanceHuman = fromBaseUnits(balanceRaw, quoteDecimals);
      const liquidityUsd = balanceHuman * quoteUsdPrice * 2;

      const result: LiquidityResult = {
        liquidityUsd,
        chain,
        tokenAddress: addr,
        quoteTokenAddress: quoteAddr.toLowerCase(),
        poolAddress: pool.address,
        venue: pool.venue,
        method: "quote-balance-x2",
        warnings: [],
      };
      liqCache.set(cacheKey, { ...result, fetchedAt: Date.now() });
      return result;
    } catch (err) {
      logger.warn({ err, chain, address: addr }, "getLiquidityUsd balance read failed");
    }
  }

  return null;
}

function normalizePricedAddress(chain: ChainId, address: string): string {
  const addr = address.toLowerCase();
  return addr === NATIVE_TOKEN_PLACEHOLDER ? WETH[chain] : addr;
}
