# Tradebot — Session Resume Status

**Read this entire file before doing anything. It is the authoritative checkpoint for resuming work after a context clear.**

---

## Current Phase

All planned phases are **COMPLETE**. The system is fully built and running.

| Phase | Status | Commit |
|---|---|---|
| Phase 0 — Scaffold | COMPLETE | `2f760ed` |
| Phase 1 — EVM ingestion | COMPLETE | `0024d63` |
| Phase 2 — Swap decoding + replay | COMPLETE | `2302607` |
| Phase 3 — Pricing | COMPLETE | `d23ad0c` |
| Phase 4 — Paper trading engine | COMPLETE | `f71c06a` |
| Phase 5 — Brain: scoring + adaptation | COMPLETE | `747a828` |
| Phase 6 — API + dashboard | COMPLETE | `8a8d50d` |
| dev.ps1 startup script + API security | COMPLETE | `dabc3e1` |
| Health + metrics endpoint | COMPLETE | `361460b` |
| Mempool fast path | COMPLETE | `465296c` |
| Polymarket watch + record | COMPLETE | `ff75180` |

**Phase 7+ (Solana adapter, ML) — DO NOT BUILD unless user explicitly asks.**

Recent follow-up fixes (`9ef36b9`):
- Dashboard `/metrics` route proxies raw JSON metrics from the API; `/status` is the human UI.
- Runner/decoder now filter non-EVM wallets out of EVM decode paths; Polymarket remains record-only.
- Settings page shows Polygon wallets as `record-only` and hides their auto-copy toggle.

---

## How to Run

```powershell
.\dev.ps1
```

Pre-conditions: Docker Desktop running, `.env` filled in (copy `.env.example`).

The script: starts Postgres, waits for `pg_isready`, runs migrations, then launches runner + API + web concurrently via `turbo run dev`.

| Service | URL |
|---|---|
| Dashboard (Next.js) | http://localhost:3000 |
| Human status view | http://localhost:3000/status |
| Raw metrics JSON | http://localhost:3000/metrics or http://localhost:3001/metrics |
| API (Fastify) | http://localhost:3001 |
| Postgres | localhost:5433 |

---

## What Exists (all phases)

### Root
- `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`
- `docker-compose.yml` — db port 5433, db-test port 5434 (profile `test`)
- `.env.example`, `.env` (gitignored)
- `dev.ps1` — one-shot dev startup script
- `scripts/verify-ledger.ts` — `pnpm verify:ledger`

### packages/core/src/
- `types.ts`, `bus.ts`, `config.ts`, `chains.ts`, `money.ts`, `logger.ts`, `index.ts`

### packages/store/src/
- `schema.ts`, `db.ts`, `migrate.ts`
- `repositories/wallets.ts` — `getAllWallets`, `getActiveWallets`, `insertWallet`, `setWalletActive`, `getWalletById`
- `repositories/chainState.ts`, `repositories/tokens.ts`, `repositories/priceMarks.ts` — `latestMark`
- `repositories/signals.ts` — `insertSignal`, `upsertSignal`, `getSignalById`, `getRecentSignals`
- `repositories/paperFills.ts` — `insertFill`, `updateFill`, `voidFill`, `getFill`, `getRecentFills`
- `repositories/positions.ts` — `upsertPosition`, `getPosition`, `getOpenPositions`, `closePosition`
- `repositories/portfolioSnapshots.ts` — `insertSnapshot`, `latestSnapshot`, `getRecentSnapshots`
- `repositories/leaderStats.ts` — `getAllLeaderStats`, `getLeaderStatsByWallet`
- `repositories/adaptationLog.ts` — `insertAdaptationLog`, `getAdaptationLogs`
- `repositories/settings.ts` — `getAllSettings`, `getSetting`, `setSetting`
- `index.ts`, `drizzle/`, `drizzle.config.ts`

### packages/ingest/src/
- `backoff.ts`, `dedupe.ts`, `recorder.ts`
- `evm/topics.ts`, `evm/chainWatcher.ts`
- `polymarket/client.ts`, `polymarket/watcher.ts` — record-only Polymarket Data API poller for Polygon wallets
- `index.ts`

### packages/decoder/src/
- `types.ts`, `venues.ts`, `balanceDelta.ts`, `deduper.ts`
- `strategyA.ts`, `strategyC.ts`, `tokenMetadata.ts`, `decoder.ts`, `index.ts`
- Test fixtures in `test/fixtures/` (6 real receipt JSONs)

### packages/pricing/src/
- `price.ts`, `marks.ts`, `zerox.ts`, `uniswapQuote.ts`, `fees.ts`, `index.ts`

### packages/paper-engine/src/
- `accounting.ts`, `ledger.ts`, `sizing.ts`, `exits.ts`, `engine.ts`, `index.ts`

### packages/brain/src/
- `scoring.ts` — FIFO round-trip reconstruction, per-wallet stats
- `weights.ts` — z-score across cohort, `weight = clamp(2*sigmoid(score), 0, 2)`, auto-mute at 7d score < −1
- `adaptation.ts` — weekly liquidity-notch + per-leader category filter, writes `adaptation_log`
- `scorer.ts` — hourly job: scoring → weight update → persists to `leader_stats`
- `index.ts`

### apps/runner/src/
- `index.ts` — ETH/Base ChainWatchers + EVM-only Decoder + PolymarketWatcher + replay harness + startMarksJob + PaperEngine + brain scorer

### apps/api/src/
- `index.ts` — Fastify 5 + `@fastify/websocket` server
  - `GET/POST/DELETE /wallets`
  - `GET /signals?since=&limit=`, `GET /fills?since=&limit=`
  - `GET /candidates`, `POST /candidates/:id/copy`, `POST /candidates/:id/dismiss`
  - `GET /portfolio` (snapshot + positions with marks + 288 snapshots)
  - `GET /leaders` (all windows: 7d/30d/all)
  - `GET /adaptations?limit=`, `GET/PATCH /settings`
  - `GET /health` (unauthenticated shallow probe), `GET /metrics` (authenticated raw JSON)
  - `WS /stream` — polls Postgres every 2s, broadcasts `trade-signal` + `paper-fill` events
  - Auth: `X-Api-Key` header vs `API_KEY` env; CORS restricted to `CORS_ORIGIN` (default localhost:3000)

### apps/web/src/
- `lib/api.ts` — `apiFetch`, `wsUrl`, `formatUsd`, `formatPct`, `shortAddr`, `timeAgo`
- `app/layout.tsx` — sticky nav (Portfolio / Leaders / Feed / Settings)
- `app/globals.css` — dark design system ported from GMGN (`--bg: #020617`, panel/card/pill/button)
- `app/portfolio/page.tsx` — equity curve (lightweight-charts), 4 metric panels, positions table
- `app/leaders/page.tsx` — 7d/30d/all toggle, sortable stats table
- `app/feed/page.tsx` — WebSocket live feed + 24h REST history, auto-reconnect
- `app/candidates/page.tsx` — candidate review queue; Polymarket candidates are record-only
- `app/status/page.tsx` — human-readable health, chain watcher, and CU-budget view
- `app/metrics/route.ts` — raw JSON metrics proxy for direct `/metrics` access on the dashboard host
- `app/settings/page.tsx` — wallet CRUD, settings editor, adaptation log; Polygon wallets show record-only

### Test counts (195 total — all passing, non-Docker)
| Package | Tests |
|---|---|
| `@tradebot/core` | 14 |
| `@tradebot/store` | 5 (need Docker test DB on port 5434) |
| `@tradebot/ingest` | 28 |
| `@tradebot/decoder` | 49 |
| `@tradebot/pricing` | 12 |
| `@tradebot/paper-engine` | 40 |
| `@tradebot/brain` | 44 |
| `@tradebot/runner` | 1 |
| `@tradebot/api` | 1 |
| `@tradebot/web` | 1 |

---

## Critical Technical Notes

### RpcClient / MulticallClient loose interfaces
DO NOT use viem's `PublicClient` type directly in package source. Use structural interfaces:
- `MulticallClient = { multicall: (args: any) => Promise<any[]> }` (decoder/tokenMetadata)
- `RpcClient = { readContract: (args: any) => Promise<any> }` (pricing/price, paper-engine/engine)
This avoids TS2719 type-identity errors from pnpm dual-viem-path resolution.

### Db type — always use getDb() from @tradebot/store
Never create `drizzle(sql)` directly in apps. Use `getDb()` from `@tradebot/store`. Creating a new drizzle instance produces `PostgresJsDatabase<Record<string, never>>` which is incompatible with the store's typed `Db`. See TS2379.

### bigint discipline
- Raw token amounts stay `bigint` from decode to storage
- `amountHuman = Number(amountRaw) / 10 ** decimals` — for scoring only, never stored
- JSON.stringify throws on bigint — use a replacer everywhere you serialize

### exactOptionalPropertyTypes = true
Cannot assign `field: value | undefined` — use `...(value !== undefined ? { field: value } : {})`

### Drizzle numeric columns return strings
Parse at the repository boundary — return `number` (USD) or `bigint` (raw amounts) from repos.

### pnpm 11.x build approvals
Packages with install scripts must be listed under `allowBuilds` in `pnpm-workspace.yaml` (NOT `onlyBuiltDependencies`, NOT `pnpm.onlyBuiltDependencies` in package.json — those are deprecated/ignored in pnpm 11).

### Next.js on Windows
Do NOT use `output: "standalone"` in `next.config.ts` — causes `EPERM: operation not permitted, symlink` on Windows. Standalone output is only needed for Docker deploys.

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
| PLAN.md (source of truth) | `PLAN.md` |
| Old app reference (read-only) | `C:\Users\Willie\Documents\GMGN\src\lib\` |
| Core types | `packages\core\src\types.ts` |
| chains.ts (QUOTE_ASSETS etc) | `packages\core\src\chains.ts` |
| config.ts (env vars) | `packages\core\src\config.ts` |
| Store schema | `packages\store\src\schema.ts` |
| Paper engine main | `packages\paper-engine\src\engine.ts` |
| Brain scorer job | `packages\brain\src\scorer.ts` |
| Runner entry point | `apps\runner\src\index.ts` |
| API server | `apps\api\src\index.ts` |
| Web lib/api.ts | `apps\web\src\lib\api.ts` |
| .env (real keys) | `.env` (gitignored) |

---

## .env Values (from .env.example)
```
DATABASE_URL=postgres://tradebot:tradebot@localhost:5433/tradebot
TEST_DATABASE_URL=postgres://tradebot:tradebot@localhost:5434/tradebot_test
ALCHEMY_API_KEY=
BASE_ALCHEMY_API_KEY=
QUICKNODE_ETH_WS=
QUICKNODE_BASE_WS=
ZEROX_API_KEY=
API_KEY=                        # any random string; empty = warn-only mode
API_PORT=3001
NEXT_PUBLIC_API_URL=http://localhost:3001
NEXT_PUBLIC_API_KEY=
CORS_ORIGIN=http://localhost:3000
PAPER_STARTING_CASH_USD=100000
BASE_TRADE_PCT=0.01
MAX_TRADE_PCT=0.03
MIN_NOTIONAL_USD=50
MIN_LIQUIDITY_USD=150000
COPY_DELAY_PENALTY_BPS_ETH=10
COPY_DELAY_PENALTY_BPS_BASE=5
GAS_USD_ETH=4
GAS_USD_BASE=0.03
SIZING_MODE=fixed
LOG_LEVEL=info
```

---

## Hard Rules (non-negotiable)
1. `pnpm build && pnpm test` green before declaring any phase done
2. No `any` without immediate zod validation (exceptions: MulticallClient, RpcClient — documented above)
3. Raw token amounts stay `bigint`; addresses lowercase
4. Tests never touch real DB (`TEST_DATABASE_URL` only, port 5434, name must end in `_test`)
5. Never modify `C:\Users\Willie\Documents\GMGN`
6. No dependencies not in PLAN.md
7. Commit at every milestone
8. If a command fails twice, stop and report
9. Stop and say so when Docker is needed and not running
