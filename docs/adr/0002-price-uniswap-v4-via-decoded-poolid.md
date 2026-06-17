# Price Uniswap V4 pools via the decoded poolId, not on-chain discovery

`findBestMarket` (in `packages/pricing/src/price.ts`) discovers a token's market by looping
quote assets × venues × fee tiers and calling each factory's `getPool(tokenA, tokenB, fee)`,
then measures liquidity as `quote balanceOf(poolAddress) × quoteUsd × 2`. It covers Uniswap V3
(eth + base) and Aerodrome CL (base). It does **not** cover Uniswap V4.

The consequence surfaced in production: a leader bought "Local Maxxing" (LOCAL,
`0xc92b…8ba3`) on Base, whose ~$50k of liquidity lives in a Uniswap V4 pool. `findBestMarket`
found no pool, returned `null`, and the engine skipped the copy with `no-liquidity-data` — the
null-liquidity guard (`engine.ts:267`) runs *before* the `MIN_LIQUIDITY_USD` threshold check
(`engine.ts:270`), so the user-facing setting never even applied. Every buy of any V4-only token
skips identically, regardless of how low `MIN_LIQUIDITY_USD` is set.

V4 cannot be added the way V2/V3 were, because two assumptions baked into `findBestMarket` do
not hold:

1. **No factory `getPool`.** V4 is a singleton **PoolManager**; a pool is identified by
   `poolId = keccak256(PoolKey{currency0, currency1, fee, tickSpacing, hooks})`. Because `hooks`
   is part of the key and unknowable a priori, a token's pools **cannot be enumerated on-chain by
   pair**. The loop-and-`getPool` discovery strategy has no V4 equivalent.
2. **No per-pool reserves.** The singleton holds every pool's tokens commingled, so
   `balanceOf(PoolManager)` says nothing about one pool. V4 depth must be derived from
   concentrated-liquidity math (active `liquidity` L + `sqrtPriceX96`).

We decided to **price V4 pools using the poolId we already observe in the leader's swap**, rather
than attempt on-chain discovery. The decoder already parses the V4 `Swap` event
(`event Swap(bytes32 indexed id, …, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)`,
`venues.ts:11`) but currently discards everything except token amounts and venue. We will thread
the `poolId` out of the decoder, persist it on `trade_signals`, and add a V4 branch to pricing
that reads pool state by poolId from the **StateView** periphery contract (`getSlot0(poolId)`,
`getLiquidity(poolId)`), deriving USD price from `sqrtPriceX96` and USD liquidity from L +
`sqrtPriceX96`.

This sidesteps discovery entirely: we never enumerate V4 pools — we learn the exact pool from the
trade we're copying.

## Consequences

- **V4 pricing/liquidity is keyed by poolId, available only for tokens we've seen traded.**
  Unlike V2/V3, we cannot price an arbitrary V4 token cold — only one for which we hold a poolId
  from a decoded swap. This is sufficient for the copy-trade decision (we always have the leader's
  swap) and for marking any position we opened, but `getUsdPrice(chain, addr)` called for a token
  with no known V4 poolId and no V2/V3 pool will still return null. Acceptable: we only ever need
  to price tokens we are trading.
- **`poolId` becomes part of the signal contract.** New nullable `pool_id` column on
  `trade_signals`; the decoder's `Pick<TradeSignal, …>` return widens to include it. Non-V4
  venues leave it null. This is the persisted handle pricing reads back.
- **V4 liquidity is depth-around-price (from L), not `balanceOf×2` TVL.** The two numbers are not
  directly comparable, so `MIN_LIQUIDITY_USD` would mean something subtly different across venues.
  We normalize by reporting V4 liquidity as the USD value of the virtual reserves implied by L at
  the current price (`amount0 = L / √P`, `amount1 = L · √P`), summed in USD — the closest analogue
  to the V3 `× 2` figure — and tag `method` accordingly so the difference is visible.
- **StateView address pinned per chain.** Resolved (2026-06-16): StateView exposes
  `getSlot0(bytes32 poolId)` and `getLiquidity(bytes32 poolId)` keyed directly by the poolId we
  persist — no `extsload` plumbing and no reverse `poolId → PoolKey` lookup (the latter doesn't
  exist; currency ordering + decimals are derived from the swap's known token pair instead).
  Addresses are pinned and on-chain-verified in the implementation plan (`StateView.poolManager()`
  returns the matching PoolManager on both chains). That verification also caught a **wrong base V4
  PoolManager constant** (`venues.ts:48`, latent/unread) — corrected to
  `0x498581ff718922c3f8e6a244956af099b2652b2b`.
- **Marks for open V4 positions need the poolId too.** The engine must carry the poolId from the
  buy signal into whatever it later uses to re-price the position, or re-derive it. Scoped in the
  plan as a follow-up; initial cut covers the buy decision and the fill's recorded price.

## Considered options

- **Add V2 and V4 both, balanceOf-style:** V2 *does* have `getPair` + real per-pair reserves, so
  it fits the existing model and is worth doing — but it does **not** solve LOCAL, which is V4-only.
  V2 is tracked separately; this ADR is specifically about V4, which the existing model cannot
  express.
- **On-chain V4 discovery by brute-forcing hooks:** infeasible — `hooks` is an arbitrary address
  in the poolId preimage; there is nothing to enumerate.
- **Off-chain indexer / Uniswap subgraph / GMGN API for V4 pools:** would allow cold pricing of
  arbitrary V4 tokens, but adds a network dependency and an external trust/rate-limit surface to
  the hot copy-decision path, and contradicts the "tests never touch live network" constraint
  without careful mocking. Rejected for the first cut; revisit if we ever need to price V4 tokens
  we haven't seen traded. The decoded-poolId path needs no new external dependency.
- **StateView vs. `extsload` on PoolManager:** StateView is the clean, typed read path and is the
  primary plan; `extsload` (raw storage reads with computed slots) is the fallback if a StateView
  deployment can't be confirmed for a chain. Both read the same singleton state.
