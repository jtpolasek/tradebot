export type NormalizedTransfer = {
  tokenAddress: string;   // lowercase contract address, "" for native ETH
  symbol: string;
  decimals: number;
  amountRaw: bigint;
  amountHuman: number;    // amountRaw / 10^decimals — used for scoring only
  direction: "in" | "out";
};

export type BalanceDeltaResult = {
  status: "decoded" | "candidate" | "skipped";
  side: "buy" | "sell" | "unknown";
  confidence: number;
  reason: string;
  tokenIn: NormalizedTransfer | null;
  tokenOut: NormalizedTransfer | null;
};
