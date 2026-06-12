import { decodeEventLog, parseAbi } from "viem";
import type { RawTxEvent, TradeSignal, ChainId } from "@tradebot/core";
import { KNOWN_FACTORIES, VENUE_ABIS, VENUE_TOPIC_MAP, TRANSFER_TOPIC } from "./venues.js";
import type { TokenMetadataResolver } from "./tokenMetadata.js";

type Log = NonNullable<RawTxEvent["logs"]>[number];
type ReadContractClient = {
  readContract: (args: {
    address: `0x${string}`;
    abi: readonly unknown[];
    functionName: string;
    args?: readonly unknown[];
  }) => Promise<unknown>;
};

export type StrategyAClients = Partial<Record<ChainId, ReadContractClient>>;

const V2_FACTORY_ABI = parseAbi(["function getPair(address tokenA, address tokenB) view returns (address pair)"]);
const V3_FACTORY_ABI = parseAbi(["function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)"]);
const AERODROME_CL_FACTORY_ABI = parseAbi(["function getPool(address tokenA, address tokenB, int24 tickSpacing) view returns (address pool)"]);
const V3_POOL_ABI = parseAbi(["function fee() view returns (uint24)"]);
const AERODROME_CL_POOL_ABI = parseAbi(["function tickSpacing() view returns (int24)"]);
const NULL_ADDR = "0x0000000000000000000000000000000000000000";
const poolVerificationCache = new Map<string, string | null>();

/** Returns null if Strategy A can't decode (fall through to B). */
export async function strategyA(
  event: RawTxEvent,
  walletAddress: string,
  meta: TokenMetadataResolver,
  _signalId: string,
  clients: StrategyAClients = {}
): Promise<Pick<TradeSignal, "tokenIn" | "tokenOut" | "amountIn" | "amountOut" | "venue"> | null> {
  if (!event.logs || event.logs.length === 0) return null;

  const swapLogs = event.logs.filter((log) => {
    const topic0 = log.topics[0]?.toLowerCase();
    return topic0 !== undefined && topic0 in VENUE_TOPIC_MAP;
  });

  if (swapLogs.length === 0) return null;

  // Multiple distinct swap venues = aggregator split — fall through to Strategy B
  const swapVenues = new Set(swapLogs.map((l) => VENUE_TOPIC_MAP[l.topics[0]!.toLowerCase()]!));
  const uniqueSwapTypes = new Set(
    [...swapVenues].filter((v) => v === "UNISWAP_V2_SWAP" || v === "UNISWAP_V3_SWAP" || v === "UNISWAP_V4_SWAP")
  );
  if (uniqueSwapTypes.size > 1) return null;

  // Multiple Swap logs of the same type = aggregator split — fall through to Strategy B
  const mainSwapLogs = swapLogs.filter((l) => {
    const k = VENUE_TOPIC_MAP[l.topics[0]!.toLowerCase()];
    return k === "UNISWAP_V2_SWAP" || k === "UNISWAP_V3_SWAP" || k === "UNISWAP_V4_SWAP";
  });
  if (mainSwapLogs.length > 1) return null;

  const swapLog = mainSwapLogs[0];
  if (!swapLog) return null;

  const venueKey = VENUE_TOPIC_MAP[swapLog.topics[0]!.toLowerCase()];

  try {
    if (venueKey === "UNISWAP_V2_SWAP") {
      return await decodeV2Swap(swapLog, event, walletAddress, meta, clients);
    }
    if (venueKey === "UNISWAP_V3_SWAP") {
      return await decodeV3Swap(swapLog, event, walletAddress, meta, clients);
    }
    if (venueKey === "UNISWAP_V4_SWAP") {
      return await decodeV4Swap(swapLog, event, walletAddress, meta);
    }
  } catch {
    return null;
  }

  return null;
}

async function decodeV2Swap(
  swapLog: Log,
  event: RawTxEvent,
  walletAddress: string,
  meta: TokenMetadataResolver,
  clients: StrategyAClients
): Promise<Pick<TradeSignal, "tokenIn" | "tokenOut" | "amountIn" | "amountOut" | "venue"> | null> {
  const decoded = decodeEventLog({
    abi: [VENUE_ABIS.UNISWAP_V2_SWAP],
    data: swapLog.data as `0x${string}`,
    topics: swapLog.topics as [`0x${string}`, ...`0x${string}`[]],
    strict: false,
  });

  const { amount0In, amount1In, amount0Out, amount1Out } = decoded.args as {
    amount0In: bigint;
    amount1In: bigint;
    amount0Out: bigint;
    amount1Out: bigint;
  };

  // Determine which direction: token0 in / token1 out, or token1 in / token0 out
  const token0IsIn = amount0In > 0n && amount1Out > 0n;
  const token1IsIn = amount1In > 0n && amount0Out > 0n;
  if (!token0IsIn && !token1IsIn) return null;

  const amountIn = token0IsIn ? amount0In : amount1In;
  const amountOut = token0IsIn ? amount1Out : amount0Out;

  // Find token addresses from Transfer logs
  const poolAddress = swapLog.address.toLowerCase();
  const { tokenIn: tokenInAddr, tokenOut: tokenOutAddr } = resolveTokensFromTransfers(
    event.logs ?? [],
    poolAddress,
    walletAddress.toLowerCase(),
    token0IsIn
  );
  if (!tokenInAddr || !tokenOutAddr) return null;

  const token0Addr = token0IsIn ? tokenInAddr : tokenOutAddr;
  const token1Addr = token0IsIn ? tokenOutAddr : tokenInAddr;
  const verified = await verifyV2Pool(event.chain, poolAddress, token0Addr, token1Addr, clients);
  if (!verified) return null;

  const [metaIn, metaOut] = await Promise.all([
    meta.resolve(event.chain, tokenInAddr),
    meta.resolve(event.chain, tokenOutAddr),
  ]);

  return {
    tokenIn: { chain: event.chain, address: tokenInAddr, symbol: metaIn.symbol, decimals: metaIn.decimals },
    tokenOut: { chain: event.chain, address: tokenOutAddr, symbol: metaOut.symbol, decimals: metaOut.decimals },
    amountIn,
    amountOut,
    venue: "uniswap-v2",
  };
}

async function decodeV3Swap(
  swapLog: Log,
  event: RawTxEvent,
  walletAddress: string,
  meta: TokenMetadataResolver,
  clients: StrategyAClients
): Promise<Pick<TradeSignal, "tokenIn" | "tokenOut" | "amountIn" | "amountOut" | "venue"> | null> {
  const decoded = decodeEventLog({
    abi: [VENUE_ABIS.UNISWAP_V3_SWAP],
    data: swapLog.data as `0x${string}`,
    topics: swapLog.topics as [`0x${string}`, ...`0x${string}`[]],
    strict: false,
  });

  const { amount0, amount1 } = decoded.args as { amount0: bigint; amount1: bigint };

  // Positive = went INTO pool (tokenIn), negative = came OUT of pool (tokenOut)
  const token0IsIn = amount0 > 0n;
  const amountIn = token0IsIn ? amount0 : amount1;
  const amountOut = token0IsIn ? -amount1 : -amount0;
  if (amountIn <= 0n || amountOut <= 0n) return null;

  const poolAddress = swapLog.address.toLowerCase();
  const { tokenIn: tokenInAddr, tokenOut: tokenOutAddr } = resolveTokensFromTransfers(
    event.logs ?? [],
    poolAddress,
    walletAddress.toLowerCase(),
    token0IsIn
  );
  if (!tokenInAddr || !tokenOutAddr) return null;

  const token0Addr = token0IsIn ? tokenInAddr : tokenOutAddr;
  const token1Addr = token0IsIn ? tokenOutAddr : tokenInAddr;
  const venue = await verifyV3Pool(event.chain, poolAddress, token0Addr, token1Addr, clients);
  if (!venue) return null;

  const [metaIn, metaOut] = await Promise.all([
    meta.resolve(event.chain, tokenInAddr),
    meta.resolve(event.chain, tokenOutAddr),
  ]);

  return {
    tokenIn: { chain: event.chain, address: tokenInAddr, symbol: metaIn.symbol, decimals: metaIn.decimals },
    tokenOut: { chain: event.chain, address: tokenOutAddr, symbol: metaOut.symbol, decimals: metaOut.decimals },
    amountIn,
    amountOut,
    venue,
  };
}

async function decodeV4Swap(
  swapLog: Log,
  event: RawTxEvent,
  walletAddress: string,
  meta: TokenMetadataResolver
): Promise<Pick<TradeSignal, "tokenIn" | "tokenOut" | "amountIn" | "amountOut" | "venue"> | null> {
  const decoded = decodeEventLog({
    abi: [VENUE_ABIS.UNISWAP_V4_SWAP],
    data: swapLog.data as `0x${string}`,
    topics: swapLog.topics as [`0x${string}`, ...`0x${string}`[]],
    strict: false,
  });

  const { amount0, amount1 } = decoded.args as { amount0: bigint; amount1: bigint };

  const token0IsIn = amount0 > 0n;
  const amountIn = token0IsIn ? amount0 : amount1;
  const amountOut = token0IsIn ? -amount1 : -amount0;
  if (amountIn <= 0n || amountOut <= 0n) return null;

  // For V4, use Transfer logs from the receipt to identify tokens
  const { tokenIn: tokenInAddr, tokenOut: tokenOutAddr } = resolveTokensFromTransfersV4(
    event.logs ?? [],
    walletAddress.toLowerCase()
  );
  if (!tokenInAddr || !tokenOutAddr) return null;

  const [metaIn, metaOut] = await Promise.all([
    meta.resolve(event.chain, tokenInAddr),
    meta.resolve(event.chain, tokenOutAddr),
  ]);

  return {
    tokenIn: { chain: event.chain, address: tokenInAddr, symbol: metaIn.symbol, decimals: metaIn.decimals },
    tokenOut: { chain: event.chain, address: tokenOutAddr, symbol: metaOut.symbol, decimals: metaOut.decimals },
    amountIn,
    amountOut,
    venue: "uniswap-v4",
  };
}

/** Find tokenIn/tokenOut by looking at which Transfer logs reference the pool. */
function resolveTokensFromTransfers(
  logs: Log[],
  poolAddress: string,
  walletAddress: string,
  token0IsIn: boolean
): { tokenIn: string | null; tokenOut: string | null } {
  const padded = (addr: string) => addr.replace("0x", "0x000000000000000000000000").toLowerCase();
  const paddedPool = padded(poolAddress);
  const paddedWallet = padded(walletAddress);

  const transferLogs = logs.filter((l) => l.topics[0]?.toLowerCase() === TRANSFER_TOPIC);

  // tokenIn: Transfer where `to` = pool (token going into pool)
  const inLog = transferLogs.find((l) => l.topics[2]?.toLowerCase() === paddedPool);
  // tokenOut: Transfer where `from` = pool (token coming out of pool)
  const outLog = transferLogs.find((l) => l.topics[1]?.toLowerCase() === paddedPool);

  // If can't find pool-referenced transfers, try wallet-referenced ones
  const walletOutLog = inLog ?? transferLogs.find((l) => l.topics[1]?.toLowerCase() === paddedWallet);
  const walletInLog = outLog ?? transferLogs.find((l) => l.topics[2]?.toLowerCase() === paddedWallet);

  return {
    tokenIn: walletOutLog?.address.toLowerCase() ?? null,
    tokenOut: walletInLog?.address.toLowerCase() ?? null,
  };
}

/** V4: no pool address to pivot on — use wallet transfers directly. */
function resolveTokensFromTransfersV4(
  logs: Log[],
  walletAddress: string
): { tokenIn: string | null; tokenOut: string | null } {
  const padded = (addr: string) => addr.replace("0x", "0x000000000000000000000000").toLowerCase();
  const paddedWallet = padded(walletAddress);

  const transferLogs = logs.filter((l) => l.topics[0]?.toLowerCase() === TRANSFER_TOPIC);

  const outLog = transferLogs.find((l) => l.topics[1]?.toLowerCase() === paddedWallet);
  const inLog = transferLogs.find((l) => l.topics[2]?.toLowerCase() === paddedWallet);

  return {
    tokenIn: outLog?.address.toLowerCase() ?? null,
    tokenOut: inLog?.address.toLowerCase() ?? null,
  };
}

async function verifyV2Pool(
  chain: ChainId,
  poolAddress: string,
  token0: string,
  token1: string,
  clients: StrategyAClients
): Promise<boolean> {
  const factory = KNOWN_FACTORIES[chain].v2;
  const client = clients[chain];
  if (!factory || !client) return true;

  const cacheKey = `${chain}:v2:${poolAddress}`;
  const cached = poolVerificationCache.get(cacheKey);
  if (cached !== undefined) return cached === "uniswap-v2";

  const pair = await client.readContract({
    address: factory as `0x${string}`,
    abi: V2_FACTORY_ABI,
    functionName: "getPair",
    args: [token0 as `0x${string}`, token1 as `0x${string}`],
  });
  const verified = normalizeAddress(pair) === poolAddress && normalizeAddress(pair) !== NULL_ADDR;
  poolVerificationCache.set(cacheKey, verified ? "uniswap-v2" : null);
  return verified;
}

async function verifyV3Pool(
  chain: ChainId,
  poolAddress: string,
  token0: string,
  token1: string,
  clients: StrategyAClients
): Promise<string | null> {
  const uniFactory = KNOWN_FACTORIES[chain].v3;
  const aerodromeFactory = KNOWN_FACTORIES[chain].aerodromeCl;
  const client = clients[chain];
  if (!client) return "uniswap-v3";

  const cacheKey = `${chain}:v3:${poolAddress}`;
  const cached = poolVerificationCache.get(cacheKey);
  if (cached !== undefined) return cached;

  if (uniFactory) {
    try {
      const fee = await client.readContract({
        address: poolAddress as `0x${string}`,
        abi: V3_POOL_ABI,
        functionName: "fee",
      });
      if (typeof fee === "number") {
        const pool = await client.readContract({
          address: uniFactory as `0x${string}`,
          abi: V3_FACTORY_ABI,
          functionName: "getPool",
          args: [token0 as `0x${string}`, token1 as `0x${string}`, fee],
        });
        if (normalizeAddress(pool) === poolAddress && normalizeAddress(pool) !== NULL_ADDR) {
          poolVerificationCache.set(cacheKey, "uniswap-v3");
          return "uniswap-v3";
        }
      }
    } catch {
      // Try Aerodrome CL below.
    }
  }

  if (aerodromeFactory) {
    try {
      const tickSpacing = await client.readContract({
        address: poolAddress as `0x${string}`,
        abi: AERODROME_CL_POOL_ABI,
        functionName: "tickSpacing",
      });
      if (typeof tickSpacing === "number") {
        const pool = await client.readContract({
          address: aerodromeFactory as `0x${string}`,
          abi: AERODROME_CL_FACTORY_ABI,
          functionName: "getPool",
          args: [token0 as `0x${string}`, token1 as `0x${string}`, tickSpacing],
        });
        if (normalizeAddress(pool) === poolAddress && normalizeAddress(pool) !== NULL_ADDR) {
          poolVerificationCache.set(cacheKey, "aerodrome");
          return "aerodrome";
        }
      }
    } catch {
      // Fall through to rejected.
    }
  }

  poolVerificationCache.set(cacheKey, null);
  return null;
}

function normalizeAddress(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase() : "";
}
