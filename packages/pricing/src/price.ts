import type { ChainId, EvmChainId } from "@tradebot/core";
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

// Uniswap V4 StateView: off-chain read mirror of the singleton PoolManager's StateLibrary. Every
// call is keyed by the bytes32 poolId we persist on the signal — V4 pools live in a singleton and
// can't be discovered on-chain by token pair, so this is how we read a known V4 pool's state.
const STATE_VIEW_ABI = [
  {
    type: "function",
    name: "getSlot0",
    inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "protocolFee", type: "uint24" },
      { name: "lpFee", type: "uint24" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getLiquidity",
    inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [{ name: "liquidity", type: "uint128" }],
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

const UNI_V3_FACTORIES: Record<EvmChainId, string> = {
  eth: "0x1f98431c8ad98523631ae4a59f267346ea31f984",
  base: "0x33128a8fc17869897dce68ed026d694621f6fdfd",
};

const AERODROME_CL_FACTORY_BASE = "0x5e7bb104d84c7cb9b682aac2f3d509f5f406809a";

// Uniswap V4 StateView deployments. Verified on-chain 2026-06-16 (StateView.poolManager() returns
// the chain's canonical PoolManager). See docs/uniswap-v4-pricing-plan.md.
const STATE_VIEW: Record<EvmChainId, string> = {
  eth: "0x7ffe42c4a5deea5b0fec41c94c136cf115597227",
  base: "0xa3c0c9b65bad0b08107aa264b0f3db444b867a71",
};

const Q96 = 2n ** 96n;

// Fee tiers to probe in priority order (deepest pool wins by liquidity)
const V3_FEE_TIERS = [500, 3000, 10000] as const;
const AERODROME_TICK_SPACINGS = [1, 50, 100, 200, 2000] as const;

// Stablecoins that are always exactly $1.00 USD (not WETH, which needs real price)
const STABLECOINS: Record<EvmChainId, Set<string>> = {
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

type Venue = "uniswap-v3" | "aerodrome-cl" | "uniswap-v4";

type CachedPool = {
  address: string;
  venue: Venue;
  token0: string;
  token1: string;
  decimals0: number;
  decimals1: number;
  poolAbi: typeof UNI_V3_POOL_ABI | typeof AERODROME_CL_POOL_ABI;
  // Uniswap V4 only: the bytes32 poolId read via StateView. `address` mirrors it for reporting.
  poolId?: string;
};

// A token's best market: the (pool, quote asset) with the deepest USD liquidity across every quote
// asset, venue, and fee tier. Both price and liquidity read from this same market so the two are
// always consistent. `liquidityUsd` is null when the pool's quote balance couldn't be read (the
// pool is still usable for pricing; it just ranks below any market with a known balance).
type Market = {
  pool: CachedPool;
  quoteTokenAddress: string;
  quoteUsdPrice: number;
  liquidityUsd: number | null;
};

// Market discovery: the "deepest" choice can drift, and negative results are cached too —
// otherwise tokens with no pool re-probe every factory/fee-tier on each lookup. 5-minute TTL keeps
// reported liquidity reasonably fresh since price/liquidity both derive from it.
type MarketEntry = { market: Market | null; fetchedAt: number };
const marketCache = new Map<string, MarketEntry>();

// Chainlink ETH/USD: 30s TTL — shared across every token priced against WETH in a tick
type ChainlinkEntry = { price: number; fetchedAt: number };
const chainlinkCache = new Map<EvmChainId, ChainlinkEntry>();

const LLAMA_TTL_MS = 30_000;
const MARKET_TTL_MS = 5 * 60_000;
const CHAINLINK_TTL_MS = 30_000;
const TWAP_WINDOW_SECONDS = 300;

// Per-token caches are TTL-only; cap their size so a long-running process tracking many tokens
// can't grow them unbounded. Oldest entry is evicted first (Map preserves insertion order).
const MAX_CACHE_ENTRIES = 5_000;
function cappedSet<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key); // re-insert at the end so eviction is roughly least-recently-written
  map.set(key, value);
  if (map.size > MAX_CACHE_ENTRIES) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}

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
  marketCache.clear();
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
  venue?: Venue;
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
  venue: Venue;
  method: "quote-balance-x2" | "v4-virtual-reserves";
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

async function getChainlinkEthUsd(chain: EvmChainId, client: RpcClient): Promise<number | null> {
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

function v3VenueConfigs(chain: EvmChainId): V3VenueConfig[] {
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

/** Optional hint to price/measure a Uniswap V4 pool by the poolId observed in the decoded swap. */
export type MarketHint = { poolId?: string; counterCurrency?: string };

/**
 * Finds a token's best market: the (pool, quote asset) with the deepest USD liquidity across every
 * quote asset, venue, and fee tier. When a `hint` carries a Uniswap V4 poolId + counter currency
 * (from the decoded swap), the V4 pool is read via StateView and compared too — so a V4-only token
 * becomes priceable and a token with both keeps the real deepest market. Result (including a
 * negative) is cached per token.
 */
async function findBestMarket(
  chain: EvmChainId,
  token: string,
  client: RpcClient,
  hint?: MarketHint
): Promise<Market | null> {
  const cacheKey = `${chain}:${token.toLowerCase()}`;
  const cached = marketCache.get(cacheKey);
  const wantV4 = !!(hint?.poolId && hint?.counterCurrency && STATE_VIEW[chain]);
  if (cached && Date.now() - cached.fetchedAt < MARKET_TTL_MS) {
    // Reuse the cache unless we hold a V4 hint the cached market doesn't already reflect.
    if (!wantV4 || cached.market?.pool.poolId === hint!.poolId) return cached.market;
  }

  let best = await scanV23Market(chain, token, client);
  if (wantV4) {
    const v4 = await readV4Market(chain, hint!.poolId!, token, hint!.counterCurrency!, client);
    if (v4 && (best === null || (v4.liquidityUsd ?? -1) > (best.liquidityUsd ?? -1))) best = v4;
  }

  marketCache.set(cacheKey, { market: best, fetchedAt: Date.now() });
  return best;
}

/** Deepest USD market across Uniswap V3 + Aerodrome CL quote assets / fee tiers. Null if none. */
async function scanV23Market(chain: EvmChainId, token: string, client: RpcClient): Promise<Market | null> {
  const tokenLc = token.toLowerCase();
  let best: { market: Market; liquidityVal: bigint } | null = null;

  for (const quoteAddr of QUOTE_ASSETS[chain]) {
    if (quoteAddr === tokenLc) continue; // token IS this quote asset — priced directly elsewhere

    for (const venue of v3VenueConfigs(chain)) {
      for (const spacing of venue.spacings) {
        try {
          const poolAddr = await client.readContract({
            address: venue.factory,
            abi: venue.factoryAbi,
            functionName: "getPool",
            args: [token as `0x${string}`, quoteAddr as `0x${string}`, spacing],
          }) as string;
          if (!poolAddr || poolAddr === NULL_ADDRESS) continue;

          // Only price the quote asset once we know a pool exists, to avoid needless lookups.
          const quoteUsdPrice = await getUsdPrice(chain, quoteAddr, client);
          if (quoteUsdPrice === null) continue;

          const pool = poolAddr as `0x${string}`;
          const [slot0Result, liquidityVal, token0Result, token1Result] = await Promise.all([
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

          const cachedPool: CachedPool = {
            address: poolAddr.toLowerCase(),
            venue: venue.venue,
            token0: t0,
            token1: t1,
            decimals0: dec0,
            decimals1: dec1,
            poolAbi: venue.poolAbi,
          };

          const liquidityUsd = await readPoolLiquidityUsd(cachedPool, quoteAddr.toLowerCase(), quoteUsdPrice, client);

          // Rank by known USD liquidity; fall back to in-range L only to break ties (e.g. when no
          // candidate's balance could be read).
          const better =
            best === null ||
            (liquidityUsd ?? -1) > (best.market.liquidityUsd ?? -1) ||
            ((liquidityUsd ?? -1) === (best.market.liquidityUsd ?? -1) && liquidityVal > best.liquidityVal);
          if (better) {
            best = {
              market: { pool: cachedPool, quoteTokenAddress: quoteAddr.toLowerCase(), quoteUsdPrice, liquidityUsd },
              liquidityVal,
            };
          }
        } catch {
          // pool not found or call failed — try next fee tier/tick spacing
        }
      }
    }
  }

  return best?.market ?? null;
}

/**
 * Reads a known Uniswap V4 pool (by poolId, via StateView) and builds a Market. Currency ordering
 * and decimals come from the swap's known token pair (token + counter currency) — V4 exposes no
 * reverse poolId→PoolKey lookup, but we don't need one. Price derives from `getSlot0`'s sqrtPrice;
 * liquidity from `getLiquidity`'s in-range L. Null if the pool is uninitialized or unreadable.
 */
async function readV4Market(
  chain: EvmChainId,
  poolId: string,
  token: string,
  counterCurrency: string,
  client: RpcClient
): Promise<Market | null> {
  const stateView = STATE_VIEW[chain];
  if (!stateView) return null;
  try {
    const quoteUsdPrice = await getUsdPrice(chain, counterCurrency, client);
    if (quoteUsdPrice === null) return null;

    const tokenLc = token.toLowerCase();
    // V4 native ETH is currency address(0); map the placeholder so currency ordering matches the
    // on-chain PoolKey. (USD pricing of the counter still routes through getUsdPrice above.)
    const counterLc =
      counterCurrency.toLowerCase() === NATIVE_TOKEN_PLACEHOLDER ? NULL_ADDRESS : counterCurrency.toLowerCase();
    if (counterLc === tokenLc) return null;

    // Currencies are ordered by address ascending, same as V3.
    const tokenIsCurrency0 = tokenLc < counterLc;
    const [c0, c1] = tokenIsCurrency0 ? [tokenLc, counterLc] : [counterLc, tokenLc];

    const decimalsOf = async (addr: string): Promise<number> =>
      addr === NULL_ADDRESS
        ? 18
        : ((await client.readContract({
            address: addr as `0x${string}`,
            abi: ERC20_BALANCE_ABI,
            functionName: "decimals",
          }).catch(() => 18)) as number);

    const [dec0, dec1, slot0Result, liquidityVal] = await Promise.all([
      decimalsOf(c0),
      decimalsOf(c1),
      client.readContract({ address: stateView as `0x${string}`, abi: STATE_VIEW_ABI, functionName: "getSlot0", args: [poolId as `0x${string}`] }),
      client.readContract({ address: stateView as `0x${string}`, abi: STATE_VIEW_ABI, functionName: "getLiquidity", args: [poolId as `0x${string}`] }),
    ]) as [number, number, unknown[], bigint];

    const sqrtPriceX96 = slot0Result[0] as bigint;
    if (sqrtPriceX96 === 0n) return null;

    const pool: CachedPool = {
      address: poolId.toLowerCase(),
      venue: "uniswap-v4",
      token0: c0,
      token1: c1,
      decimals0: dec0,
      decimals1: dec1,
      poolAbi: UNI_V3_POOL_ABI, // unused for V4 (state is read via StateView); kept to satisfy the type
      poolId: poolId.toLowerCase(),
    };

    const liquidityUsd = v4LiquidityUsd(liquidityVal, sqrtPriceX96, pool, counterLc, quoteUsdPrice);
    return { pool, quoteTokenAddress: counterLc, quoteUsdPrice, liquidityUsd };
  } catch {
    return null;
  }
}

/**
 * USD value of a V4 pool's quote-side reserves, approximated from in-range liquidity L and the
 * current sqrtPrice as the "virtual reserves" at price (amount = L·√P or L/√P), valued in USD and
 * doubled — the V4 analogue of the V3 `quote-balance × 2` metric. An approximation (it assumes the
 * active range spans the price); tagged `method: "v4-virtual-reserves"` so the difference is visible.
 */
function v4LiquidityUsd(
  liquidity: bigint,
  sqrtPriceX96: bigint,
  pool: CachedPool,
  quoteAddr: string,
  quoteUsdPrice: number
): number | null {
  if (liquidity <= 0n || sqrtPriceX96 <= 0n) return null;
  const quoteIsCurrency0 = pool.token0 === quoteAddr;
  const quoteDecimals = quoteIsCurrency0 ? pool.decimals0 : pool.decimals1;
  // currency1 virtual reserve = L·√P = L·sqrtPriceX96/2^96; currency0 = L/√P = L·2^96/sqrtPriceX96.
  const quoteRaw = quoteIsCurrency0 ? (liquidity * Q96) / sqrtPriceX96 : (liquidity * sqrtPriceX96) / Q96;
  return fromBaseUnits(quoteRaw, quoteDecimals) * quoteUsdPrice * 2;
}

/** USD value of a pool's quote-side reserves (quote balance × quoteUsd × 2). Null if unreadable. */
async function readPoolLiquidityUsd(
  pool: CachedPool,
  quoteAddr: string,
  quoteUsdPrice: number,
  client: RpcClient
): Promise<number | null> {
  try {
    const quoteIsToken0 = pool.token0 === quoteAddr;
    const quoteDecimals = quoteIsToken0 ? pool.decimals0 : pool.decimals1;
    const balanceRaw = await client.readContract({
      address: quoteAddr as `0x${string}`,
      abi: ERC20_BALANCE_ABI,
      functionName: "balanceOf",
      args: [pool.address as `0x${string}`],
    }) as bigint;
    return fromBaseUnits(balanceRaw, quoteDecimals) * quoteUsdPrice * 2;
  } catch {
    return null;
  }
}

// ─── V3 spot price ───────────────────────────────────────────────────────────

async function priceFromPool(
  chain: EvmChainId,
  token: string,
  pool: CachedPool,
  quoteTokenAddress: string,
  quoteUsdPrice: number,
  client: RpcClient
): Promise<PriceResult | null> {
  // Spot price must be fresh even when the pool itself came from cache. V4 reads via StateView by
  // poolId (singleton, no per-pool slot0); V3/Aerodrome read slot0 on the pool contract.
  const isV4 = pool.venue === "uniswap-v4";
  let sqrtPriceX96: bigint;
  try {
    const slot0 = isV4
      ? await client.readContract({
          address: STATE_VIEW[chain] as `0x${string}`,
          abi: STATE_VIEW_ABI,
          functionName: "getSlot0",
          args: [pool.poolId as `0x${string}`],
        }) as unknown[]
      : await client.readContract({
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
  // V4 has no on-chain TWAP oracle reachable here (depends on the pool's hooks) — skip it.
  const twap = isV4 ? null : await getV3TwapPriceUsd(pool, tokenLc, quoteUsdPrice, client);
  const warnings: string[] = [];
  if (twap === null) warnings.push("twap-unavailable");
  const spotTwapDivergenceBps = twap !== null ? divergenceBps(priceUsd, twap) ?? undefined : undefined;
  return {
    priceUsd,
    source: "v3-spot",
    chain,
    tokenAddress: token.toLowerCase(),
    quoteTokenAddress: quoteTokenAddress,
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

const LLAMA_CHAIN_SLUG: Record<EvmChainId, string> = {
  eth: "ethereum",
  base: "base",
};

async function getLlamaPrice(chain: EvmChainId, address: string): Promise<number | null> {
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

async function getLlamaPriceResult(chain: EvmChainId, address: string): Promise<PriceResult | null> {
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
  chain: EvmChainId,
  address: string,
  client: RpcClient,
  hint?: MarketHint
): Promise<number | null> {
  return (await getUsdPriceResult(chain, address, client, hint))?.priceUsd ?? null;
}

export async function getUsdPriceResult(
  chain: EvmChainId,
  address: string,
  client: RpcClient,
  hint?: MarketHint
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

  // 3. Spot price from the token's deepest USD market (same market liquidity uses). A V4 hint lets
  // a V4-only token be priced via StateView.
  const market = await findBestMarket(chain, addr, client, hint);
  if (market) {
    const price = await priceFromPool(chain, addr, market.pool, market.quoteTokenAddress, market.quoteUsdPrice, client);
    if (price !== null && price.priceUsd > 0) return price;
  }

  // 4. DefiLlama fallback
  return getLlamaPriceResult(chain, addr);
}

/**
 * Returns the USD value of the quote-side reserves in the token's deepest USD market.
 * V3/Aerodrome: quote reserve × quote USD × 2 (assumes 50/50 pool). V4 (via a poolId hint): the
 * virtual quote reserve implied by in-range L × quote USD × 2. Selected by the same `findBestMarket`
 * that prices the token, so price and liquidity always agree on the pool.
 */
export async function getLiquidityUsd(
  chain: EvmChainId,
  address: string,
  client: RpcClient,
  hint?: MarketHint
): Promise<number | null> {
  return (await getLiquidityUsdResult(chain, address, client, hint))?.liquidityUsd ?? null;
}

export async function getLiquidityUsdResult(
  chain: EvmChainId,
  address: string,
  client: RpcClient,
  hint?: MarketHint
): Promise<LiquidityResult | null> {
  const addr = normalizePricedAddress(chain, address);
  const market = await findBestMarket(chain, addr, client, hint);
  if (!market || market.liquidityUsd === null) return null;

  return {
    liquidityUsd: market.liquidityUsd,
    chain,
    tokenAddress: addr,
    quoteTokenAddress: market.quoteTokenAddress,
    poolAddress: market.pool.address,
    venue: market.pool.venue,
    method: market.pool.venue === "uniswap-v4" ? "v4-virtual-reserves" : "quote-balance-x2",
    warnings: [],
  };
}

function normalizePricedAddress(chain: EvmChainId, address: string): string {
  const addr = address.toLowerCase();
  return addr === NATIVE_TOKEN_PLACEHOLDER ? WETH[chain] : addr;
}
