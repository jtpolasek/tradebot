# Health & Metrics Endpoint — Plan

Operational visibility for the long-running runner so the 72h soak (PLAN §10) is
*observable* rather than just "did it crash." Adds a `/health` liveness probe and an
authenticated `/metrics` detail view on `apps/api`, fed by a Postgres heartbeat the runner
writes every ~10s.

## Design decision: Postgres heartbeat as the bridge

`apps/runner` owns the live WS state (connection status, reconnect counts, last-event age,
RSS); `apps/api` — the operator-facing, already-authed surface — only reads Postgres and never
shares the runner's in-process bus (PLAN §1). So runner-internal health crosses the process
boundary the same way everything else does: **the runner upserts a `runner_health` row; the api
reads it.** No new runner→api channel, no shared bus.

A stale heartbeat is itself the signal. If the runner dies or its event loop blocks (the exact
soak failure mode), it stops writing and the api reports `down` — something a runner-hosted
endpoint cannot do, because a dead process serves nothing.

## What each side contributes

**Runner-sourced** (in the heartbeat `payload` jsonb): per-chain WS `connectionState`
(`connected` / `reconnecting` / `fallback`), `usingFallback`, age of last event, connect-failure
count, backfill count, last block seen; process-level uptime, `rss`/`heapUsed` (the memory-leak
signal for soak), pid, git sha.

**API-derived** (Postgres only, no new RPC): DB liveness (`select 1`); `chain_state.updated_at`
age per chain (block production never stops, so this is the truest "is the chain advancing"
signal and needs no new write); last signal/fill/snapshot age; open-position / active-wallet
counts.

Deliberately **not** treated as unhealthy: zero recent signals/fills. Quiet markets aren't a
fault. Freshness thresholds key off the heartbeat and `chain_state`, not trade volume.

## Core abstraction — a pure rollup function

Mirrors the codebase's `derivePortfolioAnalytics` / `summarizeReprocess` / `planBackfill`
convention: a pure function with no DB/HTTP, fully unit-testable.

```ts
// packages/core/src/health.ts
deriveHealth(input: HealthInput, now: number, thresholds: HealthThresholds): HealthReport;
// HealthReport = { status: "ok" | "degraded" | "down"; checks: HealthCheck[] }
// HealthCheck  = { name: string; status: HealthStatus; detail?: string }
```

- `down`: DB unreachable, **or** heartbeat older than `HEARTBEAT_STALE_SEC`, **or** heartbeat absent.
- `degraded`: a chain on fallback, **or** `chain_state` stale past its per-chain threshold, **or** RSS over the soft ceiling.
- `ok`: otherwise.

The endpoint status is the worst of the individual checks.

## Components / file-by-file

1. **`packages/core/src/health.ts`** — `RunnerHealthPayload`, `ChainWatcherHealth`, `HealthCheck`,
   `HealthStatus`, `HealthThresholds`, `HealthInput`, `HealthReport`, and the pure `deriveHealth`.
   Exported from `core/src/index.ts`. Config thresholds added to `core/src/config.ts` +
   `.env.example`.
2. **`packages/store`** — migration `0009` creating `runner_health(id text pk default 'runner',
   ts timestamptz, payload jsonb)`; `repositories/runnerHealth.ts` with `upsertRunnerHealth`,
   `getRunnerHealth`, and freshness queries `latestSignalAt` / `latestFillAt`. jsonb (non-money
   telemetry) follows the `settings` precedent and avoids schema churn as fields evolve.
3. **`packages/ingest` — `ChainWatcher.getHealth()`** — expose the currently-private
   `lastEventTs` / `usingFallback` / `_backfillCallCount`, plus a new explicit `connectionState`
   field (set in `connect()` / `runLoop()`) and a `connectFailures` counter.
4. **`apps/runner`** — `startHeartbeatJob` (setInterval, `unref`'d like the other jobs) gathering
   each `watcher.getHealth()` + `process.memoryUsage()` + uptime → `upsertRunnerHealth`; also
   pino-logged at info so RSS is chartable from logs after a soak.
5. **`apps/api`** — `GET /health` (**unauthenticated**, exempt from the auth `preHandler`, shallow,
   200/503 + `{status}`) and `GET /metrics` (**authenticated**, full `HealthReport` + raw inputs).
   Reads Postgres only; does **not** spin up the viem WS clients.

## Config (core schema + `.env.example`)

```
HEARTBEAT_INTERVAL_MS=10000   # runner heartbeat cadence
HEARTBEAT_STALE_SEC=30        # older heartbeat ⇒ runner considered down
CHAIN_STALE_SEC_ETH=60        # chain_state.updated_at older ⇒ degraded
CHAIN_STALE_SEC_BASE=30
RSS_SOFT_LIMIT_MB=1536        # RSS over this ⇒ degraded (soak memory-leak guard)
```

## Tests

- **Pure** (`core`): `deriveHealth` — ok / fallback→degraded / stale-heartbeat→down /
  absent-heartbeat→down / chain-stale→degraded / db-down→down (hand-set inputs).
- **Store** (test DB): `runner_health` upsert/read round-trip; `latestSignalAt`/`latestFillAt`.
- **Ingest**: extend `chainWatcher.test.ts` for `getHealth()` state transitions (connected after
  connect, reconnecting after failure, fallback flag).

The api HTTP wiring is left untested by automated tests (its module does top-level
`app.listen()` + `getDb()`, so importing it boots a server — matching the existing placeholder
`api/src/index.test.ts`). Coverage lives in the pure function + repo, per codebase convention.

## Acceptance

Runner up → `/health` 200, `/metrics` shows both chains `connected`, fresh blocks, RSS. Kill the
runner → within `HEARTBEAT_STALE_SEC`, `/health` flips to 503 `down`. `pnpm build && pnpm test`
green.

## Scope calls (defaults)

- `/health` unauthenticated (probe-friendly) + separate authed `/metrics` for detail.
- JSON output, not Prometheus text format (additive later if Grafana is pointed at it).

## Optional follow-on (not in scope)

- A runner-local `/livez` on its own port for true real-time event-loop-lag detection.
- Prometheus `/metrics` text format.
- `runner_health_history` for in-DB RSS trend (current plan relies on scraping `/metrics` or
  pino logs over the soak).
