# Tradebot — Session Resume Status

**Read this entire file before doing anything. It is the authoritative checkpoint for resuming work after a context clear.**

---

## Current Phase

**Phase 5 — Brain: scoring & adaptation** — NOT STARTED.

- Phase 0: COMPLETE (commit `2f760ed`)
- Phase 1: COMPLETE (commit `0024d63`)
- Phase 2: COMPLETE (commit `2302607`) — 79 total tests passing
- Phase 3: COMPLETE (commit `d23ad0c`) — 91 total tests passing
- Phase 4: COMPLETE (commit `f71c06a`) — 149 total tests passing

---

## What Was Done in Phase 3

All pricing source files written, tested, and committed:

| File | Status |
|---|---|
| `packages/pricing/src/price.ts` | done — `getUsdPrice`, `getLiquidityUsd`, `sqrtPriceX96ToPrice`, `clearCaches` |
| `packages/pricing/src/price.test.ts` | done — 12 tests (sqrtPriceX96 math, mocked RPC, both token-order cases) |
| `packages/pricing/src/marks.ts` | done — `startMarksJob` (60s interval) |
| `packages/pricing/src/zerox.ts` | done — ported 0x quote client |
| `packages/pricing/src/uniswapQuote.ts` | done — ported Uniswap quote client |
| `packages/pricing/src/fees.ts` | done — ported fee valuation helper |
| `packages/pricing/src/index.ts` | done |
| `packages/pricing/package.json` | done |
| `packages/pricing/tsconfig.json` | done |
| `packages/pricing/vitest.config.ts` | done |
| `packages/store/src/repositories/priceMarks.ts` | done — `insertPriceMark`, `latestMark`, `getOpenPositionTokens` |

### Key technical notes carried forward from Phase 3

- `RpcClient` in pricing uses `{ readContract: (args: any) => Promise<any> }` — same loose structural interface pattern as `MulticallClient` in decoder. Do NOT change to viem `PublicClient`.
- `getUsdPrice` tries quote assets in QUOTE_ASSETS order. For eth: USDC first (stablecoin→1.0), then USDT, DAI, WETH (→Chainlink). Non-quote tokens are priced via V3 pool vs first matching quote asset.
- `sqrtPriceX96ToPrice(sqrtPriceX96, dec0, dec1)` returns price of token0 in token1 (human units). When the target token is token1, caller must invert: `1 / price`.
- `liqCache` and `llamaCache` are module-level Maps. `clearCaches()` is exported for test use — call it in `beforeEach`.
- `startMarksJob` is NOT yet wired into `apps/runner/src/index.ts` — that wiring happens in Phase 4.

---

## Phase 4 — What Needs to Be Built

Per PLAN.md §7 Phase 4, `packages/paper-engine`:

### Files to create

| File | What it does |
|---|---|
| `packages/paper-engine/src/accounting.ts` | Port from `C:\Users\Willie\Documents\GMGN\src\lib\accounting.ts` — `applyTradeToState`, `applyTotalLossToState` (avg-cost position math, realized PnL) |
| `packages/paper-engine/src/accounting.test.ts` | Port the colocated test — keep all expected values unchanged |
| `packages/paper-engine/src/ledger.ts` | Port from `C:\Users\Willie\Documents\GMGN\src\lib\ledger.ts` — `ledgerDeltaFromTrade`, `derivePortfolioTotals`, `derivePositions`, `verifyLedger` |
| `packages/paper-engine/src/ledger.test.ts` | Port the colocated test |
| `packages/paper-engine/src/sizing.ts` | Port from `C:\Users\Willie\Documents\GMGN\src\lib\copy.ts` — `sizeCopyTrade`, `calculateCashCappedBuyUsd`, `estimateSourceNotionalUsd` |
| `packages/paper-engine/src/sizing.test.ts` | Port the colocated test |
| `packages/paper-engine/src/exits.ts` | Port from `C:\Users\Willie\Documents\GMGN\src\lib\exitWorker.ts` — pure functions `checkExitTrigger`, `calcExitQuantity` only; rewrite the worker loop against new repos |
| `packages/paper-engine/src/exits.test.ts` | Port the colocated test |
| `packages/paper-engine/src/engine.ts` | Main class: `decide(signal)` → copy/skip, `fill(signal, notionalUsd)` → `PaperFill`, ledger mutations, provisional fill handling |
| `packages/paper-engine/src/engine.test.ts` | Integration test: 20 scripted signals through bus → engine → store; assert final cash/positions/PnL to the cent |
| `packages/paper-engine/src/index.ts` | Exports |
| `packages/paper-engine/package.json` | Same pattern as pricing |
| `packages/paper-engine/tsconfig.json` | Extends `../../tsconfig.base.json` |
| `packages/paper-engine/vitest.config.ts` | Same pattern as pricing (loads root `.env`) |

### Also required

- Add missing store repositories (see below)
- Wire `startMarksJob` and `PaperEngine` into `apps/runner/src/index.ts`
- Add `pnpm verify:ledger` script

### Mirror decision logic (`decide`)

Order matters — first matching condition wins:

1. Leader weight from brain (stub `WeightProvider` interface returning constant `1.0` until Phase 5). Weight = 0 → skip `leader-weight-zero`.
2. Token blocked (`tokens.is_blocked`) → skip `token-blocklist`.
3. `getLiquidityUsd < MIN_LIQUIDITY_USD` → skip `below-min-liquidity`. Null liquidity → skip `no-liquidity-data`.
4. Sizing:
   - `notional = equity * BASE_TRADE_PCT * leaderWeight`, clamped to `[MIN_NOTIONAL_USD, equity * MAX_TRADE_PCT]`
   - Buy: if cash < notional, clamp to cash; if cash < MIN_NOTIONAL → skip `insufficient-balance`
   - Sell: only if we hold a position in that token from this leader. Sell same fraction leader sold. No position → skip `no-position`. Never short.
   - `SIZING_MODE=proportional`: scale by leader's trade notional vs their median recent notional (clamped 0.25×–4×)

### Fill simulation logic (`fill`)

- Base price: `getZeroxPrice` if ZEROX_API_KEY present, else `getUsdPrice`
- `slippageBps = dexFeeBps(venue) + impactBps + delayPenaltyBps(chain)`
  - `impactBps = 10_000 * notional / (2 * liquidityUsd)`, capped at 500
  - `dexFeeBps`: v2/aerodrome=30, v3=30 (or pool fee tier if known), unknown=30
  - `delayPenaltyBps`: from config `COPY_DELAY_PENALTY_BPS_ETH` / `COPY_DELAY_PENALTY_BPS_BASE`
- Buys fill at `price * (1 + slippageBps/10_000)`, sells at `price * (1 - slippageBps/10_000)`
- `feeUsd = GAS_USD_<CHAIN> + dex fee component`
- Mempool fills: `provisional: true`. On `signal-confirmed`: recompute price, update row. On `signal-voided`: restore cash/position, void fill.

### Store repositories needed for Phase 4

These don't exist yet — create them in `packages/store/src/repositories/`:

| File | Functions needed |
|---|---|
| `paperFills.ts` | `insertFill`, `updateFill`, `voidFill`, `getFill` |
| `positions.ts` | `upsertPosition`, `getPosition`, `getOpenPositions`, `closePosition` |
| `portfolioSnapshots.ts` | `insertSnapshot`, `latestSnapshot` |
| `signals.ts` | `insertSignal`, `upsertSignal` (for mempool→confirmed update) |

Export all from `packages/store/src/index.ts`.

### Acceptance criteria

- Integration test: 20 scripted signals (buys, sells incl. fractional, a revert-void, unknown token, insufficient-cash clamp) through bus → engine → store; assert final cash, positions, realized PnL to the cent
- Live or replay run ≥ 24h: equity curve renders from snapshots, no crash, never negative cash
- `verifyLedger` against DB at end — zero mismatches
- `pnpm build && pnpm test` green
- Commit: `feat: Phase 4 — paper engine, ported accounting/ledger/sizing/exits`

---

## Everything That Exists (Phases 0–3)

### Root
- `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`
- `docker-compose.yml` — db port 5433, db-test port 5434 (profile `test`)
- `.env.example`, `.env` (gitignored)

### packages/core/src/
- `types.ts`, `bus.ts`, `config.ts`, `chains.ts`, `money.ts`, `logger.ts`, `index.ts`

### packages/store/src/
- `schema.ts`, `db.ts`, `migrate.ts`
- `repositories/wallets.ts`, `repositories/chainState.ts`, `repositories/tokens.ts`, `repositories/priceMarks.ts`
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

### apps/runner/src/
- `index.ts` — ChainWatchers + Decoder + replay harness (`--replay <file> [--speed N]`)
- NOTE: `startMarksJob` and `PaperEngine` are NOT yet wired in — do that in Phase 4

### All tests: 91 total — all passing
- `@tradebot/core`: 14 tests
- `@tradebot/store`: 5 tests (require Docker test DB on port 5434)
- `@tradebot/ingest`: 28 tests
- `@tradebot/decoder`: 49 tests
- `@tradebot/pricing`: 12 tests
- `@tradebot/runner`: 1 placeholder test

---

## Critical Technical Notes

### RpcClient / MulticallClient loose interfaces
DO NOT use viem's `PublicClient` type directly in package source. Use structural interfaces:
- `MulticallClient = { multicall: (args: any) => Promise<any[]> }` (decoder/tokenMetadata)
- `RpcClient = { readContract: (args: any) => Promise<any> }` (pricing/price)
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
| accounting.ts (port target) | `C:\Users\Willie\Documents\GMGN\src\lib\accounting.ts` |
| ledger.ts (port target) | `C:\Users\Willie\Documents\GMGN\src\lib\ledger.ts` |
| copy.ts / sizing (port target) | `C:\Users\Willie\Documents\GMGN\src\lib\copy.ts` |
| exitWorker.ts (port target) | `C:\Users\Willie\Documents\GMGN\src\lib\exitWorker.ts` |
| Core types | `packages\core\src\types.ts` |
| chains.ts (QUOTE_ASSETS etc) | `packages\core\src\chains.ts` |
| config.ts (env vars) | `packages\core\src\config.ts` |
| Pricing main | `packages\pricing\src\price.ts` |
| Store schema | `packages\store\src\schema.ts` |
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
