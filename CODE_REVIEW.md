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

- [ ] **2.1 Strategy A pool verification** (factory `getPool`/`getPair`) not implemented; `KNOWN_FACTORIES` unused.
- [ ] **2.2 Both-non-quote → two signals** — decoder emits buy only ("for now").
- [ ] **2.3 `token-blocklist` skip** never reads `tokens.is_blocked`.
- [ ] **2.4 `SIZING_MODE=proportional`** ignored; ported `sizing.ts` is dead.
- [ ] **2.5 Sell-fraction semantics** differ from plan (fraction of our position, not leader's holding).
- [ ] **2.6 Exit worker** (`runExitCheck`) ported+tested but never wired into the runner.
- [ ] **2.7 Settings overrides** not read by engine (adaptation writes `min_liquidity_usd`; engine reads env only).
- [ ] **2.8 Per-leader tier mutes** computed, logged, never enforced.
- [ ] **2.9 Adaptive liquidity notch inert** — scorer feeds `liquidityUsd: null` and `currentPriceUsd = entryPriceUsd`.
- [ ] **2.10 0x `getQuotePrice`** as primary fill-price source — ported, unused by engine.
- [ ] **2.11 `verifyLedger` script vacuous** — builds all-zero deltas; can't detect mismatches.
- [ ] **2.12 Aerodrome pricing on Base** absent; only Uni V3 factory probed; `aerodrome` venue never assigned.
- [ ] **2.13 trades < 5 → weight 0.5** — scorer defaults to 1.0.
- [ ] **2.14 bigint discipline** — `Number(rawAmount)` in `scorer.ts`, decoder Strategy B, pricing diff.

## P3 — Moderate

- [ ] **3.1 Scorer quote pricing** — cbBTC treated as $1; WETH-quoted trades dropped unless WETH is an open position.
- [ ] **3.2 Z-scores use prior run's stored stats** as cohort (need two-pass).
- [ ] **3.3 API key shipped to browser** via `NEXT_PUBLIC_API_KEY`; API accepts all requests when `API_KEY` unset; reads `process.env` directly (bypasses zod config).
- [ ] **3.4 `decide()` clamp order** — `Math.max(MIN_NOTIONAL)` after MAX cap; equity valued at avg cost not marks; `dailyPnlUsd` is cumulative not daily.
- [ ] **3.5 `getDb(url)` ignores arg** once singleton exists.
- [ ] **3.6 Repo hygiene** — 11 `tmp_*.json` files in root.

## Notes on uncommitted working-tree changes (at review time)
- `paperFills.ts` chain-join fix: **good**, keep.
- `price.ts` 0x liquidity-impact fallback: feature not in PLAN.md; recommend revert in favor of Aerodrome pool support (2.12).
