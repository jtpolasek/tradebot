import { decodeEventLog } from "viem";
import type { RawTxEvent, TradeSignal, ChainId } from "@tradebot/core";
import { VENUE_ABIS, VENUE_TOPIC_MAP, TRANSFER_TOPIC } from "./venues.js";
import type { TokenMetadataResolver } from "./tokenMetadata.js";

type Log = NonNullable<RawTxEvent["logs"]>[number];

/** Returns null if Strategy A can't decode (fall through to B). */
export async function strategyA(
  event: RawTxEvent,
  walletAddress: string,
  meta: TokenMetadataResolver,
  _signalId: string
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
      return await decodeV2Swap(swapLog, event, walletAddress, meta);
    }
    if (venueKey === "UNISWAP_V3_SWAP") {
      return await decodeV3Swap(swapLog, event, walletAddress, meta);
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
  meta: TokenMetadataResolver
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
  meta: TokenMetadataResolver
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

  const [metaIn, metaOut] = await Promise.all([
    meta.resolve(event.chain, tokenInAddr),
    meta.resolve(event.chain, tokenOutAddr),
  ]);

  const venue = detectV3Venue(swapLog.address.toLowerCase(), event.chain);

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

function detectV3Venue(poolAddress: string, chain: ChainId): string {
  void poolAddress; void chain;
  // Could check against known Aerodrome CL pools for Base — for now default to uniswap-v3
  return "uniswap-v3";
}
