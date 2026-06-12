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
- [ ] **3.6 Repo hygiene** — 11 `tmp_*.json` files in root.

## Notes on uncommitted working-tree changes (at review time)
- `paperFills.ts` chain-join fix: **good**, keep.
- `price.ts` 0x liquidity-impact fallback: feature not in PLAN.md; recommend revert in favor of Aerodrome pool support (2.12).
