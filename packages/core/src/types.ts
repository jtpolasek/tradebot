/**
 * Chains the EVM AMM hot path can price on-chain (Uniswap/Aerodrome pool math, Chainlink, 0x).
 * Every `Record<EvmChainId, …>` map below is read only by the EVM watcher/decoder/pricing/engine,
 * so keeping it separate from `ChainId` proves at compile time that a non-EVM chain (Polymarket on
 * Polygon) can never index one — and spares us from fabricating placeholder addresses for it.
 */
export type EvmChainId = "eth" | "base";

/** Every chain we record trades for. `polygon` is Polymarket's parallel path; never AMM-priced. */
export type ChainId = EvmChainId | "polygon";

export interface TrackedWallet {
  id: string;
  chain: ChainId;
  address: string;
  label: string;
  active: boolean;
  autoCopy: boolean;
  addedAt: Date;
}

export interface RawTxEvent {
  /** Raw on-chain tx events are only produced by the EVM watchers — never a non-EVM chain. */
  chain: EvmChainId;
  source: "mempool" | "confirmed";
  txHash: string;
  from: string;
  to: string | null;
  blockNumber: number | null;
  observedAt: number;
  /** Block timestamp in epoch ms (UTC), confirmed events only. Used to detect stale (backfilled) trades. */
  blockTimestamp?: number;
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
  /**
   * Block timestamp in epoch ms (UTC) for confirmed signals. Transient (not persisted) —
   * the engine uses it to veto stale, backfilled trades whose observedAt was stamped at
   * processing time rather than when the trade actually happened.
   */
  blockTimestamp?: number | null;
  /**
   * Decoder's confidence in the classification. 'decoded' is copyable and counts toward
   * leader scoring; 'candidate' is persisted for human review but never auto-copied or scored.
   */
  decodeStatus: "decoded" | "candidate";
  /** Decoder confidence 0–1, when available. */
  confidence?: number | null;
  /** Human-readable explanation, primarily for candidates surfaced in the review queue. */
  reason?: string | null;
  /** Optional source-specific URL for candidate review, such as a Polymarket market page. */
  externalUrl?: string | null;
  /** Review workflow status for candidate signals. Decoded signals leave this null/undefined. */
  reviewStatus?: "pending" | "copy-requested" | "copying" | "copied" | "copy-failed" | "dismissed" | null;
  /**
   * Uniswap V4 poolId (the `bytes32 indexed id` from the Swap event), lowercase hex. V4 pools live
   * in a singleton PoolManager and can't be discovered on-chain by token pair, so pricing reads this
   * back to value V4-only tokens via StateView. Null/undefined for every non-V4 venue.
   */
  poolId?: string | null;
  /**
   * Polymarket condition identifier. Persisted so a later resolution-settlement job can map a held
   * outcome share back to the market that resolves it. Null/undefined for non-Polymarket venues.
   */
  conditionId?: string | null;
  /**
   * Polymarket outcome index within the condition. Needed alongside conditionId to decide whether a
   * held outcome share resolves to $1 or $0. Null/undefined for non-Polymarket venues.
   */
  outcomeIndex?: number | null;
}

export interface TokenRef {
  chain: ChainId;
  address: string;
  symbol: string;
  name?: string;
  decimals: number;
}

/** Realized PnL rollup for a single token across the portfolio's positions. */
export interface PortfolioAnalyticsTokenResult {
  chain: ChainId;
  tokenAddress: string;
  symbol: string;
  name?: string;
  realizedPnlUsd: number;
  closedTrades: number;
}

/**
 * Aggregate portfolio performance. A "closed trade" is a position with a closedAt stamp;
 * win/loss is judged on its realized PnL. Manual candidate copies flow through the normal
 * fill/position path, so they are counted here like any other copy.
 */
export interface PortfolioAnalytics {
  closedTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number | null;        // winningTrades / closedTrades
  realizedPnlUsd: number;        // summed across all positions
  totalFeesUsd: number;          // gas + dex fees over copied fills
  totalNotionalUsd: number;      // copied fill notional
  feeDrag: number | null;        // totalFeesUsd / totalNotionalUsd
  averageHoldHours: number | null;
  openExposureUsd: number;       // cost basis of open positions
  copiedFills: number;
  skippedFills: number;
  skipRate: number | null;       // skippedFills / (copied + skipped)
  byToken: PortfolioAnalyticsTokenResult[];
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
  // Provenance of the reference (gating) spot price and the liquidity used for the decision.
  // Populated on copied fills; null on skips and rule-driven exits.
  priceSource?: string;
  priceVenue?: string;
  pricePoolAddress?: string;
  liquidityUsd?: number;
}
