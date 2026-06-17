# Implementation plan: Uniswap V4 pricing via decoded poolId

Companion to [ADR 0002](adr/0002-price-uniswap-v4-via-decoded-poolid.md). Goal: make V4-only
tokens (e.g. LOCAL on Base) priceable and liquidity-measurable so the engine evaluates them
against `MIN_LIQUIDITY_USD` instead of hard-skipping with `no-liquidity-data`.

Non-negotiables (per CLAUDE.md / PLAN.md §0.4): TypeScript strict, ESM, viem, bigint for raw
amounts, lowercase addresses, zod at boundaries, no live network in tests, `pnpm build && pnpm test`
green before declaring done. No new dependency (StateView reads use the existing viem clients).

## Pre-work: verify constants (RESOLVED 2026-06-16 — one on-chain check still required)

Resolved via Context7 (`/websites/uniswap_contracts_v4`) + the Uniswap deployments page
(developers.uniswap.org/contracts/v4/deployments).

**StateView ABI / semantics (confirmed):**
- `getSlot0(bytes32 poolId) → (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)`
- `getLiquidity(bytes32 poolId) → uint128` (active in-range liquidity)
- StateView is the off-chain **read** mirror of the singleton's `StateLibrary`; every call is keyed
  by the `bytes32 poolId` — exactly the value we now persist on the signal. No PoolManager call,
  no `extsload` plumbing needed for the happy path.
- **No reverse `poolId → PoolKey` lookup exists** (poolId is a keccak hash of the PoolKey).
  Consequence below.

**We do NOT need to persist the PoolKey.** Because there's no reverse lookup, recovering
currency0/currency1/fee/tickSpacing from poolId alone is impossible — but we don't need to. For the
buy decision we already hold *both* token addresses from the swap (tokenIn/tokenOut) and their
decimals (from metadata), and V4 orders currencies by address ascending (currency0 < currency1),
same as V3. So pricing derives currency ordering + decimals from the known pair and uses
`getSlot0`/`getLiquidity` purely for fresh `sqrtPrice` + L. (Marks for open positions, which call
pricing with only the token address, still need the counter-currency persisted — that's the Part 4
marks follow-up, unchanged.)

**Addresses (VERIFIED on-chain 2026-06-16 via `StateView.poolManager()`):**

| Chain | Contract | Address | Verification |
|---|---|---|---|
| eth (1) | StateView | `0x7ffe42c4a5deea5b0fec41c94c136cf115597227` | hasCode ✓; `poolManager()` → eth PM ✓ |
| eth (1) | PoolManager | `0x000000000004444c5dc75cb358380d2e3de08a90` | returned by eth StateView; matches `venues.ts:42` ✓ |
| base (8453) | StateView | `0xa3c0c9b65bad0b08107aa264b0f3db444b867a71` | hasCode ✓; `poolManager()` → base PM ✓ |
| base (8453) | PoolManager | `0x498581ff718922c3f8e6a244956af099b2652b2b` | returned by base StateView |

Method: viem `getCode` + `readContract('poolManager')` against public RPCs (base mainnet.base.org,
eth publicnode). Both StateViews are live contracts and report the matching PoolManager.

**Finding — our base PoolManager constant was wrong.** `venues.ts:48` held
`0x498581ff718922c3f8e6a244b8e9b1a0f10e6b44`; the real value is
`0x498581ff718922c3f8e6a244956af099b2652b2b`. Fixed 2026-06-16. It was latent (`v4PoolManager` is
defined but never read — `decodeV4Swap` does no PoolManager verification), so no past behavior was
affected, but Part 3 V4 pricing would have relied on it.

**Native-ETH handling (confirmed):** in V4 native ETH is `currency = address(0)`, not WETH. Pricing
must treat `0x0000…0000` as native and value it via Chainlink ETH/USD (same path WETH uses today).

## Part 1 — Decoder: surface the poolId (`packages/decoder`)

The V4 `Swap` event's `id` (indexed `bytes32`) is the poolId; `decodeV4Swap` already decodes the
log but returns only `tokenIn/out/amounts/venue`.

- [x] In `strategyA.ts`, widen the `decodeV4Swap` return (and the `strategyA` signature) to include
      `poolId` — done via a shared `DecodedSwap` type alias replacing the four repeated inline
      `Pick<TradeSignal, …>` annotations. `poolId` is extracted from the V4 swap log's indexed
      `bytes32 id` (`decoded.args.id`, falling back to `topics[1]`), lowercased.
- [x] V2/V3/Aerodrome paths omit `poolId` (optional field) — non-V4 venues leave it null/undefined.
- [x] Tests: extended "uses wallet Transfer amounts for Uniswap V4 token amounts"
      (`strategyA.test.ts:171`) to assert `result.poolId === 0xe500210c…a3a657` (the fixture swap
      log's `id`). 66 decoder tests pass.
- [x] Prereq pulled forward from Part 2: added `poolId?: string | null` to `TradeSignal`
      (`core/src/types.ts`) so the decoder return type-checks. The store column + migration +
      insert plumbing remain in Part 2.

**Part 1 complete** (2026-06-16). `pnpm build` (all 10 packages) and decoder tests green.

## Part 2 — Core + store: persist poolId on the signal

- [x] `packages/core/src/types.ts`: `poolId?: string | null` added to `TradeSignal` (done in Part 1
      as the decoder's type prerequisite).
- [x] `packages/store/src/schema.ts`: added `poolId: text("pool_id")` to `tradeSignals` (nullable).
- [x] Generated migration `drizzle/0007_aromatic_mariko_yashida.sql`
      (`ALTER TABLE "trade_signals" ADD COLUMN "pool_id" text;`) via `pnpm db:generate`. Journal +
      snapshot regenerated by the tool, not hand-edited.
- [x] Decoder plumbing: `buildSignals` `parts` type widened to carry `poolId`, and `makeSignal` sets
      `poolId: parts.poolId ?? null` so strategyA's V4 poolId reaches the `TradeSignal`
      (`decoder.ts`). strategyC/balance-delta paths leave it null.
- [x] Store plumbing: `insertSignal` + `upsertSignal` values write `poolId`; the upsert's
      `onConflictDoUpdate` set also backfills it (mempool→confirmed V4 reveal); `rowToSignal` reads
      `row.poolId ?? null` (`repositories/signals.ts`).
- [x] zod boundary: none needed — the API/runner don't validate inbound `TradeSignal` (signals are
      produced internally by the decoder, not accepted from request bodies).

**Part 2 complete** (2026-06-16). `pnpm build` (10 pkgs) and `pnpm test` (17 tasks, incl. store
DB-integration against the `db-test` container with 0007 applied) all green.

## Part 3 — Pricing: V4 branch in `findBestMarket` / price + liquidity (`packages/pricing`)

This is the core. Add a V4 read path keyed by poolId that produces the same `Market` shape so the
rest of pricing is unchanged.

- [x] Added `STATE_VIEW` (verified addresses) + StateView ABI (`getSlot0`, `getLiquidity`). No
      `getPoolKey`; currency ordering + decimals derive from the swap's token pair.
- [x] Added `readV4Market(chain, poolId, token, counterCurrency, client)`: reads `getSlot0`
      (null if `sqrtPriceX96 === 0n`) + `getLiquidity`; derives currency0/currency1 by address-sort
      of the token + counter (native placeholder → `0x0` for ordering, priced via WETH); prices via
      existing `sqrtPriceX96ToPrice`; returns a `Market` with a `venue: "uniswap-v4"` CachedPool
      carrying `poolId`.
- [x] Liquidity formula settled: virtual **quote** reserve only (mirrors V3's `× 2`), via
      `v4LiquidityUsd` — quote=currency1 → `L·√P`, quote=currency0 → `L/√P` (bigint, √P=`sqrtPriceX96/2^96`),
      × quoteUsd × 2; tagged `method: "v4-virtual-reserves"`.
- [x] Extended the venue union to `"uniswap-v4"` across `Venue`/`CachedPool`/`Market`/`PriceResult`/
      `LiquidityResult`.
- [x] Plumbed an optional `hint?: MarketHint = { poolId?, counterCurrency? }` through
      `getUsdPrice(Result)` / `getLiquidityUsd(Result)` → `findBestMarket`. With a hint, findBestMarket
      runs the V2/V3 scan **and** `readV4Market` and keeps the deeper USD market (token with both still
      picks the deepest); cached per token, with a guard so a held V4 hint isn't masked by a stale
      non-V4 cache entry.
- [x] `priceFromPool` branches on `venue === "uniswap-v4"` to read `getSlot0` from StateView by
      poolId; TWAP is skipped for V4 (`twap-unavailable` warning, no divergence gate).
- [x] Tests (`price.test.ts`, +3): prices a V4-only token from StateView; measures V4 liquidity from
      L; and returns null (no-liquidity-data) for the same token **without** a hint — proving the fix
      is hint-gated. 27 pricing tests pass.

**Part 3 complete** (2026-06-16). `pnpm build` (10 pkgs) + `pnpm test` (17 tasks) green; 27 pricing
tests. Pricing now exports `MarketHint`; the engine wiring is Part 4.

## Part 4 — Engine: pass the signal's poolId into pricing (`packages/paper-engine`)

- [x] Added a `v4MarketHint(signal)` helper (poolId + the swap's counter currency = quote side) and
      passed it into the buy-decision `getLiquidityUsdResult` + `getUsdPriceResult` (`engine.ts`) and
      the `handleConfirmed` re-price (which has the full confirmed signal). Exported `MarketHint`
      from the pricing index.
- [x] Test (`engine.test.ts`, +1): a V4 buy with a poolId is **copied** (hint flows → priceable);
      the same token **without** a poolId is **skipped `no-liquidity-data`** — proving the fix is
      hint-gated. Also asserts the engine called pricing with `{ poolId, counterCurrency: USDC }`.
- [x] **Marks follow-up — decided (option b).** The periodic marks job (`pricing/src/marks.ts`) and
      `executeExitSell` (`engine.ts:1078`) price off position/token rows that carry **no poolId**, so
      open V4 positions won't re-price (mark job logs "No price… skipping") and exit-sell slippage
      falls back to null-liquidity. Accepted for this cut: the buy executes and its fill price is
      correct; V4 marks/exit-depth are degraded, not blocking. **Follow-up filed below.**

**Part 4 complete** (2026-06-16). `pnpm build` (10 pkgs) + `pnpm test` (17 tasks) green; 65
paper-engine tests.

## Part 6 — Decoder poolId capture for balance-delta V4 swaps (complete)

**Surfaced by the live check** (`pnpm check-v4`): LOCAL's pricing works ($48,343 ≈ GMGN's $50k), but
every persisted LOCAL signal was `venue = balance-delta` with **no poolId** — so the engine never had
a poolId to pass. Root cause: LOCAL buys are **native-ETH-funded**, so only one Transfer references
the trader; `strategyA`'s V4 path can't map both sides and bails to balance-delta, which dropped the
poolId. (Parts 1–4 only captured it on the strategyA path.)

- [x] `extractV4PoolId(event)` in `decoder.ts`: returns the poolId when the tx has **exactly one** V4
      Swap log (multiple = multi-hop/aggregator → undefined, matching strategyA's single-swap rule;
      mempool events carry no logs → no-op).
- [x] `buildSignals` now sets `poolId = parts.poolId ?? extractV4PoolId(event)` — so **every**
      strategy (balance-delta included) carries the poolId, while strategyA's own poolId still wins.
- [x] The balance-delta path already resolves the ETH side to **WETH** (verified on the real LOCAL
      signal: `token_out = 0x4200…0006`), so the engine's `v4MarketHint` counter currency is
      well-formed — no native-placeholder handling needed.
- [x] Test (`decoder.test.ts`, +1): a native-ETH-funded buy with one V4 Swap log decodes via
      balance-delta **and** carries the poolId. 67 decoder tests pass.

**Part 6 complete** (2026-06-16). With this, the full chain is proven: decoder captures poolId →
persisted → engine hints pricing → pricing values the V4 pool. New LOCAL trades will now be
evaluated against `MIN_LIQUIDITY_USD` instead of skipping `no-liquidity-data`. (Existing pre-fix
rows still have null poolId; only new signals get it.)

## Follow-up — V4 marks & exit-sell depth — **complete (2026-06-17)**

Open V4 positions couldn't re-price because the marks job and exit sell had no poolId. Closed via
the **lookup** option (not denormalising onto positions): `getV4MarketHintForToken(db, chain, token)`
in `packages/store/src/repositories/signals.ts` recovers `{ poolId, counterCurrency }` from the most
recent `trade_signals` row touching the token on either leg (poolId is a property of the token's V4
pool, not a specific trade). `marks.ts` passes the hint into `getUsdPriceResult`; `executeExitSell`
passes it into `getLiquidityUsd`. Added indexes `trade_signals_token_in_idx` /
`trade_signals_token_out_idx` (migration 0008) so the per-tick marks lookup doesn't seq-scan the
growing signals history. Tests: store helper recovers the hint from buy/sell signals and returns null
for an unrelated token; engine test proves the exit sell passes the recovered hint to `getLiquidityUsd`.
`pnpm build` and `pnpm test` green.

## Part 5 — Validation & docs

- [x] `pnpm build && pnpm test` green across all packages (10 build, 17 test tasks) after each part.
- [x] Pricing unit tests value a known V4 pool from fixed `sqrtPrice`/`L`/decimals (price + liquidity
      USD), deterministic and offline (`price.test.ts`).
- [x] Live pricing verified against mainnet via `pnpm check-v4 <baseTxHash>`
      (`packages/pricing/scripts/check-v4.ts`): LOCAL's V4 pool reads **$48,343** liquidity
      (≈ GMGN's $50k) and a valid price — confirming the V4 read path end-to-end.
- [ ] Full-pipeline re-check on a **new** LOCAL trade once deployed (decoder→engine, not just the
      pricing script): feed should show it evaluated (copied, or `below-min-liquidity` only if truly
      under the floor) rather than `no-liquidity-data`. Existing pre-fix rows have null poolId.
- [ ] Update `CLAUDE.md` Status and note V4 coverage in `PLAN.md`/`CONTEXT.md` if the venue list is
      documented there. Commit per milestone.

## Risks / open questions

- **StateView ABI specifics** — exact method names/return tuples for `getSlot0`/`getLiquidity` and
  whether PoolKey (currencies/fee/tickSpacing) is recoverable from poolId alone. If not, persist the
  PoolKey fields from the decoder (the decoder has them in the swap context) rather than re-deriving.
  This is the main unknown; resolve in Pre-work before Part 3.
- **Liquidity comparability** — the V4 virtual-reserves figure vs. V3 `balanceOf×2`. Keep the
  formula explicit and reviewed so `MIN_LIQUIDITY_USD` stays meaningful; consider documenting the
  per-venue definition next to the setting.
- **Hooks** — exotic hooks can make `sqrtPrice`/`L` an incomplete picture of real depth. The figure
  is a proxy, same caveat as the V3 estimate; not a blocker.
- **TWAP/divergence gate** — likely unavailable for V4; buys rely on spot + the liquidity floor.
  Confirm that's acceptable given `MAX_SPOT_TWAP_DIVERGENCE_BPS` will simply not apply to V4.
