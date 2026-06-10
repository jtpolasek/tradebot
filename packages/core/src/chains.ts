import type { ChainId, TokenRef } from "./types.js";

export const CHAIN_IDS = {
  eth: 1,
  base: 8453,
} as const;

export const WETH: Record<ChainId, string> = {
  eth: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
  base: "0x4200000000000000000000000000000000000006",
};

export const QUOTE_ASSETS: Record<ChainId, string[]> = {
  eth: [
    "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", // USDC
    "0xdac17f958d2ee523a2206206994597c13d831ec7", // USDT
    "0x6b175474e89094c44da98b954eedeac495271d0f", // DAI
    "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", // WETH
  ],
  base: [
    "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", // USDC
    "0x4200000000000000000000000000000000000006", // WETH
    "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf", // cbBTC
  ],
};

export const NATIVE_TOKEN_PLACEHOLDER = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

export function isQuoteAsset(chain: ChainId, address: string): boolean {
  return QUOTE_ASSETS[chain].includes(address.toLowerCase());
}

export function wethRef(chain: ChainId): TokenRef {
  const decimals = 18;
  const symbol = "WETH";
  return { chain, address: WETH[chain], symbol, decimals };
}

export const CHAINLINK_ETH_USD: Record<ChainId, string> = {
  eth: "0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419",
  base: "0x71041dddad3595f9ced3dccfbe3d1f4b0a16bb70",
};
