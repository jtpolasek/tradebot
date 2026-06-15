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
- Fill-level provenance is not yet persisted because that requires a schema migration.

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

Status: partially complete.

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

- Added `LiquidityResult` metadata and engine logging.
- Deeper-pool selection across all quote assets/venues is still pending.
- Liquidity remains the current `quote-balance-x2` approximation.

### 6. Unify Sell Fill Modeling

Status: pending.

Problem:
Normal copied sells use optional 0x quote pricing. Exit-rule sells duplicate a separate pricing/slippage path and do not call 0x.

Change:
Extract a shared fill-pricing/execution helper used by both normal sell signals and exit-rule sells.

Acceptance:

- Normal sells and exit sells use the same fee, slippage, 0x, and accounting model.
- Tests prove exit sells use 0x when configured.
- Existing position close behavior remains unchanged.

## Open Decisions

- Should 0x network failure skip buys, or only explicit no-route/no-liquidity responses?
- Should manual candidate copies bypass fallback-price-source and TWAP gates, or should reviewer approval only bypass decode/staleness/auto-copy gates?
- Should DefiLlama be allowed for sells and exits when no pool price exists?
- Do we want to persist price/liquidity provenance in `paper_fills`, `price_marks`, both, or only logs first?

## Suggested First Work Item

Start with price provenance. It enables the later gates without changing buy behavior immediately, and it gives us better observability before making the engine stricter.
