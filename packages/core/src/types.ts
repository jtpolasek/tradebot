export type ChainId = "eth" | "base";

export interface TrackedWallet {
  id: string;
  chain: ChainId;
  address: string;
  label: string;
  active: boolean;
  addedAt: Date;
}

export interface RawTxEvent {
  chain: ChainId;
  source: "mempool" | "confirmed";
  txHash: string;
  from: string;
  to: string | null;
  blockNumber: number | null;
  observedAt: number;
  input?: `0x${string}`;
  logs?: { address: string; topics: string[]; data: string }[];
  status?: "success" | "reverted";
  nonce?: number;
  valueWei?: bigint;
}

export interface TradeSignal {
  id: string;
  chain: ChainId;
  walletId: string;
  txHash: string;
  source: "mempool" | "confirmed";
  side: "buy" | "sell";
  tokenIn: TokenRef;
  tokenOut: TokenRef;
  amountIn: bigint;
  amountOut: bigint;
  venue: string;
  observedAt: number;
  confirmedAt: number | null;
  blockNumber: number | null;
}

export interface TokenRef {
  chain: ChainId;
  address: string;
  symbol: string;
  decimals: number;
}

export interface PaperFill {
  id: string;
  signalId: string;
  decidedAt: number;
  decision: "copied" | "skipped";
  skipReason?: string;
  side: "buy" | "sell";
  token: TokenRef;
  quoteToken: TokenRef;
  qty: number;
  priceUsd: number;
  notionalUsd: number;
  feeUsd: number;
  slippageBps: number;
  latencyMs: number;
  provisional: boolean;
}
