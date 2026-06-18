import { describe, it, expect } from "vitest";
import {
  estimateCuBudget,
  CU_COSTS,
  FREE_TIER_MONTHLY_CU,
} from "./cuBudget.js";

describe("estimateCuBudget", () => {
  it("scales subscriptions per 50-wallet chunk, not per wallet", () => {
    // 100 wallets → 2 log chunks → 2*2 (from+to) + 2 (mempool) + 1 (heads) = 7
    expect(estimateCuBudget({ chain: "eth", walletCount: 100 }).subscriptionCount).toBe(7);
    // 51 wallets still needs 2 chunks → same as 100
    expect(estimateCuBudget({ chain: "eth", walletCount: 51 }).subscriptionCount).toBe(7);
    // 50 wallets → 1 chunk → 1*2 + 1 + 1 = 4
    expect(estimateCuBudget({ chain: "eth", walletCount: 50 }).subscriptionCount).toBe(4);
  });

  it("computes per-trade CU as receipt + tx + block", () => {
    const est = estimateCuBudget({ chain: "eth", walletCount: 10 });
    expect(est.cuPerTrade).toBe(
      CU_COSTS.getTransactionReceipt + CU_COSTS.getTransactionByHash + CU_COSTS.getBlockByNumber
    );
  });

  it("steady-state CU scales linearly with wallets and trade rate", () => {
    const a = estimateCuBudget({ chain: "eth", walletCount: 10, tradesPerWalletPerDay: 2, reconnectsPerDay: 0 });
    const b = estimateCuBudget({ chain: "eth", walletCount: 20, tradesPerWalletPerDay: 2, reconnectsPerDay: 0 });
    expect(a.steadyStateCuPerDay).toBe(10 * 2 * a.cuPerTrade);
    expect(b.steadyStateCuPerDay).toBe(2 * a.steadyStateCuPerDay);
    // With no reconnects, the day total is purely steady state.
    expect(a.estCuPerDay).toBe(a.steadyStateCuPerDay);
  });

  it("backfill CU dominates as the wallet set grows", () => {
    const small = estimateCuBudget({ chain: "eth", walletCount: 50, reconnectsPerDay: 4 });
    const large = estimateCuBudget({ chain: "eth", walletCount: 500, reconnectsPerDay: 4 });
    expect(large.backfillCuPerReconnect).toBeGreaterThan(small.backfillCuPerReconnect);
    // ETH: 150 blocks / 10 = 15 block-chunks; 500 wallets / 50 addr = 10 addr-chunks; ×2 = 300 getLogs.
    const getLogsCu = 300 * CU_COSTS.getLogs;
    expect(large.backfillCuPerReconnect).toBeGreaterThanOrEqual(getLogsCu);
  });

  it("Base fans out more address-chunks (chunk size 5) than ETH", () => {
    const eth = estimateCuBudget({ chain: "eth", walletCount: 100, reconnectsPerDay: 1, tradesPerWalletPerDay: 0 });
    const base = estimateCuBudget({ chain: "base", walletCount: 100, reconnectsPerDay: 1, tradesPerWalletPerDay: 0 });
    expect(base.backfillCuPerReconnect).toBeGreaterThan(eth.backfillCuPerReconnect);
  });

  it("reports monthly usage as a percentage of the free-tier allowance", () => {
    const est = estimateCuBudget({ chain: "eth", walletCount: 100 });
    expect(est.freeTierMonthlyPct).toBeCloseTo((est.estCuPerMonth / FREE_TIER_MONTHLY_CU) * 100, 6);
    expect(est.estCuPerMonth).toBe(est.estCuPerDay * 30);
  });

  it("handles zero wallets without backfill cost", () => {
    const est = estimateCuBudget({ chain: "eth", walletCount: 0 });
    expect(est.subscriptionCount).toBe(1);
    expect(est.estTradesPerDay).toBe(0);
    expect(est.backfillCuPerReconnect).toBe(CU_COSTS.subscribe + CU_COSTS.blockNumber);
  });
});
