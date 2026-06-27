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
  getLiquidityUsdResult: vi.fn().mockResolvedValue({
    liquidityUsd: 1_000_000,
    chain: "eth",
    tokenAddress: "0xaaaa000000000000000000000000000000000001",
    quoteTokenAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    poolAddress: "0xpool",
    venue: "uniswap-v3",
    method: "quote-balance-x2",
    warnings: [],
  }),
  getUsdPrice: vi.fn().mockResolvedValue(10),
  getUsdPriceResult: vi.fn().mockResolvedValue({
    priceUsd: 10,
    source: "v3-spot",
    chain: "eth",
    tokenAddress: "0xaaaa000000000000000000000000000000000001",
    warnings: [],
  }),
  getPolymarketPrice: vi.fn().mockResolvedValue({
    tokenId: "1",
    side: "buy",
    source: "polymarket-clob",
    price: 0.6,
    bestBid: 0.59,
    bestAsk: 0.6,
    spread: 0.01,
    spreadBps: 168,
    maxSpreadBps: 500,
    fetchedAt: Date.now(),
  }),
  getPolymarketMarketStatus: vi.fn().mockResolvedValue({
    conditionId: "0xcondition",
    source: "polymarket-gamma",
    fetchedAt: Date.now(),
    active: true,
    closed: false,
    resolved: false,
    acceptingOrders: true,
    outcomes: null,
    outcomePrices: null,
    clobTokenIds: null,
  }),
  getPolymarketMarketStatusByEventSlug: vi.fn().mockResolvedValue(null),
  getPolymarketResolutionPayout: vi.fn((status: { closed: boolean; resolved: boolean; outcomePrices: number[] | null }, outcomeIndex: number) => {
    if (!status.closed && !status.resolved) return null;
    const price = status.outcomePrices?.[outcomeIndex];
    if (price === undefined) return null;
    if (price >= 0.99) return 1;
    if (price <= 0.01) return 0;
    return null;
  }),
  getZeroxPrice: vi.fn(),
}));

import {
  getLiquidityUsd,
  getLiquidityUsdResult,
  getPolymarketMarketStatus,
  getPolymarketMarketStatusByEventSlug,
  getPolymarketPrice,
  getUsdPrice,
  getUsdPriceResult,
  getZeroxPrice,
} from "@tradebot/pricing";

const mockRpcClient = { readContract: vi.fn() };

const USDC: TokenRef = { chain: "eth", address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", symbol: "USDC", decimals: 6 };
const TOKEN_A: TokenRef = { chain: "eth", address: "0xaaaa000000000000000000000000000000000001", symbol: "TKNA", decimals: 18 };
const TOKEN_B: TokenRef = { chain: "eth", address: "0xbbbb000000000000000000000000000000000002", symbol: "TKNB", decimals: 18 };
const POLYGON_USDC: TokenRef = { chain: "polygon", address: "0x2791bca1f2de4661ed88a30c99a7a9449aa84174", symbol: "USDC", decimals: 6 };
const POLY_YES: TokenRef = { chain: "polygon", address: "71321045679252212594626385532706912750332728571942532289631379312455583992563", symbol: "YES", decimals: 6, name: "Will it happen?" };
const POLY_NO: TokenRef = { chain: "polygon", address: "89185177767185250670283019413861399436335059635766251549068376246147763175828", symbol: "NO", decimals: 6, name: "Will it happen?" };

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
    MIN_CASH_RESERVE_PCT: 0,
    MIN_LIQUIDITY_USD: 150_000,
    MAX_SIGNAL_AGE_SEC: 180,
    POLYMARKET_MAX_SIGNAL_AGE_SEC: 900,
    COPY_DELAY_PENALTY_BPS_ETH: 10,
    COPY_DELAY_PENALTY_BPS_BASE: 5,
    GAS_USD_ETH: 4,
    GAS_USD_BASE: 0.03,
    SIZING_MODE: "fixed" as const,
    ALLOW_FALLBACK_PRICE_BUYS: false,
    MAX_SPOT_TWAP_DIVERGENCE_BPS: 300,
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
  vi.mocked(getLiquidityUsdResult).mockImplementation(async (chain, tokenAddress) => {
    const liquidityUsd = await vi.mocked(getLiquidityUsd)(chain, tokenAddress, mockRpcClient);
    if (liquidityUsd === null) return null;
    return {
      liquidityUsd,
      chain,
      tokenAddress,
      quoteTokenAddress: USDC.address,
      poolAddress: "0xpool",
      venue: "uniswap-v3",
      method: "quote-balance-x2",
      warnings: [],
    };
  });
  vi.mocked(getUsdPrice).mockResolvedValue(10);
  vi.mocked(getUsdPriceResult).mockImplementation(async (chain, tokenAddress) => {
    const priceUsd = await vi.mocked(getUsdPrice)(chain, tokenAddress, mockRpcClient);
    if (priceUsd === null) return null;
    return {
      priceUsd,
      source: "v3-spot",
      chain,
      tokenAddress,
      warnings: [],
    };
  });
  vi.mocked(getPolymarketPrice).mockImplementation(async (tokenId, side) => ({
    tokenId,
    side,
    source: "polymarket-clob",
    price: side === "buy" ? 0.6 : 0.58,
    bestBid: 0.58,
    bestAsk: 0.6,
    spread: 0.02,
    spreadBps: 338.9830508474576,
    maxSpreadBps: 500,
    fetchedAt: Date.now(),
  }));
  vi.mocked(getPolymarketMarketStatus).mockResolvedValue({
    conditionId: "0xcondition",
    source: "polymarket-gamma",
    fetchedAt: Date.now(),
    active: true,
    closed: false,
    resolved: false,
    acceptingOrders: true,
    outcomes: null,
    outcomePrices: null,
    clobTokenIds: null,
  });
  vi.mocked(getPolymarketMarketStatusByEventSlug).mockResolvedValue(null);
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

  it("decide skips buys once cash drops below the reserve floor", async () => {
    const bus = new EventBus();
    await db.execute(sql`TRUNCATE portfolio_snapshots CASCADE`);
    await db.execute(sql`TRUNCATE positions CASCADE`);
    // $10,000 book with a 99% reserve → $100 spendable. equity=$10,000, notional=10,000*0.01=$100,
    // under the max cap (10,000*0.03=$300) and spendable ($100) → affordable.
    const engine = new PaperEngine(
      db,
      bus,
      cfg({ PAPER_STARTING_CASH_USD: 10_000, MIN_CASH_RESERVE_PCT: 0.99 }) as never,
      mockRpcClient as never,
    );
    await engine.start();
    engine.stop();

    const signal = makeSignal({ walletId, tokenOut: TOKEN_A, tokenIn: USDC });
    expect(engine.decide(signal, 1_000_000)).toEqual({ action: "copy", notionalUsd: 100 });

    // Raise the reserve to 99.6% → spendable $40 < MIN_NOTIONAL → halt with insufficient-balance,
    // even though raw cash ($10,000) is far above the trade size.
    const halted = new PaperEngine(
      db,
      bus,
      cfg({ PAPER_STARTING_CASH_USD: 10_000, MIN_CASH_RESERVE_PCT: 0.996 }) as never,
      mockRpcClient as never,
    );
    await halted.start();
    halted.stop();
    expect(halted.decide(signal, 1_000_000)).toEqual({ action: "skip", reason: "insufficient-balance" });
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

  it("skips auto-buys when the only price source is fallback pricing", async () => {
    const bus = new EventBus();
    await db.execute(sql`TRUNCATE paper_fills CASCADE`);
    await db.execute(sql`TRUNCATE trade_signals CASCADE`);
    vi.mocked(getUsdPriceResult).mockResolvedValue({
      priceUsd: 10,
      source: "defillama",
      chain: "eth",
      tokenAddress: TOKEN_A.address,
      warnings: ["fallback-price-source"],
    });

    const engine = new PaperEngine(db, bus, cfg() as never, mockRpcClient as never);
    await engine.start();
    bus.emit("trade-signal", makeSignal({ walletId, tokenOut: TOKEN_A, tokenIn: USDC }));
    await new Promise<void>((r) => setTimeout(r, 300));
    engine.stop();

    const fill = (await getRecentFills(db, new Date(Date.now() - 60_000), 5))[0];
    expect(fill?.decision).toBe("skipped");
    expect(fill?.skipReason).toBe("fallback-price-source");
  });

  it("skips auto-buys when spot diverges too far from TWAP", async () => {
    const bus = new EventBus();
    await db.execute(sql`TRUNCATE paper_fills CASCADE`);
    await db.execute(sql`TRUNCATE trade_signals CASCADE`);
    vi.mocked(getUsdPriceResult).mockResolvedValue({
      priceUsd: 10,
      source: "v3-spot",
      chain: "eth",
      tokenAddress: TOKEN_A.address,
      quoteTokenAddress: USDC.address,
      poolAddress: "0xpool",
      venue: "uniswap-v3",
      twapPriceUsd: 9,
      spotTwapDivergenceBps: 1111,
      warnings: [],
    });

    const engine = new PaperEngine(db, bus, cfg() as never, mockRpcClient as never);
    await engine.start();
    bus.emit("trade-signal", makeSignal({ walletId, tokenOut: TOKEN_A, tokenIn: USDC }));
    await new Promise<void>((r) => setTimeout(r, 300));
    engine.stop();

    const fill = (await getRecentFills(db, new Date(Date.now() - 60_000), 5))[0];
    expect(fill?.decision).toBe("skipped");
    expect(fill?.skipReason).toBe("spot-twap-divergence");
  });

  it("skips configured 0x buys when 0x reports no executable route", async () => {
    const bus = new EventBus();
    await db.execute(sql`TRUNCATE paper_fills CASCADE`);
    await db.execute(sql`TRUNCATE positions CASCADE`);
    await db.execute(sql`TRUNCATE portfolio_snapshots CASCADE`);
    await db.execute(sql`TRUNCATE trade_signals CASCADE`);
    vi.mocked(getZeroxPrice).mockRejectedValue(new Error("No usable 0x liquidity/route for this trade."));

    const engine = new PaperEngine(db, bus, cfg({ ZEROX_API_KEY: "test" }) as never, mockRpcClient as never);
    await engine.start();
    bus.emit("trade-signal", makeSignal({ walletId, tokenOut: TOKEN_A, tokenIn: USDC }));
    await new Promise<void>((r) => setTimeout(r, 300));
    engine.stop();

    const fill = (await getRecentFills(db, new Date(Date.now() - 60_000), 5))[0];
    expect(fill?.decision).toBe("skipped");
    expect(fill?.skipReason).toBe("no-executable-route");
  });

  it("routes exit-rule sells through 0x when configured", async () => {
    const bus = new EventBus();
    await db.execute(sql`TRUNCATE paper_fills CASCADE`);
    await db.execute(sql`TRUNCATE positions CASCADE`);
    await db.execute(sql`TRUNCATE portfolio_snapshots CASCADE`);
    await db.execute(sql`TRUNCATE trade_signals CASCADE`);

    await upsertToken(db, { chain: "eth", address: TOKEN_A.address, symbol: "TKNA", name: "Token A", decimals: 18, isBlocked: false });
    await upsertPosition(db, { chain: "eth", tokenAddress: TOKEN_A.address, qty: 10, avgCostUsd: 8, realizedPnlUsd: 0, sourceWalletId: walletId });

    vi.mocked(getUsdPrice).mockImplementation(async (_chain, addr) => (addr === USDC.address ? 1 : 10));
    // 0x fills 10 TOKEN_A → 90 USDC, i.e. a $9 unit price (vs. ~$9.96 spot-minus-slippage).
    vi.mocked(getZeroxPrice).mockResolvedValue({
      provider: "0x",
      endpoint: "/swap/allowance-holder/price",
      chainId: 1,
      sellToken: TOKEN_A.address,
      buyToken: USDC.address,
      sellAmount: "10000000000000000000",
      buyAmount: "90000000",
      gasUnits: 0,
      gasPriceWei: 0,
      dexFeeUsd: 0.5,
      unpricedFees: [],
      warnings: [],
      rawResponse: {},
    });

    const engine = new PaperEngine(db, bus, cfg({ ZEROX_API_KEY: "test" }) as never, mockRpcClient as never);
    await engine.start();
    await engine.executeExitSell(
      { chain: "eth", tokenAddress: TOKEN_A.address, qty: 10, avgCostUsd: 8, sourceWalletId: walletId },
      "tp",
      10,
    );
    engine.stop();

    const fill = (await getRecentFills(db, new Date(Date.now() - 60_000), 5))[0];
    expect(fill?.decision).toBe("copied");
    expect(fill?.side).toBe("sell");
    expect(fill?.priceUsd).toBeCloseTo(9); // 0x price, not spot-minus-slippage
    expect(fill?.feeUsd).toBeCloseTo(4.5); // gas 4 + 0x dexFee 0.5
    expect(getZeroxPrice).toHaveBeenCalledWith(expect.objectContaining({
      sellToken: TOKEN_A.address,
      buyToken: USDC.address,
      sellAmount: "10000000000000000000",
    }));
  });

  it("uses a recovered V4 poolId for exit-sell depth", async () => {
    const bus = new EventBus();
    await db.execute(sql`TRUNCATE paper_fills CASCADE`);
    await db.execute(sql`TRUNCATE positions CASCADE`);
    await db.execute(sql`TRUNCATE portfolio_snapshots CASCADE`);
    await db.execute(sql`TRUNCATE trade_signals CASCADE`);

    const POOL_ID = "0xabc1230000000000000000000000000000000000000000000000000000000000";
    await upsertToken(db, { chain: "eth", address: TOKEN_A.address, symbol: "TKNA", name: "Token A", decimals: 18, isBlocked: false });
    // A prior V4 buy of TOKEN_A carries the poolId; the position itself does not, so the exit must
    // recover the hint from the signal to read real V4 depth instead of the null-liquidity penalty.
    await insertSignal(db, makeSignal({ walletId, tokenOut: TOKEN_A, tokenIn: USDC, venue: "uniswap-v4", poolId: POOL_ID }));
    await upsertPosition(db, { chain: "eth", tokenAddress: TOKEN_A.address, qty: 10, avgCostUsd: 8, realizedPnlUsd: 0, sourceWalletId: walletId });

    const engine = new PaperEngine(db, bus, cfg() as never, mockRpcClient as never);
    await engine.start();
    await engine.executeExitSell(
      { chain: "eth", tokenAddress: TOKEN_A.address, qty: 10, avgCostUsd: 8, sourceWalletId: walletId },
      "tp",
      10,
    );
    engine.stop();

    expect(getLiquidityUsd).toHaveBeenCalledWith(
      "eth",
      TOKEN_A.address,
      expect.anything(),
      { poolId: POOL_ID, counterCurrency: USDC.address },
    );
  });

  it("persists price provenance and liquidity on copied fills", async () => {
    const bus = new EventBus();
    await db.execute(sql`TRUNCATE paper_fills CASCADE`);
    await db.execute(sql`TRUNCATE positions CASCADE`);
    await db.execute(sql`TRUNCATE portfolio_snapshots CASCADE`);
    await db.execute(sql`TRUNCATE trade_signals CASCADE`);

    vi.mocked(getLiquidityUsd).mockResolvedValue(1_000_000);
    vi.mocked(getUsdPriceResult).mockResolvedValue({
      priceUsd: 10,
      source: "v3-spot",
      chain: "eth",
      tokenAddress: TOKEN_A.address,
      quoteTokenAddress: USDC.address,
      poolAddress: "0xpool",
      venue: "uniswap-v3",
      warnings: [],
    });

    const engine = new PaperEngine(db, bus, cfg() as never, mockRpcClient as never);
    await engine.start();
    bus.emit("trade-signal", makeSignal({ walletId, tokenOut: TOKEN_A, tokenIn: USDC }));
    await new Promise<void>((r) => setTimeout(r, 200));
    engine.stop();

    const fill = (await getRecentFills(db, new Date(Date.now() - 60_000), 5))[0];
    expect(fill?.decision).toBe("copied");
    expect(fill?.priceSource).toBe("v3-spot");
    expect(fill?.priceVenue).toBe("uniswap-v3");
    expect(fill?.pricePoolAddress).toBe("0xpool");
    expect(fill?.liquidityUsd).toBeCloseTo(1_000_000, 0);
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

  it("force-closes an orphaned position from a stale backfilled EVM sell at the current on-chain price", async () => {
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
    await upsertPosition(db, {
      chain: TOKEN_A.chain,
      tokenAddress: TOKEN_A.address,
      qty: 10,
      avgCostUsd: 5,
      realizedPnlUsd: 0,
      sourceWalletId: walletId,
    });
    vi.mocked(getUsdPrice).mockImplementation(async (_chain, addr) => {
      if (addr === USDC.address) return 1;
      if (addr === TOKEN_A.address) return 10;
      return 1;
    });

    const engine = new PaperEngine(db, bus, cfg() as never, mockRpcClient as never);
    await engine.start();
    bus.emit(
      "trade-signal",
      makeSignal({
        walletId,
        side: "sell",
        tokenIn: TOKEN_A,
        tokenOut: USDC,
        amountIn: 10_000_000_000_000_000_000n,
        amountOut: 120_000_000n,
        blockTimestamp: Date.now() - 4 * 60 * 60_000,
      })
    );
    await new Promise<void>((r) => setTimeout(r, 200));
    engine.stop();

    const fills = await getRecentFills(db, new Date(Date.now() - 60_000), 5);
    expect(fills[0]?.decision).toBe("copied");
    expect(fills[0]?.skipReason).toBeUndefined();
    expect(fills[0]?.priceUsd).toBeCloseTo(10);
    expect(fills[0]?.priceSource).toBe("v3-spot");
    expect(await getOpenPositions(db)).toHaveLength(0);
  });

  it("falls back to the leader-implied price to force-close an orphan when no live price is available", async () => {
    const bus = new EventBus();
    await db.execute(sql`TRUNCATE paper_fills CASCADE`);
    await db.execute(sql`TRUNCATE positions CASCADE`);
    await db.execute(sql`TRUNCATE portfolio_snapshots CASCADE`);
    await db.execute(sql`TRUNCATE trade_signals CASCADE`);
    await db.execute(sql`TRUNCATE price_marks CASCADE`);
    await upsertToken(db, {
      chain: TOKEN_A.chain,
      address: TOKEN_A.address,
      symbol: TOKEN_A.symbol,
      name: TOKEN_A.symbol,
      decimals: TOKEN_A.decimals,
      isBlocked: false,
    });
    await upsertPosition(db, {
      chain: TOKEN_A.chain,
      tokenAddress: TOKEN_A.address,
      qty: 10,
      avgCostUsd: 5,
      realizedPnlUsd: 0,
      sourceWalletId: walletId,
    });
    // No live on-chain price and no recorded mark -> only the leader-implied rate remains.
    vi.mocked(getUsdPriceResult).mockResolvedValue(null);
    vi.mocked(getUsdPrice).mockImplementation(async (_chain, addr) => (addr === USDC.address ? 1 : 10));

    const engine = new PaperEngine(db, bus, cfg() as never, mockRpcClient as never);
    await engine.start();
    bus.emit(
      "trade-signal",
      makeSignal({
        walletId,
        side: "sell",
        tokenIn: TOKEN_A,
        tokenOut: USDC,
        amountIn: 10_000_000_000_000_000_000n,
        amountOut: 120_000_000n,
        blockTimestamp: Date.now() - 4 * 60 * 60_000,
      })
    );
    await new Promise<void>((r) => setTimeout(r, 200));
    engine.stop();

    const fills = await getRecentFills(db, new Date(Date.now() - 60_000), 5);
    expect(fills[0]?.decision).toBe("copied");
    expect(fills[0]?.priceUsd).toBeCloseTo(12);
    expect(fills[0]?.priceSource).toBe("leader-implied-stale-sell");
    expect(await getOpenPositions(db)).toHaveLength(0);
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

  it("routes a manual Polymarket candidate copy through the CLOB buy path", async () => {
    const bus = new EventBus();
    await db.execute(sql`TRUNCATE paper_fills CASCADE`);
    await db.execute(sql`TRUNCATE positions CASCADE`);
    await db.execute(sql`TRUNCATE portfolio_snapshots CASCADE`);
    await db.execute(sql`TRUNCATE trade_signals CASCADE`);
    const polygonWallet = await insertWallet(db, {
      chain: "polygon",
      address: "0x4eade00000000000000000000000000000000004",
      label: "Poly leader",
      active: true,
      autoCopy: false,
    });
    const candidate = makeSignal({
      walletId: polygonWallet.id,
      chain: "polygon",
      tokenIn: POLYGON_USDC,
      tokenOut: POLY_YES,
      amountIn: 60_000_000n,
      amountOut: 100_000_000n,
      venue: "polymarket",
      decodeStatus: "candidate",
      reviewStatus: "copy-requested",
      conditionId: "0xcondition",
      source: "confirmed",
      blockNumber: null,
      observedAt: Date.now() - 5 * 60_000,
      confirmedAt: Date.now() - 5 * 60_000,
    });
    await insertSignal(db, candidate);

    const engine = new PaperEngine(db, bus, cfg() as never, mockRpcClient as never);
    await engine.start();
    await engine.executeManualCandidateCopy(candidate);
    engine.stop();

    const fill = (await getRecentFills(db, new Date(Date.now() - 60_000), 5)).find((row) => row.signalId === candidate.id);
    expect(fill?.decision).toBe("copied");
    expect(fill?.priceUsd).toBeCloseTo(0.6, 8);
    expect(fill?.feeUsd).toBe(0);
    expect(fill?.priceSource).toBe("polymarket-clob");
    expect(fill?.priceVenue).toBe("polymarket");
    expect(fill?.qty).toBeCloseTo(100 / 0.6, 6);
    expect(getPolymarketPrice).toHaveBeenCalledWith(POLY_YES.address, "buy");
  });

  it("vetoes a Polymarket buy when the current spread exceeds the configured maximum", async () => {
    const bus = new EventBus();
    await db.execute(sql`TRUNCATE paper_fills CASCADE`);
    await db.execute(sql`TRUNCATE positions CASCADE`);
    await db.execute(sql`TRUNCATE portfolio_snapshots CASCADE`);
    await db.execute(sql`TRUNCATE trade_signals CASCADE`);
    const polygonWallet = await insertWallet(db, {
      chain: "polygon",
      address: "0x5eade00000000000000000000000000000000005",
      label: "Poly leader 2",
      active: true,
    });
    const candidate = makeSignal({
      walletId: polygonWallet.id,
      chain: "polygon",
      tokenIn: POLYGON_USDC,
      tokenOut: POLY_YES,
      amountIn: 70_000_000n,
      amountOut: 100_000_000n,
      venue: "polymarket",
      decodeStatus: "candidate",
      reviewStatus: "copy-requested",
      conditionId: "0xcondition",
      source: "confirmed",
      blockNumber: null,
    });
    await insertSignal(db, candidate);
    vi.mocked(getPolymarketPrice).mockResolvedValueOnce({
      tokenId: POLY_YES.address,
      side: "buy",
      source: "polymarket-clob",
      price: 0.75,
      bestBid: 0.65,
      bestAsk: 0.75,
      spread: 0.1,
      spreadBps: 1428.5714285714287,
      maxSpreadBps: 500,
      fetchedAt: Date.now(),
    });

    const engine = new PaperEngine(db, bus, cfg() as never, mockRpcClient as never);
    await engine.start();
    await engine.executeManualCandidateCopy(candidate);
    engine.stop();

    const fill = (await getRecentFills(db, new Date(Date.now() - 60_000), 5)).find((row) => row.signalId === candidate.id);
    expect(fill?.decision).toBe("skipped");
    expect(fill?.skipReason).toBe("max-spread");
  });

  it("uses the looser Polymarket staleness budget for Polygon auto-copies", async () => {
    const bus = new EventBus();
    await db.execute(sql`TRUNCATE paper_fills CASCADE`);
    await db.execute(sql`TRUNCATE positions CASCADE`);
    await db.execute(sql`TRUNCATE portfolio_snapshots CASCADE`);
    await db.execute(sql`TRUNCATE trade_signals CASCADE`);
    const polygonWallet = await insertWallet(db, {
      chain: "polygon",
      address: "0x9eade00000000000000000000000000000000009",
      label: "Poly leader 6",
      active: true,
      autoCopy: true,
    });

    const polySignal = (observedMsAgo: number): TradeSignal =>
      makeSignal({
        walletId: polygonWallet.id,
        chain: "polygon",
        tokenIn: POLYGON_USDC,
        tokenOut: POLY_YES,
        amountIn: 60_000_000n,
        amountOut: 100_000_000n,
        venue: "polymarket",
        decodeStatus: "decoded",
        conditionId: "0xcondition",
        source: "confirmed",
        blockNumber: null,
        observedAt: Date.now() - observedMsAgo,
        confirmedAt: Date.now() - observedMsAgo,
      });

    const engine = new PaperEngine(db, bus, cfg() as never, mockRpcClient as never);
    await engine.start();

    // 5 min old: past the 180s EVM gate but inside the 900s Polymarket budget -> copies.
    const fresh = polySignal(5 * 60_000);
    await insertSignal(db, fresh);
    await engine.executePolymarketSignal(fresh);
    const freshFill = (await getRecentFills(db, new Date(Date.now() - 60_000), 10)).find((r) => r.signalId === fresh.id);
    expect(freshFill?.decision).toBe("copied");

    // 20 min old: past the 900s budget too -> stale-signal.
    const stale = polySignal(20 * 60_000);
    await insertSignal(db, stale);
    await engine.executePolymarketSignal(stale);
    engine.stop();
    const staleFill = (await getRecentFills(db, new Date(Date.now() - 60_000), 10)).find((r) => r.signalId === stale.id);
    expect(staleFill?.decision).toBe("skipped");
    expect(staleFill?.skipReason).toBe("stale-signal");
  });

  it("vetoes a Polymarket buy when Gamma reports the market already resolved", async () => {
    const bus = new EventBus();
    await db.execute(sql`TRUNCATE paper_fills CASCADE`);
    await db.execute(sql`TRUNCATE positions CASCADE`);
    await db.execute(sql`TRUNCATE portfolio_snapshots CASCADE`);
    await db.execute(sql`TRUNCATE trade_signals CASCADE`);
    const polygonWallet = await insertWallet(db, {
      chain: "polygon",
      address: "0x6eade00000000000000000000000000000000006",
      label: "Poly leader 3",
      active: true,
    });
    const candidate = makeSignal({
      walletId: polygonWallet.id,
      chain: "polygon",
      tokenIn: POLYGON_USDC,
      tokenOut: POLY_YES,
      amountIn: 70_000_000n,
      amountOut: 100_000_000n,
      venue: "polymarket",
      decodeStatus: "candidate",
      reviewStatus: "copy-requested",
      conditionId: "0xcondition",
      source: "confirmed",
      blockNumber: null,
    });
    await insertSignal(db, candidate);
    vi.mocked(getPolymarketMarketStatus).mockResolvedValueOnce({
      conditionId: "0xcondition",
      source: "polymarket-gamma",
      fetchedAt: Date.now(),
      active: false,
      closed: true,
      resolved: true,
      acceptingOrders: false,
      outcomes: ["Yes", "No"],
      outcomePrices: [1, 0],
      clobTokenIds: [POLY_YES.address, "other-token"],
    });

    const engine = new PaperEngine(db, bus, cfg() as never, mockRpcClient as never);
    await engine.start();
    await engine.executeManualCandidateCopy(candidate);
    engine.stop();

    const fill = (await getRecentFills(db, new Date(Date.now() - 60_000), 5)).find((row) => row.signalId === candidate.id);
    expect(fill?.decision).toBe("skipped");
    expect(fill?.skipReason).toBe("market-resolved");
  });

  it("routes a Polymarket sell through the CLOB bid path and closes the copied position", async () => {
    const bus = new EventBus();
    await db.execute(sql`TRUNCATE paper_fills CASCADE`);
    await db.execute(sql`TRUNCATE positions CASCADE`);
    await db.execute(sql`TRUNCATE portfolio_snapshots CASCADE`);
    await db.execute(sql`TRUNCATE trade_signals CASCADE`);
    const polygonWallet = await insertWallet(db, {
      chain: "polygon",
      address: "0x7eade00000000000000000000000000000000007",
      label: "Poly leader 4",
      active: true,
    });
    await upsertPosition(db, {
      chain: "polygon",
      tokenAddress: POLY_YES.address,
      qty: 120,
      avgCostUsd: 0.4,
      realizedPnlUsd: 0,
      sourceWalletId: polygonWallet.id,
    });
    const candidate = makeSignal({
      walletId: polygonWallet.id,
      chain: "polygon",
      side: "sell",
      tokenIn: POLY_YES,
      tokenOut: POLYGON_USDC,
      amountIn: 120_000_000n,
      amountOut: 58_000_000n,
      venue: "polymarket",
      decodeStatus: "candidate",
      reviewStatus: "copy-requested",
      conditionId: "0xcondition",
      source: "confirmed",
      blockNumber: null,
    });
    await insertSignal(db, candidate);
    vi.mocked(getPolymarketPrice).mockResolvedValueOnce({
      tokenId: POLY_YES.address,
      side: "sell",
      source: "polymarket-clob",
      price: 0.58,
      bestBid: 0.58,
      bestAsk: 0.6,
      spread: 0.02,
      spreadBps: 338.9830508474576,
      maxSpreadBps: 500,
      fetchedAt: Date.now(),
    });

    const engine = new PaperEngine(db, bus, cfg() as never, mockRpcClient as never);
    await engine.start();
    await engine.executeManualCandidateCopy(candidate);
    engine.stop();

    const fill = (await getRecentFills(db, new Date(Date.now() - 60_000), 5)).find((row) => row.signalId === candidate.id);
    expect(fill?.decision).toBe("copied");
    expect(fill?.priceUsd).toBeCloseTo(0.58, 8);
    expect(fill?.feeUsd).toBe(0);
    const openRows = await getOpenPositions(db);
    expect(openRows.some((row) => row.chain === "polygon" && row.tokenAddress === POLY_YES.address)).toBe(false);
  });

  it("force-closes an open Polymarket position at resolution through the shared sell accounting path", async () => {
    const bus = new EventBus();
    await db.execute(sql`TRUNCATE paper_fills CASCADE`);
    await db.execute(sql`TRUNCATE positions CASCADE`);
    await db.execute(sql`TRUNCATE portfolio_snapshots CASCADE`);
    await db.execute(sql`TRUNCATE trade_signals CASCADE`);
    const polygonWallet = await insertWallet(db, {
      chain: "polygon",
      address: "0x8eade00000000000000000000000000000000008",
      label: "Poly leader 5",
      active: true,
    });
    await upsertToken(db, {
      chain: "polygon",
      address: POLY_YES.address,
      symbol: "YES",
      name: "Will it happen?",
      decimals: 6,
      isBlocked: false,
    });
    await upsertPosition(db, {
      chain: "polygon",
      tokenAddress: POLY_YES.address,
      qty: 100,
      avgCostUsd: 0.4,
      realizedPnlUsd: 0,
      sourceWalletId: polygonWallet.id,
    });
    vi.mocked(getPolymarketMarketStatus).mockResolvedValueOnce({
      conditionId: "0xcondition",
      source: "polymarket-gamma",
      fetchedAt: Date.now(),
      active: false,
      closed: true,
      resolved: true,
      acceptingOrders: false,
      outcomes: ["Yes", "No"],
      outcomePrices: [1, 0],
      clobTokenIds: [POLY_YES.address, "other-token"],
    });

    const engine = new PaperEngine(db, bus, cfg() as never, mockRpcClient as never);
    await engine.start();
    const result = await engine.settlePolymarketPosition({
      chain: "polygon",
      tokenAddress: POLY_YES.address,
      qty: 100,
      avgCostUsd: 0.4,
      sourceWalletId: polygonWallet.id,
      conditionId: "0xcondition",
      outcomeIndex: 0,
    });
    engine.stop();

    expect(result).toBe("settled");
    const fill = (await getRecentFills(db, new Date(Date.now() - 60_000), 5))[0];
    expect(fill?.decision).toBe("copied");
    expect(fill?.priceUsd).toBe(1);
    expect(fill?.feeUsd).toBe(0);
    const signal = fill ? await getSignalById(db, fill.signalId) : null;
    expect(signal?.venue).toBe("polymarket-resolution");
    const openRows = await getOpenPositions(db);
    expect(openRows.some((row) => row.chain === "polygon" && row.tokenAddress === POLY_YES.address)).toBe(false);
  });

  it("settles via the Polymarket event slug when direct Gamma condition lookup misses", async () => {
    const bus = new EventBus();
    await db.execute(sql`TRUNCATE paper_fills CASCADE`);
    await db.execute(sql`TRUNCATE positions CASCADE`);
    await db.execute(sql`TRUNCATE portfolio_snapshots CASCADE`);
    await db.execute(sql`TRUNCATE trade_signals CASCADE`);
    const polygonWallet = await insertWallet(db, {
      chain: "polygon",
      address: "0x8eade00000000000000000000000000000000009",
      label: "Poly leader 6",
      active: true,
    });
    await upsertToken(db, {
      chain: "polygon",
      address: POLY_NO.address,
      symbol: "NO",
      name: "Will it happen?",
      decimals: 6,
      isBlocked: false,
    });
    await upsertPosition(db, {
      chain: "polygon",
      tokenAddress: POLY_NO.address,
      qty: 25,
      avgCostUsd: 0.8,
      realizedPnlUsd: 0,
      sourceWalletId: polygonWallet.id,
    });
    vi.mocked(getPolymarketMarketStatus).mockResolvedValueOnce(null);
    vi.mocked(getPolymarketMarketStatusByEventSlug).mockResolvedValueOnce({
      conditionId: "0xcondition",
      source: "polymarket-gamma",
      fetchedAt: Date.now(),
      active: true,
      closed: true,
      resolved: false,
      acceptingOrders: false,
      outcomes: ["Yes", "No"],
      outcomePrices: [0, 1],
      clobTokenIds: [POLY_YES.address, POLY_NO.address],
    });

    const engine = new PaperEngine(db, bus, cfg() as never, mockRpcClient as never);
    await engine.start();
    const result = await engine.settlePolymarketPosition({
      chain: "polygon",
      tokenAddress: POLY_NO.address,
      qty: 25,
      avgCostUsd: 0.8,
      sourceWalletId: polygonWallet.id,
      conditionId: "0xcondition",
      outcomeIndex: 1,
      externalUrl: "https://polymarket.com/event/test-event",
    });
    engine.stop();

    expect(result).toBe("settled");
    expect(getPolymarketMarketStatusByEventSlug).toHaveBeenCalledWith("0xcondition", "test-event");
    const fill = (await getRecentFills(db, new Date(Date.now() - 60_000), 5))[0];
    expect(fill?.priceUsd).toBe(1);
    const openRows = await getOpenPositions(db);
    expect(openRows.some((row) => row.chain === "polygon" && row.tokenAddress === POLY_NO.address)).toBe(false);
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

  it("forwards a V4 signal's poolId as a pricing hint so a V4-only token is not skipped", async () => {
    const bus = new EventBus();
    await db.execute(sql`TRUNCATE paper_fills CASCADE`);
    await db.execute(sql`TRUNCATE positions CASCADE`);
    await db.execute(sql`TRUNCATE portfolio_snapshots CASCADE`);
    await db.execute(sql`TRUNCATE trade_signals CASCADE`);

    const V4_TOKEN: TokenRef = { chain: "eth", address: "0xc92b000000000000000000000000000000008ba3", symbol: "LOCAL", decimals: 18 };
    const POOL_ID = "0x" + "cd".repeat(32);

    // Model the real fix: liquidity is readable ONLY when the poolId hint is supplied — a V4-only
    // token is invisible to the V2/V3 scan and would otherwise skip with no-liquidity-data.
    vi.mocked(getLiquidityUsdResult).mockImplementation(async (chain, tokenAddress, _client, hint) => {
      if (!hint?.poolId) return null;
      return {
        liquidityUsd: 1_000_000, chain, tokenAddress, quoteTokenAddress: USDC.address,
        poolAddress: hint.poolId, venue: "uniswap-v4", method: "v4-virtual-reserves", warnings: [],
      };
    });
    vi.mocked(getUsdPriceResult).mockImplementation(async (chain, tokenAddress, _client, hint) => ({
      priceUsd: hint?.poolId ? 0.001 : 10, source: "v3-spot", chain, tokenAddress,
      venue: hint?.poolId ? "uniswap-v4" : "uniswap-v3", warnings: [],
    }));

    const engine = new PaperEngine(db, bus, cfg() as never, mockRpcClient as never);
    await engine.start();

    // V4 buy WITH a poolId → hint flows → token is priceable → copied.
    const v4Sig = makeSignal({ walletId, side: "buy", tokenIn: USDC, tokenOut: V4_TOKEN, venue: "uniswap-v4", poolId: POOL_ID });
    bus.emit("trade-signal", v4Sig);
    await new Promise<void>((r) => setTimeout(r, 250));

    // Same token WITHOUT a poolId → no hint → invisible → skipped no-liquidity-data (the old bug).
    const noHintSig = makeSignal({ walletId, side: "buy", tokenIn: USDC, tokenOut: V4_TOKEN });
    bus.emit("trade-signal", noHintSig);
    await new Promise<void>((r) => setTimeout(r, 250));
    engine.stop();

    // The engine forwarded the poolId + swap's counter currency (the quote side, USDC).
    expect(vi.mocked(getLiquidityUsdResult)).toHaveBeenCalledWith(
      "eth", V4_TOKEN.address, expect.anything(), { poolId: POOL_ID, counterCurrency: USDC.address }
    );

    const fills = await getRecentFills(db, new Date(Date.now() - 60_000), 10);
    const v4Fill = fills.find((f) => f.signalId === v4Sig.id);
    const noHintFill = fills.find((f) => f.signalId === noHintSig.id);
    expect(v4Fill?.decision).toBe("copied");
    expect(noHintFill?.decision).toBe("skipped");
    expect(noHintFill?.skipReason).toBe("no-liquidity-data");
  });
});

const WETH_ETH: TokenRef = { chain: "eth", address: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", symbol: "WETH", decimals: 18 };

describe("PaperEngine mempool fast path", () => {
  // Deterministic equity = PAPER_STARTING_CASH (10_000): no loaded snapshot or open positions.
  async function resetLedger(): Promise<void> {
    await db.execute(sql`TRUNCATE portfolio_snapshots CASCADE`);
    await db.execute(sql`TRUNCATE positions CASCADE`);
    await db.execute(sql`TRUNCATE price_marks CASCADE`);
  }

  it("commits a USDC-quoted provisional buy at the leader's implied price without token discovery", async () => {
    await resetLedger();
    const bus = new EventBus();
    const engine = new PaperEngine(db, bus, cfg() as never, mockRpcClient as never);
    await engine.start();

    // Only the quote side is priced on the fast path (USDC ≈ $1); the token side is never read.
    vi.mocked(getUsdPrice).mockImplementation(async (_chain, addr) => (addr === USDC.address ? 1 : 10));
    const liqCalls = vi.mocked(getLiquidityUsdResult).mock.calls.length;
    const priceResultCalls = vi.mocked(getUsdPriceResult).mock.calls.length;
    const zeroxCalls = vi.mocked(getZeroxPrice).mock.calls.length;

    // Leader pays 500 USDC for 50 TOKEN_A → implied $10/token.
    const sig = makeSignal({
      walletId,
      source: "mempool",
      tokenIn: USDC,
      tokenOut: TOKEN_A,
      amountIn: 500n * 10n ** 6n,
      amountOut: 50n * 10n ** 18n,
    });
    bus.emit("trade-signal", sig);
    await new Promise<void>((r) => setTimeout(r, 300));
    engine.stop();

    const fill = (await getRecentFills(db, new Date(Date.now() - 60_000), 5)).find((f) => f.signalId === sig.id);
    expect(fill?.decision).toBe("copied");
    expect(fill?.provisional).toBe(true);
    expect(fill?.priceSource).toBe("leader-implied");
    expect(fill?.priceUsd).toBeCloseTo(10, 6);
    // notional = equity 10_000 * BASE_TRADE_PCT 0.01 = 100 → qty = 100 / 10.
    expect(fill?.qty).toBeCloseTo(10, 6);

    // No liquidity fan-out, spot read, or 0x quote happened on the hot path.
    expect(vi.mocked(getLiquidityUsdResult).mock.calls.length).toBe(liqCalls);
    expect(vi.mocked(getUsdPriceResult).mock.calls.length).toBe(priceResultCalls);
    expect(vi.mocked(getZeroxPrice).mock.calls.length).toBe(zeroxCalls);
  });

  it("values a WETH-quoted provisional buy via the quote price", async () => {
    await resetLedger();
    const bus = new EventBus();
    const engine = new PaperEngine(db, bus, cfg() as never, mockRpcClient as never);
    await engine.start();

    vi.mocked(getUsdPrice).mockImplementation(async (_chain, addr) => (addr === WETH_ETH.address ? 2000 : 10));
    // Leader pays 0.05 WETH for 100 TOKEN_A → implied (0.05 * 2000) / 100 = $1/token.
    const sig = makeSignal({
      walletId,
      source: "mempool",
      tokenIn: WETH_ETH,
      tokenOut: TOKEN_A,
      amountIn: 5n * 10n ** 16n,
      amountOut: 100n * 10n ** 18n,
    });
    bus.emit("trade-signal", sig);
    await new Promise<void>((r) => setTimeout(r, 300));
    engine.stop();

    const fill = (await getRecentFills(db, new Date(Date.now() - 60_000), 5)).find((f) => f.signalId === sig.id);
    expect(fill?.decision).toBe("copied");
    expect(fill?.priceSource).toBe("leader-implied");
    expect(fill?.priceUsd).toBeCloseTo(1, 6);
    // notional 100 at $1 → qty 100.
    expect(fill?.qty).toBeCloseTo(100, 4);
  });

  it("re-prices a provisional fill to the discovered price on confirm", async () => {
    await resetLedger();
    const bus = new EventBus();
    const engine = new PaperEngine(db, bus, cfg() as never, mockRpcClient as never);
    await engine.start();

    vi.mocked(getUsdPrice).mockImplementation(async (_chain, addr) => (addr === USDC.address ? 1 : 10));
    const sig = makeSignal({
      walletId,
      source: "mempool",
      tokenIn: USDC,
      tokenOut: TOKEN_A,
      amountIn: 500n * 10n ** 6n,
      amountOut: 50n * 10n ** 18n,
    });
    bus.emit("trade-signal", sig);
    await new Promise<void>((r) => setTimeout(r, 300));

    // Confirm reveals a discovered spot of $12; the fill is re-priced and de-provisioned.
    vi.mocked(getUsdPrice).mockResolvedValue(12);
    bus.emit("signal-confirmed", { signalId: sig.id, confirmed: { ...sig, source: "confirmed", confirmedAt: Date.now() } });
    await new Promise<void>((r) => setTimeout(r, 300));
    engine.stop();

    const fill = (await getRecentFills(db, new Date(Date.now() - 60_000), 5)).find((f) => f.signalId === sig.id);
    expect(fill?.decision).toBe("copied");
    expect(fill?.provisional).toBe(false);
    expect(fill?.priceUsd).toBeCloseTo(12, 6);
  });

  it("voids a provisional fill when confirm-time liquidity is below the minimum", async () => {
    await resetLedger();
    const bus = new EventBus();
    const engine = new PaperEngine(db, bus, cfg() as never, mockRpcClient as never);
    await engine.start();

    const cashBefore = engine.getCashUsd();
    vi.mocked(getUsdPrice).mockImplementation(async (_chain, addr) => (addr === USDC.address ? 1 : 10));
    const sig = makeSignal({
      walletId,
      source: "mempool",
      tokenIn: USDC,
      tokenOut: TOKEN_A,
      amountIn: 500n * 10n ** 6n,
      amountOut: 50n * 10n ** 18n,
    });
    bus.emit("trade-signal", sig);
    await new Promise<void>((r) => setTimeout(r, 300));
    expect(engine.getCashUsd()).toBeLessThan(cashBefore); // provisional spent cash

    // Confirm reveals thin liquidity below MIN_LIQUIDITY_USD (150k) → reverse the provisional.
    vi.mocked(getLiquidityUsd).mockResolvedValue(100_000);
    bus.emit("signal-confirmed", { signalId: sig.id, confirmed: { ...sig, source: "confirmed", confirmedAt: Date.now() } });
    await new Promise<void>((r) => setTimeout(r, 300));
    engine.stop();

    // Cash restored exactly and no open position remains.
    expect(engine.getCashUsd()).toBeCloseTo(cashBefore, 6);
    const positions = await getOpenPositions(db);
    expect(positions.find((p) => p.tokenAddress === TOKEN_A.address && p.sourceWalletId === walletId)).toBeUndefined();
  });

  it("skips a mempool buy with insufficient-balance on the fast path", async () => {
    await db.execute(sql`TRUNCATE portfolio_snapshots CASCADE`);
    await db.execute(sql`TRUNCATE positions CASCADE`);
    const bus = new EventBus();
    const engine = new PaperEngine(db, bus, cfg({ PAPER_STARTING_CASH_USD: 40 }) as never, mockRpcClient as never);
    await engine.start();

    vi.mocked(getUsdPrice).mockImplementation(async (_chain, addr) => (addr === USDC.address ? 1 : 10));
    const sig = makeSignal({
      walletId,
      source: "mempool",
      tokenIn: USDC,
      tokenOut: TOKEN_A,
      amountIn: 500n * 10n ** 6n,
      amountOut: 50n * 10n ** 18n,
    });
    bus.emit("trade-signal", sig);
    await new Promise<void>((r) => setTimeout(r, 300));
    engine.stop();

    // $40 equity → notional clamps up to MIN_NOTIONAL 50 but cash 40 < 50 → insufficient-balance.
    const fill = (await getRecentFills(db, new Date(Date.now() - 60_000), 5)).find((f) => f.signalId === sig.id);
    expect(fill?.decision).toBe("skipped");
    expect(fill?.skipReason).toBe("insufficient-balance");
  });

  it("skips a mempool buy with no-price-data when the quote side cannot be priced", async () => {
    await resetLedger();
    const bus = new EventBus();
    const engine = new PaperEngine(db, bus, cfg() as never, mockRpcClient as never);
    await engine.start();

    // Quote price unavailable → implied price is 0 → no-price-data.
    vi.mocked(getUsdPrice).mockResolvedValue(null as never);
    const sig = makeSignal({
      walletId,
      source: "mempool",
      tokenIn: USDC,
      tokenOut: TOKEN_A,
      amountIn: 500n * 10n ** 6n,
      amountOut: 50n * 10n ** 18n,
    });
    bus.emit("trade-signal", sig);
    await new Promise<void>((r) => setTimeout(r, 300));
    engine.stop();

    const fill = (await getRecentFills(db, new Date(Date.now() - 60_000), 5)).find((f) => f.signalId === sig.id);
    expect(fill?.decision).toBe("skipped");
    expect(fill?.skipReason).toBe("no-price-data");
  });

  it("keeps confirmed buys on the heavyweight discovery path (regression)", async () => {
    await resetLedger();
    const bus = new EventBus();
    const engine = new PaperEngine(db, bus, cfg() as never, mockRpcClient as never);
    await engine.start();

    const priceResultCalls = vi.mocked(getUsdPriceResult).mock.calls.length;
    const liqCalls = vi.mocked(getLiquidityUsdResult).mock.calls.length;
    const sig = makeSignal({ walletId, source: "confirmed", tokenIn: USDC, tokenOut: TOKEN_A });
    bus.emit("trade-signal", sig);
    await new Promise<void>((r) => setTimeout(r, 300));
    engine.stop();

    const fill = (await getRecentFills(db, new Date(Date.now() - 60_000), 5)).find((f) => f.signalId === sig.id);
    expect(fill?.decision).toBe("copied");
    expect(fill?.provisional).toBe(false);
    expect(fill?.priceSource).toBe("v3-spot");
    // The confirmed path still performs liquidity + spot discovery.
    expect(vi.mocked(getLiquidityUsdResult).mock.calls.length).toBeGreaterThan(liqCalls);
    expect(vi.mocked(getUsdPriceResult).mock.calls.length).toBeGreaterThan(priceResultCalls);
  });
});
