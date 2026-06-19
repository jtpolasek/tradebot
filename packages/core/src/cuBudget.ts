import type { EvmChainId } from "./types.js";

/**
 * Wallet-batching and reconnect-backfill topology constants. These live in core as the
 * single source of truth: ChainWatcher consumes them operationally, and the CU budget
 * below reasons about them. Keep them in sync with how the watcher actually batches.
 * Only EVM chains hit Alchemy, hence `EvmChainId`.
 */
export const CHUNK_SIZE = 50;
export const BACKFILL_CHUNK_BY_CHAIN: Record<EvmChainId, number> = {
  eth: 10,
  base: 10,
};
export const BACKFILL_ADDRESS_CHUNK_BY_CHAIN: Record<EvmChainId, number> = {
  eth: CHUNK_SIZE,
  base: 5,
};
// Cap how far back a reconnect will backfill — roughly 30 minutes of blocks per chain.
export const MAX_BACKFILL_BLOCKS_BY_CHAIN: Record<EvmChainId, number> = {
  eth: 150, // ~12s blocks → ~30 min
  base: 900, // ~2s blocks → ~30 min
};

/**
 * Approximate Alchemy compute-unit (CU) costs per JSON-RPC method.
 * Source: Alchemy's published per-method CU table. Treat as order-of-magnitude —
 * Alchemy revises these, so the budget below is an estimate, not a guarantee.
 */
export const CU_COSTS = {
  getTransactionReceipt: 15,
  getTransactionByHash: 15,
  getBlockByNumber: 16,
  getLogs: 75,
  blockNumber: 10,
  subscribe: 10,
} as const;

/** Alchemy Free-tier monthly CU allowance, for the headroom percentage. */
export const FREE_TIER_MONTHLY_CU = 300_000_000;

/**
 * Default modelling assumptions. These drive the *event-driven* portion of the
 * estimate and are the biggest source of uncertainty — override them with what you
 * actually observe for your wallet set.
 */
export const DEFAULT_TRADES_PER_WALLET_PER_DAY = 5;
export const DEFAULT_RECONNECTS_PER_DAY = 4;

export interface CuBudgetInput {
  chain: EvmChainId;
  walletCount: number;
  /** Assumed confirmed trades per watched wallet per day. */
  tradesPerWalletPerDay?: number;
  /** Assumed (re)connects per day; each may replay a full backfill window of getLogs. */
  reconnectsPerDay?: number;
}

export interface CuBudgetEstimate {
  chain: EvmChainId;
  walletCount: number;
  /** Steady-state concurrent subscriptions (logs from+to, mempool, one newHeads). */
  subscriptionCount: number;
  /** CU to materialise one observed confirmed trade (receipt + tx + block). */
  cuPerTrade: number;
  estTradesPerDay: number;
  /** Event-driven CU/day from materialising observed trades. */
  steadyStateCuPerDay: number;
  /** Worst-case CU for one full-window reconnect backfill. */
  backfillCuPerReconnect: number;
  backfillCuPerDay: number;
  estCuPerDay: number;
  estCuPerMonth: number;
  /** Estimated monthly CU as a % of the Free-tier allowance. */
  freeTierMonthlyPct: number;
}

/**
 * Estimate Alchemy CU consumption for one chain's watcher.
 *
 * The model reflects how `ChainWatcher` actually spends CU:
 *  - Wallets are batched (CHUNK_SIZE), so subscriptions scale with ceil(N/50), not N.
 *  - Steady-state cost is event-driven: each *confirmed* trade triggers getReceipt +
 *    getTransaction + getBlock. Mempool detection is push-based and adds no per-tx CU.
 *  - The spiky cost is reconnect backfill: getLogs fanned out over block- and
 *    address-chunks (the dominant term as the wallet set grows).
 *
 * Subscription notification pushes (new heads, matched logs) are not modelled as
 * per-message CU — Alchemy meters the one-time eth_subscribe, included in backfill setup.
 */
export function estimateCuBudget(input: CuBudgetInput): CuBudgetEstimate {
  const { chain, walletCount } = input;
  const tradesPerWalletPerDay = input.tradesPerWalletPerDay ?? DEFAULT_TRADES_PER_WALLET_PER_DAY;
  const reconnectsPerDay = input.reconnectsPerDay ?? DEFAULT_RECONNECTS_PER_DAY;

  const logChunks = Math.ceil(walletCount / CHUNK_SIZE);
  const subscriptionCount = walletCount === 0 ? 1 : logChunks * 2 + logChunks + 1;

  const cuPerTrade =
    CU_COSTS.getTransactionReceipt + CU_COSTS.getTransactionByHash + CU_COSTS.getBlockByNumber;
  const estTradesPerDay = walletCount * tradesPerWalletPerDay;
  const steadyStateCuPerDay = estTradesPerDay * cuPerTrade;

  // Worst case: a reconnect backfills the full capped window.
  const blocks = MAX_BACKFILL_BLOCKS_BY_CHAIN[chain];
  const blockChunks = Math.ceil(blocks / BACKFILL_CHUNK_BY_CHAIN[chain]);
  const addrChunks = Math.ceil(walletCount / BACKFILL_ADDRESS_CHUNK_BY_CHAIN[chain]);
  // Two getLogs calls (from + to) per (block-chunk × address-chunk).
  const getLogsCalls = walletCount === 0 ? 0 : blockChunks * addrChunks * 2;
  const setupCu = subscriptionCount * CU_COSTS.subscribe + CU_COSTS.blockNumber;
  const backfillCuPerReconnect = getLogsCalls * CU_COSTS.getLogs + setupCu;
  const backfillCuPerDay = backfillCuPerReconnect * reconnectsPerDay;

  const estCuPerDay = steadyStateCuPerDay + backfillCuPerDay;
  const estCuPerMonth = estCuPerDay * 30;
  const freeTierMonthlyPct = (estCuPerMonth / FREE_TIER_MONTHLY_CU) * 100;

  return {
    chain,
    walletCount,
    subscriptionCount,
    cuPerTrade,
    estTradesPerDay,
    steadyStateCuPerDay,
    backfillCuPerReconnect,
    backfillCuPerDay,
    estCuPerDay,
    estCuPerMonth,
    freeTierMonthlyPct,
  };
}
