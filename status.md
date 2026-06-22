# Tradebot — Session Resume Status

**Read this before resuming work after a context clear.** Lean checkpoint: current state + non-obvious gotchas only. Milestone history → `CHANGELOG.md`. Phase detail → `PLAN.md`. File inventory → read the repo tree.

---

## Current Phase

Core planned phases (0–9) **COMPLETE**. **Phase 10 in progress**: Polymarket paper copy-trading follow-up. Parts **10.1 (`conditionId` + outcome mapping)** and **10.2 (CLOB price source)** are complete; the path is still record-only operationally until the engine entry path lands. Latest `main`: see `git log`. Full per-milestone history in `CHANGELOG.md`.

**Phase 7+ (Solana adapter, ML) — DO NOT BUILD unless the user explicitly asks.**

Remaining gate before "done": the 72h soak test (PLAN §10).

---

## How to Run

```powershell
.\dev.ps1
```

Pre-conditions: Docker Desktop running, `.env` filled in (copy `.env.example`). Script starts Postgres, waits for `pg_isready`, runs migrations, then launches runner + API + web via `turbo run dev`.

| Service | URL |
|---|---|
| Dashboard (Next.js) | http://localhost:3000 |
| Human status view | http://localhost:3000/status |
| Raw metrics JSON | http://localhost:3000/metrics or http://localhost:3001/metrics |
| API (Fastify) | http://localhost:3001 |
| Postgres | localhost:5433 |

Test DB (for `pnpm test`): `docker compose --profile test up -d db-test` (port 5434).

---

## Critical Technical Notes (non-obvious — read before editing)

### RpcClient / MulticallClient loose interfaces
DO NOT use viem's `PublicClient` type directly in package source. Use structural interfaces:
- `MulticallClient = { multicall: (args: any) => Promise<any[]> }` (decoder/tokenMetadata)
- `RpcClient = { readContract: (args: any) => Promise<any> }` (pricing/price, paper-engine/engine)
This avoids TS2719 type-identity errors from pnpm dual-viem-path resolution.

### Db type — always use getDb() from @tradebot/store
Never create `drizzle(sql)` directly in apps. Creating a new drizzle instance produces `PostgresJsDatabase<Record<string, never>>`, incompatible with the store's typed `Db` (TS2379).

### bigint discipline
- Raw token amounts stay `bigint` from decode to storage.
- `amountHuman = Number(amountRaw) / 10 ** decimals` — for scoring only, never stored.
- JSON.stringify throws on bigint — use a replacer everywhere you serialize.

### exactOptionalPropertyTypes = true
Cannot assign `field: value | undefined` — use `...(value !== undefined ? { field: value } : {})`.

### Drizzle numeric columns return strings
Parse at the repository boundary — return `number` (USD) or `bigint` (raw amounts) from repos.

### pnpm 11.x build approvals
Packages with install scripts must be listed under `allowBuilds` in `pnpm-workspace.yaml` (NOT `onlyBuiltDependencies`, NOT `pnpm.onlyBuiltDependencies` in package.json — deprecated/ignored in pnpm 11).

### Next.js on Windows
Do NOT use `output: "standalone"` in `next.config.ts` — causes `EPERM: ... symlink` on Windows. Only needed for Docker deploys.

### `/metrics` vs `/status`
`/metrics` returns raw JSON (machine/ops). `/status` is the human dashboard. "`/metrics` looks like JSON text" is expected.

### Polymarket operational model
- Polygon/Polymarket is still **record-only operationally**. The watcher persists trades as candidate signals; the new CLOB price client exists, but nothing routes polygon signals into the paper-engine auto-copy path yet.
- Candidate copy is blocked in the API for non-EVM chains; the UI hides Copy for Polymarket rows.
- The watcher persists per-wallet cursor + poll state in `polymarket_poll_state` (restart recovery + observability).
- `trade_signals` now persist Polymarket `condition_id` + `outcome_index`, and `packages/pricing/src/polymarket.ts` wraps the public CLOB `/price` endpoint with bounded caching plus midpoint-based spread bps. These are prerequisites for Phase 10.3+.

### Candidate triage + recovery
- `/candidates/summary` returns global open-candidate counts by chain/venue/status, independent of the active `/candidates` filters. `null` legacy `review_status` normalized to `pending` at the repo boundary. Aggregate timestamps may arrive as strings — parse at the boundary.
- Operators can reset stale `copy-requested`/`copying` candidates to `pending` or mark `copy-failed` via `transitionCandidateReviewStatus` compare-and-set. The runner claims/finalizes manual copies with guarded transitions so a late worker result can't overwrite an operator action. Recovery never makes Polymarket copyable.

### API test harness
`apps/api/src/app.ts` is the injectable app factory; `index.ts` is a thin runtime boot wrapper. Route tests use Fastify `inject()` against `TEST_DATABASE_URL` with stream polling disabled for determinism.

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
| Polymarket CLOB client | `packages\pricing\src\polymarket.ts` |
| Store schema | `packages\store\src\schema.ts` |
| Paper engine main | `packages\paper-engine\src\engine.ts` |
| Brain scorer job | `packages\brain\src\scorer.ts` |
| Runner entry point | `apps\runner\src\index.ts` |
| API app factory / boot | `apps\api\src\app.ts` / `apps\api\src\index.ts` |
| .env (real keys) | `.env` (gitignored; values mirrored blank in `.env.example`) |

---

## What Is Next

Next feature slice: **Phase 10.3 — engine entry path**. Add a Polymarket-aware `handlePolymarketSignal` that bypasses `evm()`, prices from the CLOB client at decision time (ask for buys, bid for sells), and applies the Polymarket veto set (`auto-copy-off`, staleness, blocklist, insufficient-balance, `max-spread`, `market-closed`/`market-resolved`). After that: 10.4 auto-copy trigger, 10.5 marks + resolution settlement, 10.6 UI parity.

Still pending after Phase 10: the 72h soak test (PLAN §10) and the deferred live full-pipeline V4 re-check on a fresh post-deploy trade.

Defer unless explicitly requested: Solana adapter, ML/learned-strategy work, new third-party dependencies.
