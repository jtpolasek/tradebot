# Code Review — Tradebot vs PLAN.md (2026-06-11)

Review of the Sonnet-built implementation against `PLAN.md`. Status in `CLAUDE.md` claims all phases complete; the items below contradict that. Ordered by priority.

## Status legend
- [ ] not started · [~] in progress · [x] fixed on branch `fix/code-review-2026-06-11`

---

## P0 — Critical (broken behavior / red suite)

- [x] **0.1 Root `pnpm test` is red.** Fixed: root `test` script now runs turbo with `--concurrency=1` so the DB-using suites (`store`, `paper-engine`) don't truncate the shared test DB concurrently. Suite is green (40 tests).
- [x] **0.2 Unguarded queue handlers.** Fixed: added `PaperEngine.enqueue()` wrapper that try/catches every queued handler and logs, so a DB error can't become an unhandled rejection.
- [x] **0.3 Base-chain pricing broken.** Fixed: `PaperEngine` now takes a per-chain RPC client map (`Record<ChainId, RpcClient>`, still accepts a single client for tests) and selects `rpcClients[signal.chain]`; runner passes `{ eth, base }`.
- [x] **0.4 Sells into native ETH missed.** Fixed: Strategy B now detects ETH received from a sale via WETH `Withdrawal` logs when there's no ERC-20 inbound, emitting the sell. Added `WETH_WITHDRAWAL_TOPIC`/`WETH_DEPOSIT_TOPIC` exports and a regression test.
- [x] **0.5 Provisional fill void/confirm unsound.** Fixed: provisionals now snapshot the full pre-trade portfolio + position for **both** buys and sells; `handleVoided` restores the snapshot exactly and persists it to the DB; `handleConfirmed` updates the recorded price without zeroing real fills when re-price fails.

## P1 — Resilience / correctness

- [x] **1.1 ChainWatcher failover is dead code.** Fixed: `onConnectionFailure()` now flips `usingFallback`/`primaryDownSince` on a failed attempt (primary→fallback, then back to primary if the fallback also fails or the failover window expires).
- [x] **1.2 No teardown on reconnect.** Fixed: `runLoop` now calls `teardown()` in the catch before retrying, so viem watchers + mempool WS are released and `cleanupFns` no longer grows.
- [x] **1.3 Mempool WS never independently recovers.** Fixed: the mempool `close` handler now schedules an independent reconnect (guarded so teardown/replacement doesn't double-open) instead of waiting for the main socket to cycle.
- [x] **1.4 No wallet hot-reload.** Fixed: both the watcher (`startWalletReload` → reconnect) and the decoder (`reloadWallets` → `setWallets`) poll the DB every 60s, so a wallet added at runtime starts producing signals without a restart.
- [x] **1.5 `resolveWalletId` falls back to raw address.** Fixed: the decoder now carries each wallet's DB UUID (`WalletIdentity`) and looks the id up from an in-memory map; a tracked address with no resolved id is skipped (logged) instead of writing a non-UUID FK. Removed the DB-lookup fallback entirely.
- [x] **1.6 Positions never closed.** Fixed: added `closePositionByKey` (stamps `closedAt`) and the engine now calls it when a sell empties a position and when a voided provisional had no prior position — so flat rows no longer reload as open zombies. DB-backed regression test added.
- [x] **1.7 Deduper maps grow unboundedly.** Fixed: `SignalDeduper` now timestamps each pending mempool signal and prunes entries older than a 15-min TTL (throttled to once a minute), evicting both the tx and nonce maps; dropped txs no longer accumulate. Injectable clock + unit test added.

## P2 — Dropped plan requirements

- [x] **2.1 Strategy A pool verification** fixed: Strategy A now verifies V2 pools through factory `getPair` and V3 pools through pool `fee()` + factory `getPool`, caching results and falling through to Strategy B on failed/rejected verification.
- [x] **2.2 Both-non-quote → two signals** fixed: decoder now expands non-quote→non-quote swaps into paired sell+buy signals, and the mempool deduper can track/confirm/void multiple signals for one tx hash.
- [x] **2.3 `token-blocklist` skip** fixed: engine checks `tokens.is_blocked` for traded and quote tokens before pricing/sizing and records skipped fills with `token-blocklist`.
- [x] **2.4 `SIZING_MODE=proportional`** fixed: engine now reads `SIZING_MODE` from config/settings and scales base copy size by source notional versus the leader's recent median notional, clamped 0.25x-4x before existing min/max rules.
- [x] **2.5 Sell-fraction semantics** fixed: engine now tracks each leader's estimated per-token holding from observed signals and sizes copied sells by the fraction the leader sold; unknown leader holding still exits 100% per plan. Regression test added.
- [x] **2.6 Exit worker** fixed: runner now starts a settings-driven exit job and executes TP/SL sells through `PaperEngine.executeExitSell`.
- [x] **2.7 Settings overrides** fixed: engine refreshes runtime sizing/liquidity settings from DB and honors adaptive `min_liquidity_usd`.
- [x] **2.8 Per-leader tier mutes** fixed: brain provider stores computed muted liquidity tiers and engine skips matching leader/tier signals.
- [x] **2.9 Adaptive liquidity notch inert** fixed: scorer adaptation now uses latest price marks for current price and live per-chain pricing liquidity lookups when runner RPC clients are available; copied-fill rows include chain for mark/liquidity resolution.
- [x] **2.10 0x `getQuotePrice`** fixed: paper engine now attempts usable 0x price quotes for buy/sell fills when `ZEROX_API_KEY` is configured, derives effective USD fill prices from quote amounts, applies quoted dex fees, and falls back to spot/slippage pricing when 0x is unavailable. Regression test added.
- [x] **2.11 `verifyLedger` script vacuous** fixed: script now replays real non-voided copied fills through the accounting engine, compares derived open positions and latest snapshot totals against the DB, and exits non-zero on mismatches.
- [x] **2.12 Aerodrome pricing on Base** fixed: Base pricing/liquidity discovery now probes Aerodrome Slipstream pools after Uni V3, and Base V3-style swaps verified through the Slipstream factory are tagged with venue `aerodrome`.
- [x] **2.13 trades < 5 → weight 0.5** fixed: scorer now uses a 0.5 baseline weight until a leader reaches five trades, with a unit test covering the threshold.
- [x] **2.14 bigint discipline** fixed: raw token amounts now use shared base-unit/ratio helpers in scorer, Strategy B, and pricing; quote amount validation uses bigint parsing.

## P3 — Moderate

- [x] **3.1 Scorer quote pricing** fixed: scorer now prices non-stable quote assets from latest marks or live pricing RPC, normalizes native ETH to WETH, and skips unresolved quotes instead of treating them as $1.
- [x] **3.2 Z-scores use prior run's stored stats** fixed: scorer now computes all wallet metrics for each window first, then derives z-scores against that current-run cohort before persisting stats.
- [x] **3.3 API key shipped to browser** fixed: browser calls now go through same-origin Next route handlers that inject `API_KEY` server-side; live feed uses an SSE proxy; API startup validates `API_KEY` with zod and fails closed when missing.
- [x] **3.4 `decide()` clamp order** fixed: minimum notional is applied before the max cap, capped dust trades skip instead of exceeding max size, equity/snapshots use latest marks with avg-cost fallback, and `dailyPnlUsd` is based on recent equity movement.
- [x] **3.5 `getDb(url)` ignores arg** fixed: store tracks the initialized database URL and throws on later mismatched URLs until `closeDb()` resets the singleton.
- [x] **3.6 Repo hygiene** fixed: no tracked or untracked root `tmp_*.json` files remain.

## Notes on uncommitted working-tree changes (at review time)
- `paperFills.ts` chain-join fix: **good**, keep.
- `price.ts` 0x liquidity-impact fallback: feature not in PLAN.md; recommend revert in favor of Aerodrome pool support (2.12).

---

# Round 2 — Review of the fix branch (2026-06-12)

Multi-angle review of `fix/code-review-2026-06-11` (main...HEAD, 20 commits). Every finding below was independently verified against the code (9 confirmed, 2 plausible). The first four corrupt the paper ledger on routine paths — fix those before trusting any PnL output.

> **Fix progress (2026-06-12, in flight — NOT yet committed, build/test NOT yet run):**
> Code-complete in working tree: **4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.9**.
> Remaining to implement: **4.8** (SSE closed-guard), **4.10** (/leaders null wallets).
>
> **NEXT STEPS when resuming:**
> 1. Implement 4.8 — `apps/web/src/app/api/stream/route.ts`: add a `closed` flag; `send()` returns
>    early if `closed` and wraps `controller.enqueue` in try/catch (set `closed=true` on throw);
>    abort handler sets `closed=true` before `controller.close()`. Prevents the unhandled rejection.
> 2. Implement 4.10 — `apps/api/src/index.ts` `/leaders` (~line 128): use `getAllWallets(db)` (already
>    imported) to build `byWallet` so deactivated-but-has-stats wallets resolve to a real wallet
>    object instead of `null`; only fall back to null if truly orphaned. Also add a stable key
>    fallback in `apps/web/src/app/leaders/page.tsx:111` (e.g. include index or walletId).
> 3. Run `pnpm build && pnpm test`. The 4.3 schema change added migration
>    `packages/store/drizzle/0002_add_side_to_trade_signals_unique.sql` — the test DB is migrated
>    by the suites via `migrate()`, so a fresh `_test` DB picks it up; if an existing test DB is
>    reused it must be re-migrated/dropped. Watch for decoder/deduper test fallout from 4.1/4.9.
> 4. Mark 4.8/4.10 `[x]` here, update CLAUDE.md Status, then commit.
>
> **Files touched so far:** `packages/decoder/src/deduper.ts`, `packages/decoder/src/decoder.ts`,
> `packages/decoder/src/decoder.test.ts`, `apps/runner/src/index.ts`,
> `packages/store/src/schema.ts`, `packages/store/src/repositories/signals.ts`,
> `packages/store/drizzle/0002_add_side_to_trade_signals_unique.sql` (+ `meta/0002_snapshot.json`,
> `meta/_journal.json`), `packages/paper-engine/src/engine.ts`, `scripts/verify-ledger.ts`.
>
> **Notes / gotchas:**
> - 4.3 migration: drizzle-kit re-emitted a stray `CREATE TABLE settings` (0001 has no meta
>   snapshot); the generated 0002 SQL was hand-trimmed to ONLY the constraint swap. Don't regen blindly.
> - 4.5: `WalletIdentity` gained a required `chain` field; decoder keys `wallets`/`walletIds` by
>   `chain:address`; all call sites (runner, reloadWallets, tests) updated.
> - 4.2: `ProvisionalEntry` now stores `cashDelta/realizedPnlDelta/feesDelta` (not `prevPortfolio`);
>   `handleVoided` reverses those deltas; position still restored from `prevPosition`.
> - 4.6: engine caches native WETH price per chain in `refreshNativePrices()` (called from
>   `refreshRuntimeSettings`); `estimateSignalSourceNotionalUsd` is now a method using `nativeUsd`.
> - 4.1: `deduper.resolveReplacedAll` takes a `currentTxHash` arg and skips eviction when the
>   nonce maps to the same tx (confirmation, not replacement).
> - 4.9: `takeMatchingEntry` returns null (→ `{action:'new'}`) instead of consuming entry[0] on no-match.
> - 4.7: verify-ledger now compares ONLY `cashUsd` against the snapshot (dropped mark-priced
>   positionsValue/equity/dailyPnl comparisons that caused false alarms). Its `[ ]` box below is
>   stale — it IS done; flip to `[x]` when you do 4.8/4.10.

## R2-P0 — Ledger corruption on routine paths

- [x] **4.1 Mempool→confirm double-commits every trade.** `decoder.ts:130`: confirmed events always carry a nonce (`chainWatcher.ts:306`), so `resolveReplacedAll` runs first and unconditionally evicts the pending entry for the *same* txHash (`deduper.ts:66-74` — the `txHash !==` check at `decoder.ts:132` only suppresses the voided event, not the eviction). `resolveConfirmed` then finds nothing and returns `{action:'new'}`: a second trade-signal is emitted, the engine commits cash/position twice for one trade, and the provisional is never confirmed nor voided (provisionals map leaks).
- [x] **4.2 `handleVoided` erases interleaved fills.** `engine.ts:886` restores the *entire* pre-trade portfolio snapshot (`{...prov.prevPortfolio}`, captured at `engine.ts:436`). Any fill processed between the provisional fill and the void (queue concurrency is 4, `engine.ts:104`) has its cash/realizedPnl/fee effects erased while its position rows remain — equity permanently inflated. Fix: reverse only the provisional trade's delta, not the whole snapshot. (This is the rework done for item 0.5; the snapshot approach itself is the bug.)
- [x] **4.3 'Both'-leg signals collapse onto one id.** `signals.ts:34`: the `trade_signals` unique key (`schema.ts:51`) and the conflict-fallback select omit `side`, while `buildSignals` (`decoder.ts:309`) emits sell+buy legs with identical `(chain, txHash, tokenIn, tokenOut)`. The buy leg's insert no-ops and the fallback returns the *sell* leg's id; `engine.ts:313-316` rebinds `signal.id`, so the buy's provisional overwrites the sell's in `provisionals`. On revert only one leg is reversed; on confirm the wrong leg is re-priced. (Undoes item 2.2 at the persistence layer — add `side` to the unique key + fallback filter.)
- [x] **4.4 Unknown-side trades are now copied.** `decoder.ts:276`: the old guard `result.side === "unknown"` was dropped; only `status === "skipped"` is checked. `analyzePairs` (`balanceDelta.ts:59-75`) returns `status:'candidate', side:'unknown'`, confidence 0.4 ("review before copying") for mixed buy/sell shapes, and `buildSignals` re-derives side from token addresses alone — two non-quote tokens → paired sell+buy for a trade whose direction was explicitly un-inferable.

## R2-P1 — Wrong attribution / broken features

- [x] **4.5 Wallet-id map drops the chain key.** `decoder.ts:87`: `walletIds` is keyed by address only (old code keyed `chain:address`); the shared decoder loads `getActiveWallets(db)` unfiltered (`apps/runner/src/index.ts:70-72`), so an address tracked on both eth and base collapses to one UUID (last writer wins) and the other chain's signals/fills/leader stats land on the wrong wallet row.
- [x] **4.6 Proportional sizing is a silent no-op for native-quoted trades.** `engine.ts:995` calls `estimateSourceNotionalUsd(candidate, 0)` — `nativeUsd` hardcoded to 0 — so ETH/WETH-quoted trades (`sizing.ts:36/41`) compute notional 0 → null → `proportionalScale` returns 1 and the median window never seeds. Item 2.4 effectively works only for stablecoin-quoted signals. Pass a real native price.
- [x] **4.7 `verify-ledger` fails healthy ledgers.** `verify-ledger.ts:142`: compares replayed cost-basis position value (`qty × averageEntryUsd`, line 138) against the engine's *mark-priced* snapshot (`engine.ts:208`), and inception `realizedPnlUsd` against `dailyPnlUsd` = 24h equity delta (`engine.ts:936`), with epsilon 1e-6 and no tolerance. Any position whose mark differs from cost, or any account older than a day, exits 1 — constant false alarms mask real corruption. (Item 2.11's replay is good; the snapshot comparison compares incompatible quantities.)
- [x] **4.8 SSE proxy unhandled rejection on disconnect.** `apps/web/src/app/api/stream/route.ts:44`: `send` enqueues with no closed-guard; the abort handler closes the controller (lines 74-77) while a poll may be mid-fetch; the resumed poll's `send` throws, the catch (line 67) calls `send` *again*, and the second throw escapes `void poll()` with no rejection handler — unhandled rejection in the Next server on every mid-poll disconnect (process exit under Node's default `unhandled-rejections=throw`, depending on Next's handler).

## R2-P2 — Moderate

- [x] **4.9 Deduper consumes unrelated entries on no-match.** `deduper.ts:98`: `entries.splice(index >= 0 ? index : 0, 1)` — when `signalsMatch` fails for every pending entry, entry[0] is consumed anyway and returned as `{action:'update'}`, so a confirmed signal with a different side/token re-prices an unrelated provisional with the wrong token's price (`engine.ts:845-875`). Return `{action:'new'}` (or leave entries intact) when nothing matches.
- [x] **4.10 `/leaders` returns null wallets → duplicate React keys.** `apps/api/src/index.ts:152` pushes `wallet: null as unknown as Wallet` for deactivated wallets that still have stats (`getAllLeaderStats` has no active filter); `leaders/page.tsx:111` keys rows on `l.wallet?.id ?? l.wallet?.address` with no fallback → `key={undefined}` duplicates and rows rendering as "—" with unattributable stats.

## R2 — Verified-plausible (below the cut)

- **`executeExitSell` skips `sourceWalletId === null` positions** (`engine.ts:715-718`) every 60s forever. No current write path produces null-wallet positions, so it only bites legacy rows in an old paper DB; the skip is at least logged.

## R2 — Cleanup / efficiency (no behavior change required, but cheap insurance)

- **`executeExitSell` duplicates the whole sell path** and has already diverged from `handleSignal` (hardcoded `dexFeeBps = 30`, no 0x quoting from 2.10) — exit fills are priced under a different model than copy fills. Extract a shared sell-fill function.
- Five copy-pasted 17-field skip-fill literals in `engine.ts` (327/363/395/457/523) → one `recordSkip(signal, reason)` helper.
- `rawToHumanNumber`/`toRawAmount` (`engine.ts:999/1030`) re-implement `money.ts` `fromBaseUnits`/`toBaseUnits`; `classifyLiquidityTier` and the stablecoin address tables are each maintained in two packages (move shared copies to `@tradebot/core`).
- `this.cashUsd` mirrors `portfolio.cashUsd` across six sync sites — replace with a getter.
- Efficiency: `takeSnapshot` fetches 288 rows per fill; scorer does sequential N+1 token lookups per window; the SSE route polls upstream per-client every 2s while the API's old WebSocket poller runs for zero clients (pick one stream mechanism); `subscribeNewHeads` writes `upsertLastBlock` on every ~2s head.
