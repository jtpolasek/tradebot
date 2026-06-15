import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomUUID } from "crypto";
import { sql } from "drizzle-orm";
import { EventBus, type TradeSignal, type TokenRef } from "@tradebot/core";
import {
  getDb,
  closeDb,
  insertWallet,
  getOpenPositions,
  getRecentFills,
  setSetting,
  upsertToken,
  upsertPosition,
  insertPriceMark,
  insertSnapshot,
  latestSnapshot,
  insertSignal,
  getSignalById,
} from "@tradebot/store";
import { PaperEngine } from "./engine.js";

// Require test DB
const TEST_DB_URL = process.env["TEST_DATABASE_URL"];
if (!TEST_DB_URL) throw new Error("TEST_DATABASE_URL is required");
if (!TEST_DB_URL.endsWith("_test")) throw new Error("TEST_DATABASE_URL must end in _test");

// Mock pricing so tests are deterministic and offline
vi.mock("@tradebot/pricing", () => ({
  assertUsableZeroxQuote: vi.fn(),
  getLiquidityUsd: vi.fn().mockResolvedValue(1_000_000),
  getUsdPrice: vi.fn().mockResolvedValue(10),
  getZeroxPrice: vi.fn(),
}));

import { getLiquidityUsd, getUsdPrice, getZeroxPrice } from "@tradebot/pricing";

const mockRpcClient = { readContract: vi.fn() };

const USDC: TokenRef = { chain: "eth", address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", symbol: "USDC", decimals: 6 };
const TOKEN_A: TokenRef = { chain: "eth", address: "0xaaaa000000000000000000000000000000000001", symbol: "TKNA", decimals: 18 };
const TOKEN_B: TokenRef = { chain: "eth", address: "0xbbbb000000000000000000000000000000000002", symbol: "TKNB", decimals: 18 };

function makeSignal(overrides: Partial<TradeSignal> & { walletId: string }): TradeSignal {
  return {
    id: randomUUID(),
    chain: "eth",
    txHash: `0x${randomUUID().replace(/-/g, "")}`,
    source: "confirmed",
    side: "buy",
    tokenIn: USDC,
    tokenOut: TOKEN_A,
    amountIn: 1000_000_000n,
    amountOut: 100_000_000_000_000_000_000n,
    venue: "uniswap-v3",
    observedAt: Date.now() - 100,
    confirmedAt: Date.now(),
    blockNumber: 20_000_000,
    decodeStatus: "decoded",
    ...overrides,
  };
}

function cfg(overrides: Record<string, unknown> = {}) {
  return {
    DATABASE_URL: TEST_DB_URL!,
    ALCHEMY_API_KEY: "test",
    API_KEY: "test",
    PAPER_STARTING_CASH_USD: 10_000,
    BASE_TRADE_PCT: 0.01,
    MAX_TRADE_PCT: 0.03,
    MIN_NOTIONAL_USD: 50,
    MIN_LIQUIDITY_USD: 150_000,
    MAX_SIGNAL_AGE_SEC: 180,
    COPY_DELAY_PENALTY_BPS_ETH: 10,
    COPY_DELAY_PENALTY_BPS_BASE: 5,
    GAS_USD_ETH: 4,
    GAS_USD_BASE: 0.03,
    SIZING_MODE: "fixed" as const,
    LOG_LEVEL: "error" as const,
    ...overrides,
  };
}

let db: ReturnType<typeof getDb>;
let walletId: string;

beforeAll(async () => {
  db = getDb(TEST_DB_URL);
  // Truncate in dependency order
  await db.execute(sql`TRUNCATE portfolio_snapshots CASCADE`);
  await db.execute(sql`TRUNCATE paper_fills CASCADE`);
  await db.execute(sql`TRUNCATE positions CASCADE`);
  await db.execute(sql`TRUNCATE price_marks CASCADE`);
  await db.execute(sql`TRUNCATE trade_signals CASCADE`);
  await db.execute(sql`TRUNCATE tokens CASCADE`);
  await db.execute(sql`TRUNCATE wallets CASCADE`);

  const wallet = await insertWallet(db, { chain: "eth", address: "0x1eade00000000000000000000000000000000001", label: "Leader", active: true });
  walletId = wallet.id;
});

afterAll(async () => {
  await closeDb();
});

beforeEach(() => {
  vi.mocked(getLiquidityUsd).mockResolvedValue(1_000_000);
  vi.mocked(getUsdPrice).mockResolvedValue(10);
  vi.mocked(getZeroxPrice).mockReset();
  return db.execute(sql`TRUNCATE settings CASCADE`);
});

describe("PaperEngine integration", () => {
  it("processes 20 scripted signals and produces correct final state", async () => {
    const bus = new EventBus();
    const engine = new PaperEngine(db, bus, cfg() as never, mockRpcClient as never);
    await engine.start();

    // Price: TOKEN_A = $10, TOKEN_B = $5
    vi.mocked(getUsdPrice).mockImplementation(async (_chain, addr) => {
      if (addr === TOKEN_A.address) return 10;
      if (addr === TOKEN_B.address) return 5;
      return 1;
    });

    // Signals 1-5: 5 buys of TOKEN_A
    // equity=10000, notional = 10000 * 0.01 * 1 = 100, capped to 300 max
    // slippageBps = 30 (dex) + impact(100/(2*1000000)*10000=0) + 10 (delay) = 40
    // fillPrice = 10 * 1.004 = 10.04
    // qty = 100 / 10.04 ≈ 9.960
    // feeUsd = 4 + (100 * 30/10000) = 4.30
    // cashSpent = 100 + 4.30 = 104.30
    for (let i = 0; i < 5; i++) {
      bus.emit("trade-signal", makeSignal({ walletId, tokenOut: TOKEN_A, tokenIn: USDC }));
    }

    // Signals 6-8: 3 buys of TOKEN_B
    vi.mocked(getUsdPrice).mockResolvedValue(5);
    for (let i = 0; i < 3; i++) {
      bus.emit("trade-signal", makeSignal({ walletId, tokenOut: TOKEN_B, tokenIn: USDC, side: "buy" }));
    }

    // Signal 9: sell TOKEN_A (has position) — should copy
    vi.mocked(getUsdPrice).mockResolvedValue(10);
    bus.emit("trade-signal", makeSignal({
      walletId,
      side: "sell",
      tokenIn: TOKEN_A,
      tokenOut: USDC,
    }));

    // Signal 10: sell TOKEN_B (has position) — should copy
    vi.mocked(getUsdPrice).mockResolvedValue(5);
    bus.emit("trade-signal", makeSignal({
      walletId,
      side: "sell",
      tokenIn: TOKEN_B,
      tokenOut: USDC,
    }));

    // Signal 11: sell TOKEN_A again (no position after signal 9 emptied most of it) — may skip or copy remaining
    vi.mocked(getUsdPrice).mockResolvedValue(10);
    bus.emit("trade-signal", makeSignal({
      walletId,
      side: "sell",
      tokenIn: TOKEN_A,
      tokenOut: USDC,
    }));

    // Signal 12: sell unknown token (no position) — should skip with no-position
    const TOKEN_C: TokenRef = { chain: "eth", address: "0xcccc000000000000000000000000000000000003", symbol: "TKNC", decimals: 18 };
    bus.emit("trade-signal", makeSignal({ walletId, side: "sell", tokenIn: TOKEN_C, tokenOut: USDC }));

    // Signal 13: buy with below-liquidity token — should skip
    vi.mocked(getLiquidityUsd).mockResolvedValueOnce(100_000); // below MIN_LIQUIDITY_USD=150000
    vi.mocked(getUsdPrice).mockResolvedValue(10);
    bus.emit("trade-signal", makeSignal({ walletId, tokenOut: TOKEN_A, tokenIn: USDC }));

    // Signal 14: buy with null liquidity — should skip with no-liquidity-data
    vi.mocked(getLiquidityUsd).mockResolvedValueOnce(null);
    bus.emit("trade-signal", makeSignal({ walletId, tokenOut: TOKEN_A, tokenIn: USDC }));

    // Signals 15-19: more buys to use up more cash
    vi.mocked(getLiquidityUsd).mockResolvedValue(1_000_000);
    vi.mocked(getUsdPrice).mockResolvedValue(10);
    for (let i = 0; i < 5; i++) {
      bus.emit("trade-signal", makeSignal({ walletId, tokenOut: TOKEN_A, tokenIn: USDC }));
    }

    // Signal 20: a mempool signal (provisional) followed by void
    const mempoolSignalId = randomUUID();
    bus.emit("trade-signal", makeSignal({
      id: mempoolSignalId,
      walletId,
      source: "mempool",
      tokenOut: TOKEN_A,
      tokenIn: USDC,
    }));

    // Wait for queue to drain
    await new Promise<void>((r) => setTimeout(r, 500));

    // Void the mempool fill (should restore cash)
    const cashBeforeVoid = engine.getCashUsd();
    bus.emit("signal-voided", { signalId: mempoolSignalId, reason: "reverted" });
    await new Promise<void>((r) => setTimeout(r, 200));

    engine.stop();

    // Assertions
    const finalCash = engine.getCashUsd();
    const realizedPnl = engine.getRealizedPnlUsd();

    // Cash must be positive (never negative)
    expect(finalCash).toBeGreaterThan(0);

    // After voiding the mempool fill, cash should be >= cash before void
    expect(finalCash).toBeGreaterThanOrEqual(cashBeforeVoid);

    // Realized PnL is finite
    expect(Number.isFinite(realizedPnl)).toBe(true);

    // Starting cash 10000, some buys, some sells — equity should be close to original
    const equity = engine.getCashUsd() + Array.from(engine.getPositions().values())
      .reduce((sum, p) => sum + p.qty * p.avgCostUsd, 0);
    expect(equity).toBeGreaterThan(0);
    expect(equity).toBeLessThan(11_000); // shouldn't have grown much on flat prices
  });

  it("decide skips buys when cash is below MIN_NOTIONAL_USD", async () => {
    const bus = new EventBus();
    // Use $40 starting cash; clear snapshots so the engine doesn't load a bigger amount from DB
    await db.execute(sql`TRUNCATE portfolio_snapshots CASCADE`);
    const engine = new PaperEngine(db, bus, cfg({ PAPER_STARTING_CASH_USD: 40 }) as never, mockRpcClient as never);
    await engine.start();
    engine.stop();

    // equity = $40, notional = 40 * 0.01 * 1 = 0.40, clamped up to MIN_NOTIONAL=$50,
    // then clamped to cash=$40 → 40 < MIN_NOTIONAL (50) → skip insufficient-balance
    const signal = makeSignal({ walletId, tokenOut: TOKEN_A, tokenIn: USDC });
    const result = engine.decide(signal, 1_000_000);
    expect(result).toEqual({ action: "skip", reason: "insufficient-balance" });
  });

  it("decide skips buys rather than clamping minimum above the max trade cap", () => {
    const bus = new EventBus();
    const engine = new PaperEngine(db, bus, cfg({ MAX_TRADE_PCT: 0.001 }) as never, mockRpcClient as never);

    const signal = makeSignal({ walletId, tokenOut: TOKEN_A, tokenIn: USDC });

    expect(engine.decide(signal, 1_000_000)).toEqual({ action: "skip", reason: "below-min-notional" });
  });

  it("snapshots value positions at marks and report daily equity movement", async () => {
    const bus = new EventBus();
    await db.execute(sql`TRUNCATE portfolio_snapshots CASCADE`);
    await db.execute(sql`TRUNCATE positions CASCADE`);
    await db.execute(sql`TRUNCATE price_marks CASCADE`);

    await insertSnapshot(db, {
      ts: new Date(Date.now() - 60 * 60_000),
      equityUsd: 9_000,
      cashUsd: 9_000,
      positionsValueUsd: 0,
      dailyPnlUsd: 0,
    });
    await upsertPosition(db, {
      chain: "eth",
      tokenAddress: TOKEN_A.address,
      qty: 10,
      avgCostUsd: 100,
      realizedPnlUsd: 0,
      sourceWalletId: walletId,
    });
    await insertPriceMark(db, {
      chain: "eth",
      tokenAddress: TOKEN_A.address,
      ts: new Date(),
      priceUsd: 120,
      source: "test",
    });

    const engine = new PaperEngine(db, bus, cfg() as never, mockRpcClient as never);
    await engine.start();
    await (engine as unknown as { takeSnapshot: () => Promise<void> }).takeSnapshot();
    engine.stop();

    const snap = await latestSnapshot(db);
    expect(snap?.positionsValueUsd).toBeCloseTo(1_200);
    expect(snap?.equityUsd).toBeCloseTo(10_200);
    expect(snap?.dailyPnlUsd).toBeCloseTo(1_200);
  });

  it("closes the position (no zombie open row) when a sell empties it", async () => {
    const bus = new EventBus();
    await db.execute(sql`TRUNCATE positions CASCADE`);
    await db.execute(sql`TRUNCATE portfolio_snapshots CASCADE`);
    const engine = new PaperEngine(db, bus, cfg() as never, mockRpcClient as never);
    await engine.start();

    const TOKEN_Z: TokenRef = { chain: "eth", address: "0xeeee000000000000000000000000000000000009", symbol: "TKNZ", decimals: 18 };
    vi.mocked(getUsdPrice).mockResolvedValue(10);

    // One buy, then several sells — once the remaining position value drops below the sell
    // notional the engine sells the full remainder, driving qty to zero.
    bus.emit("trade-signal", makeSignal({ walletId, side: "buy", tokenIn: USDC, tokenOut: TOKEN_Z }));
    await new Promise<void>((r) => setTimeout(r, 200));
    for (let i = 0; i < 4; i++) {
      bus.emit("trade-signal", makeSignal({
        walletId,
        side: "sell",
        tokenIn: TOKEN_Z,
        tokenOut: USDC,
        amountIn: 100_000_000_000_000_000_000n,
        amountOut: 1_000_000_000n,
      }));
      await new Promise<void>((r) => setTimeout(r, 150));
    }

    engine.stop();

    // In-memory position is gone, and — the regression — no qty-0 "open" row remains in the DB.
    const key = `eth:${TOKEN_Z.address.toLowerCase()}:${walletId}`;
    expect(engine.getPositions().has(key)).toBe(false);
    const openRows = await getOpenPositions(db);
    expect(openRows.some((p) => p.tokenAddress === TOKEN_Z.address.toLowerCase())).toBe(false);
  });

  it("copies the same fraction of the leader's estimated holding on sells", async () => {
    const bus = new EventBus();
    await db.execute(sql`TRUNCATE paper_fills CASCADE`);
    await db.execute(sql`TRUNCATE positions CASCADE`);
    await db.execute(sql`TRUNCATE portfolio_snapshots CASCADE`);
    await db.execute(sql`TRUNCATE trade_signals CASCADE`);

    const engine = new PaperEngine(db, bus, cfg() as never, mockRpcClient as never);
    await engine.start();

    vi.mocked(getUsdPrice).mockResolvedValue(10);

    bus.emit("trade-signal", makeSignal({
      walletId,
      side: "buy",
      tokenIn: USDC,
      tokenOut: TOKEN_A,
      amountIn: 1_000_000_000n,
      amountOut: 100_000_000_000_000_000_000n,
    }));
    await new Promise<void>((r) => setTimeout(r, 200));

    const key = `eth:${TOKEN_A.address.toLowerCase()}:${walletId}`;
    const qtyAfterBuy = engine.getPositions().get(key)?.qty ?? 0;
    expect(qtyAfterBuy).toBeGreaterThan(0);

    bus.emit("trade-signal", makeSignal({
      walletId,
      side: "sell",
      tokenIn: TOKEN_A,
      tokenOut: USDC,
      amountIn: 25_000_000_000_000_000_000n,
      amountOut: 250_000_000n,
    }));
    await new Promise<void>((r) => setTimeout(r, 200));
    engine.stop();

    const remainingQty = engine.getPositions().get(key)?.qty ?? 0;
    expect(remainingQty).toBeCloseTo(qtyAfterBuy * 0.75, 8);
  });

  it("uses a usable 0x quote as the primary fill price", async () => {
    const bus = new EventBus();
    await db.execute(sql`TRUNCATE paper_fills CASCADE`);
    await db.execute(sql`TRUNCATE positions CASCADE`);
    await db.execute(sql`TRUNCATE portfolio_snapshots CASCADE`);
    await db.execute(sql`TRUNCATE trade_signals CASCADE`);

    vi.mocked(getUsdPrice).mockImplementation(async (_chain, addr) => {
      if (addr === USDC.address) return 1;
      return 10;
    });
    vi.mocked(getZeroxPrice).mockResolvedValue({
      provider: "0x",
      endpoint: "/swap/allowance-holder/price",
      chainId: 1,
      sellToken: USDC.address,
      buyToken: TOKEN_A.address,
      sellAmount: "100000000",
      buyAmount: "12500000000000000000",
      gasUnits: 0,
      gasPriceWei: 0,
      dexFeeUsd: 0.12,
      unpricedFees: [],
      warnings: [],
      rawResponse: {},
    });

    const engine = new PaperEngine(db, bus, cfg({ ZEROX_API_KEY: "test" }) as never, mockRpcClient as never);
    await engine.start();
    bus.emit("trade-signal", makeSignal({ walletId, tokenIn: USDC, tokenOut: TOKEN_A }));
    await new Promise<void>((r) => setTimeout(r, 200));
    engine.stop();

    const fill = (await getRecentFills(db, new Date(Date.now() - 60_000), 5))[0];
    expect(fill?.decision).toBe("copied");
    expect(fill?.priceUsd).toBeCloseTo(8);
    expect(fill?.qty).toBeCloseTo(12.5);
    expect(fill?.feeUsd).toBeCloseTo(4.12);
    expect(getZeroxPrice).toHaveBeenCalledWith(expect.objectContaining({
      chainId: 1,
      sellToken: USDC.address,
      buyToken: TOKEN_A.address,
      sellAmount: "100000000",
    }));
  });

  it("decide returns skip for zero-weight leader", async () => {
    const zeroWeights = { getWeight: () => 0 };
    const bus = new EventBus();
    const engine = new PaperEngine(db, bus, cfg() as never, mockRpcClient as never, zeroWeights);
    await engine.start();

    const signal = makeSignal({ walletId, tokenOut: TOKEN_A, tokenIn: USDC });
    const result = engine.decide(signal, 1_000_000);
    expect(result).toEqual({ action: "skip", reason: "leader-weight-zero" });
    engine.stop();
  });

  it("skips a signal when the traded token is blocklisted", async () => {
    const bus = new EventBus();
    await db.execute(sql`TRUNCATE paper_fills CASCADE`);
    await db.execute(sql`TRUNCATE trade_signals CASCADE`);
    await upsertToken(db, {
      chain: TOKEN_A.chain,
      address: TOKEN_A.address,
      symbol: TOKEN_A.symbol,
      name: TOKEN_A.symbol,
      decimals: TOKEN_A.decimals,
      isBlocked: true,
    });

    const engine = new PaperEngine(db, bus, cfg() as never, mockRpcClient as never);
    await engine.start();
    bus.emit("trade-signal", makeSignal({ walletId, tokenOut: TOKEN_A, tokenIn: USDC }));
    await new Promise<void>((r) => setTimeout(r, 200));
    engine.stop();

    const fills = await getRecentFills(db, new Date(Date.now() - 60_000), 5);
    expect(fills[0]?.decision).toBe("skipped");
    expect(fills[0]?.skipReason).toBe("token-blocklist");
  });

  it("vetoes a stale (backfilled) signal with skip reason stale-signal", async () => {
    const bus = new EventBus();
    await db.execute(sql`TRUNCATE paper_fills CASCADE`);
    await db.execute(sql`TRUNCATE trade_signals CASCADE`);
    await upsertToken(db, {
      chain: TOKEN_A.chain,
      address: TOKEN_A.address,
      symbol: TOKEN_A.symbol,
      name: TOKEN_A.symbol,
      decimals: TOKEN_A.decimals,
      isBlocked: false,
    });

    const engine = new PaperEngine(db, bus, cfg() as never, mockRpcClient as never);
    await engine.start();
    // Block confirmed four hours ago — well past the 180s cap.
    bus.emit(
      "trade-signal",
      makeSignal({ walletId, tokenOut: TOKEN_A, tokenIn: USDC, blockTimestamp: Date.now() - 4 * 60 * 60_000 })
    );
    await new Promise<void>((r) => setTimeout(r, 200));
    engine.stop();

    const fills = await getRecentFills(db, new Date(Date.now() - 60_000), 5);
    expect(fills[0]?.decision).toBe("skipped");
    expect(fills[0]?.skipReason).toBe("stale-signal");
  });

  it("manual candidate copy executes through the normal fill path without changing the signal to decoded", async () => {
    const bus = new EventBus();
    await db.execute(sql`TRUNCATE paper_fills CASCADE`);
    await db.execute(sql`TRUNCATE positions CASCADE`);
    await db.execute(sql`TRUNCATE portfolio_snapshots CASCADE`);
    await db.execute(sql`TRUNCATE trade_signals CASCADE`);
    await upsertToken(db, {
      chain: TOKEN_A.chain,
      address: TOKEN_A.address,
      symbol: TOKEN_A.symbol,
      name: TOKEN_A.symbol,
      decimals: TOKEN_A.decimals,
      isBlocked: false,
    });

    const candidate = makeSignal({
      walletId,
      decodeStatus: "candidate",
      confidence: 0.52,
      reason: "review before copying",
      reviewStatus: "copy-requested",
      blockTimestamp: Date.now() - 4 * 60 * 60_000,
    });
    await insertSignal(db, candidate);

    const engine = new PaperEngine(db, bus, cfg() as never, mockRpcClient as never);
    await engine.start();
    await engine.executeManualCandidateCopy(candidate);
    engine.stop();

    const fills = await getRecentFills(db, new Date(Date.now() - 60_000), 5);
    expect(fills[0]?.signalId).toBe(candidate.id);
    expect(fills[0]?.decision).toBe("copied");
    expect(fills[0]?.skipReason).toBeUndefined();

    const stored = await getSignalById(db, candidate.id);
    expect(stored?.decodeStatus).toBe("candidate");
    expect(stored?.reviewStatus).toBe("copy-requested");
  });

  it("vetoes a buy from an auto-copy-off wallet with skip reason auto-copy-off", async () => {
    const bus = new EventBus();
    await db.execute(sql`TRUNCATE paper_fills CASCADE`);
    await db.execute(sql`TRUNCATE trade_signals CASCADE`);
    await upsertToken(db, {
      chain: TOKEN_A.chain,
      address: TOKEN_A.address,
      symbol: TOKEN_A.symbol,
      name: TOKEN_A.symbol,
      decimals: TOKEN_A.decimals,
      isBlocked: false,
    });
    const muted = await insertWallet(db, {
      chain: "eth",
      address: "0x2eade00000000000000000000000000000000002",
      label: "Watched only",
      active: true,
      autoCopy: false,
    });

    const engine = new PaperEngine(db, bus, cfg() as never, mockRpcClient as never);
    await engine.start();
    bus.emit("trade-signal", makeSignal({ walletId: muted.id, tokenOut: TOKEN_A, tokenIn: USDC }));
    await new Promise<void>((r) => setTimeout(r, 200));
    engine.stop();

    const fills = await getRecentFills(db, new Date(Date.now() - 60_000), 5);
    expect(fills[0]?.decision).toBe("skipped");
    expect(fills[0]?.skipReason).toBe("auto-copy-off");
  });

  it("lets a manual candidate copy bypass the auto-copy-off veto", async () => {
    const bus = new EventBus();
    await db.execute(sql`TRUNCATE paper_fills CASCADE`);
    await db.execute(sql`TRUNCATE positions CASCADE`);
    await db.execute(sql`TRUNCATE portfolio_snapshots CASCADE`);
    await db.execute(sql`TRUNCATE trade_signals CASCADE`);
    await upsertToken(db, {
      chain: TOKEN_A.chain,
      address: TOKEN_A.address,
      symbol: TOKEN_A.symbol,
      name: TOKEN_A.symbol,
      decimals: TOKEN_A.decimals,
      isBlocked: false,
    });
    const muted = await insertWallet(db, {
      chain: "eth",
      address: "0x3eade00000000000000000000000000000000003",
      label: "Watched only",
      active: true,
      autoCopy: false,
    });
    const candidate = makeSignal({
      walletId: muted.id,
      decodeStatus: "candidate",
      reviewStatus: "copy-requested",
      tokenOut: TOKEN_A,
      tokenIn: USDC,
    });
    await insertSignal(db, candidate);

    const engine = new PaperEngine(db, bus, cfg() as never, mockRpcClient as never);
    await engine.start();
    await engine.executeManualCandidateCopy(candidate);
    engine.stop();

    const fills = await getRecentFills(db, new Date(Date.now() - 60_000), 5);
    expect(fills[0]?.decision).toBe("copied");
    expect(fills[0]?.skipReason).toBeUndefined();
  });

  it("stores fills against the persisted signal id when duplicate tx signals arrive", async () => {
    const bus = new EventBus();
    await db.execute(sql`TRUNCATE paper_fills CASCADE`);
    await db.execute(sql`TRUNCATE trade_signals CASCADE`);
    await upsertToken(db, {
      chain: TOKEN_A.chain,
      address: TOKEN_A.address,
      symbol: TOKEN_A.symbol,
      name: TOKEN_A.symbol,
      decimals: TOKEN_A.decimals,
      isBlocked: false,
    });
    vi.mocked(getLiquidityUsd).mockResolvedValue(null);

    const engine = new PaperEngine(db, bus, cfg() as never, mockRpcClient as never);
    await engine.start();

    const txHash = `0x${randomUUID().replace(/-/g, "")}`;
    const first = makeSignal({ walletId, txHash, tokenOut: TOKEN_A, tokenIn: USDC });
    const duplicate = makeSignal({ walletId, txHash, tokenOut: TOKEN_A, tokenIn: USDC });
    bus.emit("trade-signal", first);
    bus.emit("trade-signal", duplicate);
    await new Promise<void>((r) => setTimeout(r, 300));
    engine.stop();

    const fills = await getRecentFills(db, new Date(Date.now() - 60_000), 10);
    const signalIds = new Set(fills.map((fill) => fill.signalId));
    expect(fills).toHaveLength(2);
    expect(signalIds.size).toBe(1);
    expect([first.id, duplicate.id]).toContain(fills[0]?.signalId);
    expect(fills.every((fill) => fill.skipReason === "no-liquidity-data")).toBe(true);
  });

  it("uses settings overrides for minimum liquidity", async () => {
    const bus = new EventBus();
    await db.execute(sql`TRUNCATE positions CASCADE`);
    await db.execute(sql`TRUNCATE portfolio_snapshots CASCADE`);
    await setSetting(db, "min_liquidity_usd", 900_000);
    const engine = new PaperEngine(db, bus, cfg({ MIN_LIQUIDITY_USD: 150_000 }) as never, mockRpcClient as never);
    await engine.start();
    engine.stop();

    const signal = makeSignal({ walletId, tokenOut: TOKEN_A, tokenIn: USDC });
    expect(engine.decide(signal, 500_000)).toEqual({ action: "skip", reason: "below-min-liquidity" });
    expect(engine.decide(signal, 1_000_000)).toEqual({ action: "copy", notionalUsd: 100 });
  });

  it("honors proportional sizing mode using recent leader trade notional", async () => {
    const bus = new EventBus();
    await db.execute(sql`TRUNCATE paper_fills CASCADE`);
    await db.execute(sql`TRUNCATE positions CASCADE`);
    await db.execute(sql`TRUNCATE portfolio_snapshots CASCADE`);
    await db.execute(sql`TRUNCATE trade_signals CASCADE`);
    const engine = new PaperEngine(db, bus, cfg({ SIZING_MODE: "proportional" }) as never, mockRpcClient as never);
    await upsertToken(db, {
      chain: TOKEN_A.chain,
      address: TOKEN_A.address,
      symbol: TOKEN_A.symbol,
      name: TOKEN_A.symbol,
      decimals: TOKEN_A.decimals,
      isBlocked: false,
    });
    await engine.start();

    const seed = makeSignal({
      walletId,
      tokenIn: USDC,
      tokenOut: TOKEN_A,
      amountIn: 400_000_000n, // $400 source notional
    });
    bus.emit("trade-signal", seed);
    await new Promise<void>((r) => setTimeout(r, 200));

    const small = makeSignal({
      walletId,
      tokenIn: USDC,
      tokenOut: TOKEN_A,
      amountIn: 100_000_000n, // 0.25x the recent median, then clamped up to MIN_NOTIONAL
    });
    expect(engine.decide(small, 1_000_000)).toEqual({ action: "copy", notionalUsd: 50 });

    const large = makeSignal({
      walletId,
      tokenIn: USDC,
      tokenOut: TOKEN_A,
      amountIn: 1_600_000_000n, // 4x the recent median, then capped by MAX_TRADE_PCT
    });
    expect(engine.decide(large, 1_000_000)).toEqual({
      action: "copy",
      notionalUsd: expect.closeTo(299.86, 2),
    });

    engine.stop();
  });

  it("skips leaders muted for the signal liquidity tier", async () => {
    const mutedWeights = {
      getWeight: () => 1,
      getMutedLiquidityTiers: () => new Set(["longtail"] as const),
    };
    const bus = new EventBus();
    const engine = new PaperEngine(db, bus, cfg({ MIN_LIQUIDITY_USD: 1 }) as never, mockRpcClient as never, mutedWeights);
    await engine.start();
    engine.stop();

    const signal = makeSignal({ walletId, tokenOut: TOKEN_A, tokenIn: USDC });
    expect(engine.decide(signal, 100_000)).toEqual({ action: "skip", reason: "leader-tier-muted" });
  });
});
