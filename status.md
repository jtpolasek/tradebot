# Tradebot — Session Resume Status

**Read this entire file before doing anything. It is the authoritative checkpoint for resuming work after a context clear.**

---

## Current Phase

**Phase 6 — API + dashboard** — NOT STARTED.

- Phase 0: COMPLETE (commit `2f760ed`)
- Phase 1: COMPLETE (commit `0024d63`)
- Phase 2: COMPLETE (commit `2302607`) — 79 total tests passing
- Phase 3: COMPLETE (commit `d23ad0c`) — 91 total tests passing
- Phase 4: COMPLETE (commit `f71c06a`) — 149 total tests passing
- Phase 5: COMPLETE (commit `747a828`) — 193 non-Docker tests passing

---

## What Was Done in Phase 4

All paper-engine source files written, tested, and committed:

| File | Status |
|---|---|
| `packages/paper-engine/src/accounting.ts` | done — `applyTradeToState`, `applyTotalLossToState` |
| `packages/paper-engine/src/accounting.test.ts` | done — 4 tests (avg-cost math, partial sell PnL, guard throws) |
| `packages/paper-engine/src/ledger.ts` | done — `ledgerDeltaFromTrade`, `derivePortfolioTotals`, `derivePositions`, `verifyLedger` |
| `packages/paper-engine/src/ledger.test.ts` | done — 10 tests |
| `packages/paper-engine/src/sizing.ts` | done — `sizeCopyTrade`, `calculateCashCappedBuyUsd`, `estimateSourceNotionalUsd` |
| `packages/paper-engine/src/sizing.test.ts` | done — 8 tests |
| `packages/paper-engine/src/exits.ts` | done — `checkExitTrigger`, `calcExitQuantity`, `runExitCheck`, `resetExitWorkerState` |
| `packages/paper-engine/src/exits.test.ts` | done — 11 tests |
| `packages/paper-engine/src/engine.ts` | done — `PaperEngine` class: `decide`, `fill`, provisional fill handling, snapshot every 5 min |
| `packages/paper-engine/src/engine.test.ts` | done — 3 integration tests (20 scripted signals, zero-weight skip, insufficient-balance skip) |
| `packages/paper-engine/src/index.ts` | done |
| `packages/paper-engine/package.json` | done |
| `packages/paper-engine/tsconfig.json` | done |
| `packages/paper-engine/vitest.config.ts` | done |
| `packages/store/src/repositories/signals.ts` | done — `insertSignal`, `upsertSignal`, `getSignalById` |
| `packages/store/src/repositories/paperFills.ts` | done — `insertFill`, `updateFill`, `voidFill`, `getFill` |
| `packages/store/src/repositories/positions.ts` | done — `upsertPosition`, `getPosition`, `getOpenPositions`, `closePosition` |
| `packages/store/src/repositories/portfolioSnapshots.ts` | done — `insertSnapshot`, `latestSnapshot` |
| `scripts/verify-ledger.ts` | done — `pnpm verify:ledger` checks all fills |
| `apps/runner/src/index.ts` | updated — `startMarksJob` + `PaperEngine` wired in with viem RPC clients |

### Key technical notes carried forward from Phase 4

- `PaperEngine` holds cash + positions in memory, writes every mutation through `p-queue` (concurrency 4) to DB.
- `WeightProvider` interface defined in `engine.ts` with constant `1.0` stub — Phase 5 will replace the stub with real weights from `leader_stats`.
- `decide(signal, liquidityUsd)` is public and synchronous — takes pre-fetched liquidityUsd. Call order: weight=0 → token-blocked → liquidity → sizing → cash/position guards.
- Position keys are `${chain}:${tokenAddress.toLowerCase()}:${walletId}` — one position per (chain, token, leader).
- `provisional` fills: stored with `provisional: true`; on `signal-confirmed` the price is updated; on `signal-voided` cash and qty are restored and the fill is voided in DB.
- Fill price uses `getUsdPrice` only (0x quote is an optional enhancement not yet wired).
- `startMarksJob` and `PaperEngine` are wired into `apps/runner/src/index.ts`; viem `createPublicClient` with WS transport is used for both.

---

## Phase 5 — What Needs to Be Built

Per PLAN.md §7 Phase 5, `packages/brain`:

### Files to create

| File | What it does |
|---|---|
| `packages/brain/src/scoring.ts` | Per-wallet FIFO round-trip reconstruction, compute `trades, win_rate, avg_return_pct, median_hold_minutes, realized_pnl_usd, max_drawdown_pct` |
| `packages/brain/src/scoring.test.ts` | Unit tests: FIFO reconstruction, partial sells, open remainder at mark price |
| `packages/brain/src/weights.ts` | `weight = clamp(2 * sigmoid(score), 0, 2)`; z-score across cohort; auto-mute at 7d score < −1 |
| `packages/brain/src/weights.test.ts` | Hand-computed z-score + weight math, auto-mute trigger |
| `packages/brain/src/adaptation.ts` | Liquidity-notch weekly job; per-leader category filter; writes `adaptation_log` |
| `packages/brain/src/adaptation.test.ts` | Synthetic fills: liquidity notch trigger, per-leader tier mute, hard bounds |
| `packages/brain/src/scorer.ts` | Hourly job: runs scoring + weight update, persists to `leader_stats`, refreshes `PaperEngine` weights |
| `packages/brain/src/index.ts` | Exports |
| `packages/brain/package.json` | Same pattern as pricing |
| `packages/brain/tsconfig.json` | Extends `../../tsconfig.base.json` |
| `packages/brain/vitest.config.ts` | Same pattern as pricing (loads root `.env`) |

### Also required

- `settings` table in DB (key/value jsonb) — env vars are defaults, settings table is the override for adaptive values
- New Drizzle migration for `settings` table
- Wire `packages/brain` hourly job into `apps/runner/src/index.ts`
- Replace constant `WeightProvider` stub in runner with `BrainWeightProvider` that reads from `leader_stats`

### Scoring formula

Per PLAN.md §7 Phase 5:
- Score per window (7d/30d/all): `0.35*z(pnl) + 0.25*z(win_rate) + 0.25*z(avg_return) − 0.15*z(drawdown)`
- z-scores computed across tracked cohort (cohort size 1 → z = 0)
- `trades < 5` in window → score null, weight default 0.5
- `weight = clamp(2 * sigmoid(score), 0, 2)`
- 7d score < −1 → weight 0, write `adaptation_log` row

### Acceptance criteria

- Unit tests for FIFO reconstruction (incl. partial sells and open remainder), z-score/weight math with hand-computed values, auto-mute trigger, liquidity-notch rule with synthetic fills
- Seeded synthetic 30-day dataset → profitable leader weight > 1.2, losing leader → 0
- `pnpm build && pnpm test` green
- Commit: `feat: Phase 5 — brain scoring, weights, adaptive filters`

---

## Everything That Exists (Phases 0–4)

### Root
- `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`
- `docker-compose.yml` — db port 5433, db-test port 5434 (profile `test`)
- `.env.example`, `.env` (gitignored)
- `scripts/verify-ledger.ts` — `pnpm verify:ledger`

### packages/core/src/
- `types.ts`, `bus.ts`, `config.ts`, `chains.ts`, `money.ts`, `logger.ts`, `index.ts`

### packages/store/src/
- `schema.ts`, `db.ts`, `migrate.ts`
- `repositories/wallets.ts`, `repositories/chainState.ts`, `repositories/tokens.ts`, `repositories/priceMarks.ts`
- `repositories/signals.ts`, `repositories/paperFills.ts`, `repositories/positions.ts`, `repositories/portfolioSnapshots.ts`
- `index.ts`, `drizzle/0000_curly_ink.sql`, `drizzle.config.ts`

### packages/ingest/src/
- `backoff.ts`, `dedupe.ts`, `recorder.ts`
- `evm/topics.ts`, `evm/chainWatcher.ts`
- `index.ts`

### packages/decoder/src/
- `types.ts`, `venues.ts`, `balanceDelta.ts`, `deduper.ts`
- `strategyA.ts`, `strategyC.ts`, `tokenMetadata.ts`, `decoder.ts`, `index.ts`
- Test fixtures in `test/fixtures/` (6 real receipt JSONs)

### packages/pricing/src/
- `price.ts`, `marks.ts`, `zerox.ts`, `uniswapQuote.ts`, `fees.ts`, `index.ts`
- `price.test.ts` — 12 tests

### packages/paper-engine/src/
- `accounting.ts`, `ledger.ts`, `sizing.ts`, `exits.ts`, `engine.ts`, `index.ts`
- 5 test files — 40 tests total

### apps/runner/src/
- `index.ts` — ChainWatchers + Decoder + replay harness + startMarksJob + PaperEngine

### All tests: 149 total — all passing
- `@tradebot/core`: 14 tests
- `@tradebot/store`: 5 tests (require Docker test DB on port 5434)
- `@tradebot/ingest`: 28 tests
- `@tradebot/decoder`: 49 tests
- `@tradebot/pricing`: 12 tests
- `@tradebot/paper-engine`: 40 tests
- `@tradebot/runner`: 1 placeholder test

---

## Critical Technical Notes

### RpcClient / MulticallClient loose interfaces
DO NOT use viem's `PublicClient` type directly in package source. Use structural interfaces:
- `MulticallClient = { multicall: (args: any) => Promise<any[]> }` (decoder/tokenMetadata)
- `RpcClient = { readContract: (args: any) => Promise<any> }` (pricing/price, paper-engine/engine)
This avoids TS2719 type-identity errors from pnpm dual-viem-path resolution.

### bigint discipline
- Raw token amounts stay `bigint` from decode to storage
- `amountHuman = Number(amountRaw) / 10 ** decimals` — for scoring only, never stored
- JSON.stringify throws on bigint — use a replacer everywhere you serialize

### exactOptionalPropertyTypes = true
Cannot assign `field: value | undefined` — use `...(value !== undefined ? { field: value } : {})`

### Side classification
- `classifySide` in `decoder.ts` uses `isQuoteAsset(chain, address)` — address-based
- `analyzePairs` in `balanceDelta.ts` uses `STABLE_OR_NATIVE_ASSETS` symbol set — symbol-based

### Drizzle numeric columns return strings
Parse at the repository boundary — return `number` (USD) or `bigint` (raw amounts) from repos, never raw strings.

### vitest.config.ts pattern (all packages)
```ts
import { defineConfig } from "vitest/config";
import { config as loadDotenv } from "dotenv";
import { resolve } from "path";
import { fileURLToPath } from "url";
const __dirname = fileURLToPath(new URL(".", import.meta.url));
loadDotenv({ path: resolve(__dirname, "../../.env") });
export default defineConfig({ test: { include: ["src/**/*.test.ts"], testTimeout: 30_000 } });
```

---

## Key File Locations

| Purpose | Path |
|---|---|
| PLAN.md (source of truth) | `C:\Users\Willie\Documents\tradebot\PLAN.md` |
| Old app reference (read-only) | `C:\Users\Willie\Documents\GMGN\src\lib\` |
| Core types | `packages\core\src\types.ts` |
| chains.ts (QUOTE_ASSETS etc) | `packages\core\src\chains.ts` |
| config.ts (env vars) | `packages\core\src\config.ts` |
| Pricing main | `packages\pricing\src\price.ts` |
| Store schema | `packages\store\src\schema.ts` |
| Paper engine main | `packages\paper-engine\src\engine.ts` |
| Runner entry point | `apps\runner\src\index.ts` |
| .env (real keys) | `.env` (gitignored) |

---

## .env Values
```
ALCHEMY_API_KEY=87EHHJqPm6-uVnjoKJ7GG
BASE_ALCHEMY_API_KEY=87EHHJqPm6-uVnjoKJ7GG
DATABASE_URL=postgres://tradebot:tradebot@localhost:5433/tradebot
TEST_DATABASE_URL=postgres://tradebot:tradebot@localhost:5434/tradebot_test
ZEROX_API_KEY=<from GMGN .env.local>
```

---

## Hard Rules (non-negotiable)
1. `pnpm build && pnpm test` green before declaring any phase done
2. No `any` without immediate zod validation (exceptions: MulticallClient, RpcClient — documented above)
3. Raw token amounts stay `bigint`; addresses lowercase
4. Tests never touch real DB (TEST_DATABASE_URL only, port 5434, name must end in `_test`)
5. Never modify `C:\Users\Willie\Documents\GMGN`
6. No dependencies not in PLAN.md
7. Commit at every milestone
8. If a command fails twice, stop and report
9. Stop and say so when Docker is needed and not running
