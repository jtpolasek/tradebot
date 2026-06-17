# Price And Buy-Decision Improvements

This is a working checklist for improving the logic that gets prices and decides whether the paper engine should buy.

## Current Shape

Price lookup lives mainly in `packages/pricing/src/price.ts`.

- Stablecoins return `$1`.
- WETH/native pricing uses Chainlink ETH/USD, with DefiLlama fallback.
- Other tokens use V3-style spot pricing against quote assets.
- Base also probes Aerodrome concentrated-liquidity pools.
- DefiLlama is the final fallback.
- Liquidity uses the selected pool quote-token balance as an approximation.

Buy decisions live mainly in `packages/paper-engine/src/engine.ts`.

- Signals are persisted first.
- Candidate/low-confidence decodes are skipped.
- Stale confirmed signals are skipped.
- Blocklisted traded or quote tokens are skipped.
- Auto-copy-off wallets cannot open buys.
- Missing or below-min liquidity skips.
- Leader weight and muted liquidity tiers are applied.
- Notional is sized from equity, weight, runtime settings, and optional proportional sizing.
- Price must resolve before a copied fill is recorded.
- Optional 0x pricing is used for fill price when available, otherwise the engine falls back to spot plus synthetic slippage.

## Priority Note (2026-06-15)

After review, the remaining work was reordered by value:

1. ~~**Item 6 (unify sell fill modeling).**~~ Done — exit sells now share the copied-sell
   fee/slippage/0x/accounting model.
2. ~~**New item 7 (Chainlink staleness gate).**~~ Done — the missing companion to the V3 TWAP gate.
3. ~~**Item 5 (deeper-pool selection + metric consistency).**~~ Done — `findBestMarket` selects the
   deepest USD market across all quotes/venues/tiers; price and liquidity share it.
4. ~~Persist price/liquidity provenance in `paper_fills`.~~ Done — columns are written on copy and
   skip paths. Remaining (lower priority): bound the TTL-only pricing caches.

## Recommended Implementation Order

### 1. Return Price Provenance

Status: complete.

Problem:
`getUsdPrice()` returns only `number | null`, so the engine cannot distinguish Chainlink, V3/Aerodrome spot, or DefiLlama fallback quality.

Change:
Add a richer pricing result while keeping a compatibility wrapper if useful.

Proposed shape:

```ts
type PriceSource = "stablecoin" | "chainlink" | "v3-spot" | "defillama";

type PriceResult = {
  priceUsd: number;
  source: PriceSource;
  chain: ChainId;
  tokenAddress: string;
  quoteTokenAddress?: string;
  poolAddress?: string;
  venue?: "uniswap-v3" | "aerodrome-cl";
  warnings: string[];
};
```

Acceptance:

- Engine can log and persist which price source was used.
- Tests cover at least stablecoin, Chainlink, V3/Aerodrome, and DefiLlama provenance.
- Existing callers either use the richer API or a small `getUsdPrice()` wrapper.

Implemented notes:

- Added `getUsdPriceResult()` and `getLiquidityUsdResult()` while preserving numeric wrappers.
- `price_marks.source` now records the actual price source.
- Paper engine logs price/liquidity provenance before copied fills.
- Fill-level provenance **is** persisted: `paper_fills.price_source` / `price_venue` /
  `price_pool_address` / `liquidity_usd` are written on both copy and skip paths.

### 2. Treat 0x No-Route As A Buy Veto

Status: complete.

Problem:
When `ZEROX_API_KEY` is configured, a failed or no-route 0x quote currently falls back to spot pricing. That can simulate buys that may not be executable at the requested size.

Change:
Make no-route, no-liquidity, or unusable 0x responses produce a skip reason, probably `no-executable-route`, for buys. Network errors can remain fallback or become `quote-unavailable`, depending on how conservative we want to be.

Acceptance:

- If 0x explicitly reports no usable route for a buy, the fill is skipped.
- If 0x is not configured, existing spot-plus-slippage behavior remains.
- Tests cover no-route buy veto and successful 0x buy fill.

Implemented notes:

- Explicit 0x no-route/no-liquidity errors skip buys with `no-executable-route`.
- Transient 0x/API failures still fall back to spot pricing for now.
- Sells continue to fall back instead of being blocked by this change.

### 3. Add A Price-Source Gate For Auto-Buys

Status: complete.

Problem:
DefiLlama fallback can be useful for marks, but it is weaker as a real-time auto-buy execution input.

Change:
Use price provenance in the engine. Default behavior should skip auto-buys when the only price source is DefiLlama, unless a setting explicitly allows fallback-priced buys.

Potential setting:

```env
ALLOW_FALLBACK_PRICE_BUYS=false
```

Potential skip reason:

```text
fallback-price-source
```

Acceptance:

- DefiLlama-only auto-buy prices skip by default.
- Manual candidate copy behavior is decided explicitly: either respect the same gate or bypass with a separate reviewer-approved path.
- Marks can still use DefiLlama if we want broader portfolio valuation coverage.

Implemented notes:

- Added `ALLOW_FALLBACK_PRICE_BUYS=false` default.
- Auto-buys skip DefiLlama-only prices with `fallback-price-source` unless the setting is enabled.
- Marks can still store DefiLlama prices.

### 4. Add TWAP Sanity Check For V3/Aerodrome Spot

Status: complete.

Problem:
Current V3/Aerodrome pricing reads `slot0`, which is a single-block spot. Thin pools or manipulated pools can produce bad buy prices.

Change:
For V3-style pools, read a short TWAP using `observe()` and compare spot to TWAP. If divergence exceeds a threshold, skip or mark the price as unsafe.

Potential setting:

```env
MAX_SPOT_TWAP_DIVERGENCE_BPS=300
```

Acceptance:

- Spot and TWAP are both available in the pricing result for V3/Aerodrome prices.
- Buy decisions skip when divergence exceeds the configured threshold.
- Tests cover acceptable divergence and rejected divergence.

Implemented notes:

- Added standard V3 `observe()` support for Uniswap V3 and Aerodrome CL pools.
- `PriceResult` now includes `twapPriceUsd` and `spotTwapDivergenceBps` when TWAP is available.
- TWAP read failures are non-fatal and add `twap-unavailable`.
- Added `MAX_SPOT_TWAP_DIVERGENCE_BPS=300` default.
- Auto-buys skip with `spot-twap-divergence` when the configured threshold is exceeded.

### 5. Improve Liquidity Selection And Reporting

Status: complete (2026-06-15).

Problem:
Liquidity is approximated as quote-token reserve times two and returns the first usable quote-asset pool. For concentrated liquidity this is only a rough proxy, and price/liquidity may not be from the same best market.

Change:
Return a richer liquidity result and select the best USD liquidity across quote assets and venues.

Proposed shape:

```ts
type LiquidityResult = {
  liquidityUsd: number;
  chain: ChainId;
  tokenAddress: string;
  quoteTokenAddress: string;
  poolAddress: string;
  venue: "uniswap-v3" | "aerodrome-cl";
  method: "quote-balance-x2";
  warnings: string[];
};
```

Acceptance:

- Decision logs and fills can explain the liquidity value used.
- Liquidity and price source can be checked for consistency.
- Tests cover selecting the deeper of two available pools.

Implemented notes:

- Added `LiquidityResult` metadata and engine logging (earlier).
- Replaced `findDeepestV3Pool` (per-quote-pair, ranked by in-range `liquidity()` L) with
  `findBestMarket(chain, token)`, which scans **every quote asset × venue × fee tier** and selects
  the pool with the deepest **USD** liquidity (`quote-balance × quoteUsd × 2`) — the same metric
  `getLiquidityUsd` reports. **Metric inconsistency resolved:** primary ranking is now the reported
  USD metric; in-range L is kept only as a deterministic tiebreak when a candidate's quote balance
  can't be read (so a pool with no readable balance is still usable for pricing, just ranked last).
- **Price and liquidity now come from the same market.** `getUsdPriceResult` and
  `getLiquidityUsdResult` both derive from `findBestMarket`, so they can never disagree on the pool.
  The market (incl. a negative result) is cached per token for 5 min; price still re-reads `slot0`
  fresh and TWAP per call.
- Liquidity is still the `quote-balance-x2` approximation (the method label is unchanged); the
  improvement is *which* pool that approximation is taken from.
- Cost note: discovery now probes all quotes/venues/tiers (one `balanceOf` per candidate) instead
  of the first working quote pair, so a cache-miss discovery is heavier. Bounded by the 5-min
  market cache; caching token decimals could trim it further later.
- Test added: "selects the deeper USD market across quote assets for both price and liquidity"
  (USDC-shallow vs WETH-deep → both price and liquidity resolve to the WETH pool). `pnpm build` and
  `pnpm test` green (24 pricing tests).

### 6. Unify Sell Fill Modeling

Status: complete (2026-06-15).

Problem:
Normal copied sells use optional 0x quote pricing. Exit-rule sells duplicate a separate pricing/slippage path and do not call 0x.

Change:
Extract a shared fill-pricing/execution helper used by both normal sell signals and exit-rule sells.

Acceptance:

- Normal sells and exit sells use the same fee, slippage, 0x, and accounting model.
- Tests prove exit sells use 0x when configured.
- Existing position close behavior remains unchanged.

Implemented notes:

- Extracted three shared `PaperEngine` helpers used by buys, copied sells, and exit sells:
  `modeledSlippageBps` (DEX fee + capped impact + delay penalty), `priceSellFill`
  (0x-quote-or-spot pricing for sells), and `applySellToState` (accounting + position
  upsert/close).
- `executeExitSell` now prices through `priceSellFill`, so exit fills use a usable 0x quote when
  `ZEROX_API_KEY` is set and fall back to spot-minus-slippage otherwise — identical to copied
  sells. It hydrates real token decimals via `getToken` first so the 0x sell amount is sized
  correctly (was hardcoded to 18).
- Behavior delta to note: exit sells previously applied **no** price impact when the liquidity
  lookup returned null; they now share the buy/copied-sell model, which penalizes unknown
  liquidity at the 500 bps impact cap. Accounting/position-close math is otherwise unchanged.
- Added integration test "routes exit-rule sells through 0x when configured". `pnpm build` and
  `pnpm test` green (63 paper-engine tests).

### 7. Add A Chainlink Staleness Gate

Status: complete (2026-06-15).

Problem:
`getChainlinkEthUsd()` reads only `answer` from `latestRoundData` and ignores `updatedAt` /
`answeredInRound`. If the ETH/USD feed freezes, the engine will happily auto-buy on a stale
price. This is the missing companion to the V3/Aerodrome TWAP gate (item 4): we guard
manipulated pool spot but not a stalled oracle.

Change:
Reject Chainlink rounds older than a configurable staleness window, and treat a stale round the
same as a Chainlink read failure (fall through to DefiLlama, which then hits the existing
fallback-price-source buy veto).

Potential setting:

```env
MAX_CHAINLINK_STALENESS_SEC=3600
```

Acceptance:

- A Chainlink round with `updatedAt` older than the window is treated as unavailable.
- WETH pricing then falls back to DefiLlama, so DefiLlama-only auto-buys remain vetoed by item 3.
- Tests cover a fresh round (accepted) and a stale round (rejected → fallback).

Implemented notes:

- `getChainlinkEthUsd` now reads `updatedAt` (tuple index 3) and rejects rounds older than
  `MAX_CHAINLINK_STALENESS_SEC` (default 3600). A stale round returns null, so the caller falls
  through to DefiLlama exactly like a read failure.
- The window is read from `process.env` in `price.ts` (consistent with how `zerox.ts`/
  `uniswapQuote.ts` already read their keys) and added to the core config schema + `.env.example`
  for validation and documentation.
- `answeredInRound` is intentionally left unchecked — `updatedAt` staleness is the practical
  guard; the round-completeness check can be added later if a feed proves flaky.
- Added pricing tests for a fresh round (accepted) and a stale round (rejected → DefiLlama).
  `pnpm build` and `pnpm test` green (23 pricing tests).

## Open Decisions

Resolved 2026-06-15:

- **0x network failure → skip or fall back?** Keep falling back (current behavior), but ensure a
  warning/provenance flag is emitted. Vetoing on transient errors makes the bot flaky for no
  safety gain on paper.
- **Manual candidate copies and the fallback/TWAP gates?** Manual copies bypass *leader-behavior*
  gates (decode confidence, staleness, auto-copy-off) but NOT *execution-quality* gates
  (fallback-price-source, spot-TWAP divergence). A human clicking Copy does not make a manipulated
  pool price safe. Consistent with the ADR: manual copies execute at current price.
- **DefiLlama for sells/exits?** Yes, allow it. Blocking a sell because no pool price exists is the
  wrong failure mode — you always want to be able to exit. The fallback-price gate stays buy-only.
- **Persist provenance in `paper_fills`?** Yes, via migration. Cheap, already done for
  `price_marks`, and without it fills can't be audited for which price source backed them.

Still open:

- Eviction policy for the module-level pricing caches (`llamaCache`, `poolCache`, etc.): they
  evict by TTL only, never by size, so they grow unbounded for a long-running bot tracking many
  tokens. Low priority, tracked so it isn't forgotten.
