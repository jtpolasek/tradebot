# Mempool fast-path: decouple the provisional buy fill from price/liquidity discovery

**Status:** complete (2026-06-18). Authored 2026-06-17.

**Implemented (2026-06-18, `feat/mempool-fast-path`):** `decide()` split into `liquidityVeto()` + pure
`sizeBuy()`; a `recordSkip()` helper collapses the ~8 duplicated skip-fill branches in `handleSignal`;
new `handleProvisionalBuy()` commits a mempool buy at the leader's implied price (cheap quote→USD only,
no `findBestMarket`/spot/0x calls, no `takeSnapshot()`); deferred liquidity + fallback-price-source
vetoes moved into `handleConfirmed`, which reverses via the extracted `reverseProvisional()` (also
backing `handleVoided`). Decisions settled with the recommended defaults: (1) ship without an inline
cache-only liquidity check; (2) accept the `amountOutMin` qty bias (commented, no confirm-time
re-sizing); (3) omit `takeSnapshot()` from the hot path. **Not replicated at confirm (follow-up):**
`spot-twap-divergence` and 0x `no-executable-route` vetoes for fast-path buys. Validation: `pnpm build`
(10 pkgs) and `pnpm test` (17 tasks) green; +7 paper-engine tests (73 total).
**Goal:** cut mempool-buy → provisional-fill latency from ~5 sequential network/DB round trips to ~1, by committing the provisional fill at the leader's *implied* price and deferring all token-discovery-dependent work to the confirm step (which can void).

## Why (context)

A copy-trader's edge is the mempool signal — seen *before* the block is mined. The engine
already acts on it: `provisional = signal.source === "mempool"` (`packages/paper-engine/src/engine.ts:643`).
But the provisional fill is currently gated behind the same heavyweight pricing the confirmed
path does — and we already redo that work in `handleConfirmed` (`engine.ts:1134`, "confirmed re-price").

Moralis Streams was evaluated and **rejected for the hot path**: it delivers confirmed (post-block)
webhooks through a middleman indexer — strictly slower than our direct Alchemy WS + mempool
subscription. All reclaimable latency is on the path we own. (Streams could still help on cold
paths only: getLogs-backfill replacement, PnL cross-check, token-metadata backfill — not pursued.)

### Critical path today (mempool buy → provisional fill committed), all in series

| # | Step | Location | Cost |
|---|------|----------|------|
| 1 | `meta.resolve(tokenIn/Out)` | `strategyC.ts:134` (decoder) | RPC `eth_call` ×2 on cache miss (parallelized) |
| 2 | `insertSignal(db)` | `engine.ts:369` | DB write — before any veto |
| 3 | `getToken` ×2 | `engine.ts:434` | DB reads (parallelized) |
| 4 | `getLiquidityUsdResult` | `engine.ts:497` | **RPC fan-out** — `findBestMarket` scans every quote asset × venue × fee tier, one `balanceOf` per candidate. **Cache miss every time** (copy = fresh token). Dominant cost. |
| 5 | `getUsdPriceResult` | `engine.ts:535` | RPC `slot0` (reuses cached market from #4) |
| 6 | `quoteFillPriceWithZerox` | `engine.ts:651` | **0x HTTP REST** (if `ZEROX_API_KEY` set) |
| — | `takeSnapshot()` | `engine.ts:843` | extra DB write inside every fill |

### Linchpin fact

`resolveQuoteUsdPrice` (`engine.ts:918`) prices the **quote** side only (WETH→Chainlink ETH/USD,
USDC≈$1) — cheap and cached. The expensive `findBestMarket` fan-out is only ever for the **token**
side. The leader's mempool calldata already carries `amountIn`/`amountOut` (`strategyC`). So a
provisional buy can be valued from the cheap quote price alone, with zero token discovery.

## The change

### 1. Split `decide()` so sizing doesn't require liquidity

`decide()` (`engine.ts:264`) currently does liquidity vetoes *and* sizing in one pass. Separate:

```ts
// pure sizing, no liquidity
private sizeBuy(signal): { action:"copy"; notionalUsd:number } | { action:"skip"; reason:string } {
  const weight = this.weights.getWeight(signal.walletId);
  if (weight === 0) return { action:"skip", reason:"leader-weight-zero" };
  // ...existing equity / BASE_TRADE_PCT / MIN_NOTIONAL / cash math (engine.ts:273-289)...
}

// liquidity-dependent gate, pulled out of decide()
private liquidityVeto(signal, liquidityUsd: number|null): string | null {
  if (liquidityUsd === null) return "no-liquidity-data";
  if (this.weights.getMutedLiquidityTiers?.(signal.walletId)?.has(classifyLiquidityTier(liquidityUsd)))
    return "leader-tier-muted";
  if (liquidityUsd < this.runtimeConfig.MIN_LIQUIDITY_USD) return "below-min-liquidity";
  return null;
}
```

`decide()` for the confirmed/sell path becomes `liquidityVeto(...) ?? sizeBuy(...)` (preserve sells exactly).

### 2. Fast provisional buy path in `handleSignal`

Keep the existing cheap vetoes that already run first: candidate (`:380`), stale (`:409`),
blocklist (`:438`), auto-copy (`:466`). Then branch **before** the liquidity fan-out at `:497`:

```ts
if (signal.source === "mempool" && signal.side === "buy") {
  return this.handleProvisionalBuy(signal, token, quoteToken);
}
// existing heavyweight path (getLiquidity → decide → getPrice → 0x) stays for confirmed & sells
```

```ts
private async handleProvisionalBuy(signal, token, quoteToken) {
  const sized = this.sizeBuy(signal);
  if (sized.action === "skip") return this.recordSkip(signal, sized.reason, token, quoteToken);

  // Leader's implied token price from calldata — cheap quote→USD only, NO token discovery.
  const quoteUsd  = await this.resolveQuoteUsdPrice(quoteToken);            // Chainlink/≈$1, cached
  const amountInH  = rawToHumanNumber(signal.amountIn,  signal.tokenIn.decimals);
  const amountOutH = rawToHumanNumber(signal.amountOut, signal.tokenOut.decimals); // = amountOutMin
  const impliedPriceUsd = quoteUsd > 0 && amountOutH > 0 ? (amountInH * quoteUsd) / amountOutH : 0;
  if (impliedPriceUsd <= 0) return this.recordSkip(signal, "no-price-data", token, quoteToken);

  const notionalUsd = sized.notionalUsd;
  const qty = notionalUsd / impliedPriceUsd;
  const gasUsd = signal.chain === "eth" ? this.cfg.GAS_USD_ETH : this.cfg.GAS_USD_BASE;
  const feeUsd = gasUsd + (notionalUsd * DEX_FEE_BPS) / 10_000;             // model fee; 0x deferred
  if (this.cashUsd < notionalUsd + feeUsd) return this.recordSkip(signal, "insufficient-balance", token, quoteToken);

  // reuse the existing buy commit block (engine.ts:712-748): applyTradeToState, set positions,
  // upsertPosition. Then the provisionals.set block (engine.ts:824-841) so void/confirm can reverse.
  // record fill { ...provisional:true, priceUsd: impliedPriceUsd, priceSource:"leader-implied" }
  // DO NOT call takeSnapshot() here (see decision 3).
}
```

Factor the repeated skip-fill object (used ~8 times in `handleSignal`) into a `recordSkip(signal, reason, token, quoteToken)` helper while here — reduces the diff and the duplication.

### 3. Move deferred gates into `handleConfirmed` — and let it void

`handleConfirmed` (`:1134`) already re-prices via discovery. Extend it to run the liquidity-dependent
vetoes we skipped, and reverse the fill if they fail. The reversal already exists in `handleVoided`
(`:1170`) — extract its body into `reverseProvisional(signalId, reason)` and call from both.

```ts
private async handleConfirmed(signalId, confirmed) {
  await upsertSignal(this.db, confirmed);
  const prov = this.provisionals.get(signalId);
  if (!prov) return;

  const token = confirmed.side === "buy" ? confirmed.tokenOut : confirmed.tokenIn;
  const hint  = v4MarketHint(confirmed);

  // discovery we deferred off the hot path:
  const liq = await getLiquidityUsdResult(confirmed.chain, token.address, this.rpcClients[confirmed.chain], hint).catch(() => null);
  const veto = this.liquidityVeto(confirmed, liq?.liquidityUsd ?? null);
  if (veto) return this.reverseProvisional(signalId, `confirm-veto:${veto}`);

  const newPrice = (await getUsdPrice(confirmed.chain, token.address, this.rpcClients[confirmed.chain], hint).catch(() => 0)) ?? 0;
  // ...existing re-price-or-keep-estimate logic (engine.ts:1149-1167)...
}
```

Note: this only covers confirmed buys that had a provisional. The `spot-twap-divergence` (`:589`),
`fallback-price-source` (`:565`), and 0x `no-executable-route` (`:658`) vetoes also effectively
move to confirm for mempool buys — decide whether to replicate them in the confirm gate (recommended:
at least replicate `fallback-price-source` and `no-executable-route` as void reasons).

## Decisions to make before building

1. **Risk vetoes move from pre-fill to ~seconds-later confirm.** The sim briefly holds a position it
   may reverse. Fine for paper, and it's the point. If undesirable, add a **cache-only** liquidity
   check inline (read `findBestMarket`'s 5-min cache; cold→proceed, warm-and-below-min→skip). Cheap
   because it never triggers discovery. **Recommended: ship without it first, measure, add if needed.**
2. **`amountOut` is `amountOutMin`** (slippage floor) for mempool → `impliedPriceUsd` biased high →
   `qty` slightly low (conservative). Confirm keeps qty fixed (`:1157` deliberately doesn't rewrite
   the ledger), so the small bias persists. Acceptable; add a code comment. Re-deriving qty at confirm
   = rewriting position size after the fact (rejected by current design).
3. **`takeSnapshot()` in every fill** (`:843`) is an extra hot-path DB write — omit it from
   `handleProvisionalBuy`; the 5-min timer + confirm already snapshot.

## Tests to add (paper-engine)

- Implied-price math: WETH-quoted buy and USDC-quoted buy → expected `priceUsd`/`qty`, `priceSource:"leader-implied"`.
- Fast path makes **no** `getLiquidityUsdResult`/`getUsdPriceResult`/0x calls (spy/mock asserts zero calls).
- `handleConfirmed` re-prices a provisional fill to discovered price (existing behavior preserved).
- `handleConfirmed` **voids** a provisional fill when liquidity is below `MIN_LIQUIDITY_USD` (cash/position restored — assert via `reverseProvisional`).
- Sells and `source:"confirmed"` buys still take the heavyweight path unchanged (regression).
- `insufficient-balance` and `no-price-data` skip reasons on the fast path.

## Validation

`pnpm build && pnpm test` green before declaring done. Commit at milestone. Branch off `main`
(e.g. `feat/mempool-fast-path`).

## Out of scope / not pursued

- Moralis Streams (rejected for hot path, see Why).
- `insertSignal`-before-vetoes reordering (`:369`) and decoder `meta.resolve` non-blocking (`strategyC.ts:134`) — smaller wins, separate change.
- Engine queue `concurrency:4` (`:118`) burst tuning — separate.
