import { parseAbiItem, keccak256, toBytes } from "viem";
import type { ChainId } from "@tradebot/core";

export const VENUE_ABIS = {
  UNISWAP_V2_SWAP: parseAbiItem(
    "event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)"
  ),
  UNISWAP_V3_SWAP: parseAbiItem(
    "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)"
  ),
  UNISWAP_V4_SWAP: parseAbiItem(
    "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)"
  ),
  WETH_DEPOSIT: parseAbiItem("event Deposit(address indexed dst, uint256 wad)"),
  WETH_WITHDRAWAL: parseAbiItem("event Withdrawal(address indexed src, uint256 wad)"),
} as const;

function topicHash(sig: string): `0x${string}` {
  return keccak256(toBytes(sig));
}

export const VENUE_TOPIC_MAP: Record<string, keyof typeof VENUE_ABIS> = {
  [topicHash("Swap(address,uint256,uint256,uint256,uint256,address)")]: "UNISWAP_V2_SWAP",
  [topicHash("Swap(address,address,int256,int256,uint160,uint128,int24)")]: "UNISWAP_V3_SWAP",
  [topicHash("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)")]: "UNISWAP_V4_SWAP",
  [topicHash("Deposit(address,uint256)")]: "WETH_DEPOSIT",
  [topicHash("Withdrawal(address,uint256)")]: "WETH_WITHDRAWAL",
};

// Pre-computed for reference (matches PLAN.md §status.md Critical Technical Details)
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

// WETH wrap/unwrap events — used to detect native-ETH legs of a swap from receipt logs.
export const WETH_DEPOSIT_TOPIC = topicHash("Deposit(address,uint256)");
export const WETH_WITHDRAWAL_TOPIC = topicHash("Withdrawal(address,uint256)");

// Known factory/singleton addresses for pool-origin verification
export const KNOWN_FACTORIES: Record<ChainId, { v2?: string; v3?: string; v4PoolManager?: string }> = {
  eth: {
    v2: "0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f",
    v3: "0x1f98431c8ad98523631ae4a59f267346ea31f984",
    v4PoolManager: "0x000000000004444c5dc75cb358380d2e3de08a90",
  },
  base: {
    v2: "0x8909dc15e40173ff4699343b6eb8132c65e18ec6",
    v3: "0x33128a8fc17869897dce68ed026d694621f6fdfd",
    v4PoolManager: "0x498581ff718922c3f8e6a244b8e9b1a0f10e6b44",
  },
};
