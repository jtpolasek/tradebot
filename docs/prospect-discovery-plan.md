# Implementation Plan — Auto-discover Polymarket Prospects

Implements **ADR 0005**. Read that first for the *why*; this doc is the *how*. Decisions are
referenced as (ADR §N). Defaults below are starting points to calibrate after the soak.

## Glossary (already in CONTEXT.md)

- **Prospect** — a wallet nominated by a discovery source, under evaluation, not yet a Leader.
- **Nominator** — a pluggable discovery source that proposes addresses + metadata; never judges quality.

## Architecture

```
Nominator (leaderboard)  ──►  Evaluation stage  ──►  Promotion          ──►  Retraction sweep
 proposes addresses+meta      recompute quality       observe-first add        un-watch own untouched
 (Stage 1: pnl/vol cut)       (Stage 2: /trades)      (autoCopy:false)         decayed/at-cap leaders
```

All four steps run once per discovery cycle inside one in-runner job (ADR §10). The Nominator is an
interface so crawl/scan can be added later without touching evaluation/promotion (ADR §1).

## Probe-confirmed API facts (2026-06-27)

- `GET {DATA_API}/v1/leaderboard?timePeriod=MONTH&orderBy=PNL&limit=50` → array, **max 50 rows**
  regardless of `limit`. Fields: `rank` (**string**), `proxyWallet`, `userName`, `xUsername`,
  `verifiedBadge` (bool), `vol` (number), `pnl` (number). No ROI, no trade count.
- `GET {DATA_API}/trades?user={proxyWallet}&limit=N` works for the leaderboard proxyWallet directly
  (already wrapped by `fetchTrades` in `packages/ingest/src/polymarket/client.ts`).
- `/positions` and `/value` are **flat for top wallets between bets** — opportunistic bonus only,
  never a gate (ADR §4).
- `pnl/vol`: MONTH/PNL leaders 0.39–0.68; MONTH/VOL market-makers 0.013 and negative. `0.03` separates.

## Config (`packages/core/src/config.ts`)

Add to the zod env schema (mirror existing `POLYMARKET_*` entries; also add blanks to `.env.example`):

Booleans use the existing `envBoolean` helper, **not** `z.coerce.boolean()` (which treats `"false"` as
`true` — the codebase convention is `envBoolean`, cf. `ALLOW_FALLBACK_PRICE_BUYS`).

```ts
PROSPECT_DISCOVERY_ENABLED: envBoolean.default(false),             // off until reviewed
PROSPECT_DISCOVERY_INTERVAL_MS: z.coerce.number().positive().default(86_400_000), // 24h
PROSPECT_LEADERBOARD_WINDOW: z.enum(["DAY","WEEK","MONTH","ALL"]).default("MONTH"),
PROSPECT_CORROBORATE_ALL: envBoolean.default(true),               // also pull ALL/PNL board
PROSPECT_MIN_PNL_USD: z.coerce.number().nonnegative().default(10_000),
PROSPECT_MIN_PNL_PER_VOL: z.coerce.number().nonnegative().default(0.03),
PROSPECT_MIN_TRADES: z.coerce.number().positive().default(20),
PROSPECT_RECENCY_DAYS: z.coerce.number().positive().default(14),    // probe: #1 last traded 11d ago
PROSPECT_MAX_LEADERS: z.coerce.number().positive().default(25),
PROSPECT_MAX_PROMOTIONS_PER_CYCLE: z.coerce.number().positive().default(3),
PROSPECT_REJECT_COOLDOWN_DAYS: z.coerce.number().positive().default(7),
```

`PROSPECT_DISCOVERY_ENABLED` defaults **false** — the job is wired but inert until a human turns it on.

**Status:** ✅ Step 1 shipped — knobs added to `config.ts` + `.env.example`; `@tradebot/core` builds and tests green.

## Schema + migration (`packages/store`)

### 1. `prospects` table (ADR §9) — add to `schema.ts`

```ts
export const prospects = pgTable("prospects", {
  address: text("address").primaryKey(),          // lowercase proxyWallet
  source: text("source").notNull(),               // "leaderboard" (the Nominator)
  userName: text("user_name"),
  xUsername: text("x_username"),
  // latest evaluation snapshot (provenance / audit)
  pnlUsd: doublePrecision("pnl_usd"),
  volUsd: doublePrecision("vol_usd"),
  pnlPerVol: doublePrecision("pnl_per_vol"),
  tradeCount: integer("trade_count"),
  lastTradeTs: bigint("last_trade_ts", { mode: "number" }),
  score: doublePrecision("score"),
  verdict: text("verdict").notNull(),             // "promoted" | "rejected"
  rejectReason: text("reject_reason"),
  firstSeenAt: timestamptz("first_seen_at").notNull().defaultNow(),
  lastEvaluatedAt: timestamptz("last_evaluated_at").notNull().defaultNow(),
  promotedWalletId: uuid("promoted_wallet_id").references(() => wallets.id),
});
```

### 2. Leader provenance for the sacrosanct rule (ADR §8) — extend `wallets`

```ts
autoAdded: boolean("auto_added").notNull().default(false),  // finder inserted it
humanTouched: boolean("human_touched").notNull().default(false), // sacrosanct once true
```

Set `humanTouched = true` wherever a human acts on a leader: `setWalletAutoCopy`, `setWalletActive`,
relabel, and the settings-page mutations (`apps/web/src/app/settings/page.tsx`,
`apps/api/src/app.ts`). The retraction sweep may only touch rows where
`autoAdded && !humanTouched && !autoCopy`.

### 3. Discovery run-state (ADR §10) — singleton row table

```ts
export const prospectDiscoveryState = pgTable("prospect_discovery_state", {
  id: integer("id").primaryKey().default(1),      // single row
  lastRunAt: timestamptz("last_run_at"),
  lastError: text("last_error"),
  promotedLastRun: integer("promoted_last_run").notNull().default(0),
});
```

Generate the migration with `pnpm --filter @tradebot/store db:generate` (drizzle-kit) — do **not**
hand-write SQL; follow the existing `migrations/00NN_*.sql` flow.

**Status:** ✅ Step 2 shipped — `prospects` + `prospect_discovery_state` tables and `wallets.autoAdded`
/`wallets.humanTouched` columns added; migration `drizzle/0013_lovely_mongu.sql` generated;
`markWalletHumanTouched` added to the wallets repo and wired into the human mutation paths (`PATCH`
and `DELETE /wallets/:id` in `apps/api/src/app.ts`, which the web settings page calls through). It is
deliberately *not* inside `setWalletActive`/`setWalletAutoCopy` — the retraction sweep calls those and
must not flag its own promotions touched. Build + tests green.

## Nominator interface (`packages/ingest/src/polymarket/`)

```ts
// nominator.ts
export interface Nomination {
  address: string;        // lowercase
  source: string;
  userName?: string;
  xUsername?: string;
  pnlUsd: number;
  volUsd: number;
}
export interface Nominator { nominate(): Promise<Nomination[]>; }
```

`leaderboardNominator.ts` — implements `Nominator`:
- `fetchLeaderboard(baseUrl, { timePeriod, orderBy, limit })` with a zod schema (`rank` is a **string**;
  coerce). Mirror `fetchTrades`'s 429 backoff.
- Pull MONTH/PNL (limit 50); if `PROSPECT_CORROBORATE_ALL`, also ALL/PNL (limit 50). Union by address,
  keep the MONTH row's numbers, flag whether it also appeared in ALL (corroboration boost).
- Return `Nomination[]` (lowercased addresses).

## Evaluation stage (`packages/ingest/src/polymarket/evaluateProspect.ts`)

Pure, source-agnostic, unit-testable with injected fetch. Per nomination:

1. **Stage 1 (no extra calls):** `pnlPerVol = pnl / max(vol, 1)`. Reject if
   `pnl < MIN_PNL_USD` or `pnlPerVol < MIN_PNL_PER_VOL` → `verdict:"rejected"`, reason recorded.
2. **Stage 2 (`/trades`):** `fetchTrades(address, { limit: 100 })`.
   - `tradeCount` = rows returned; reject if `< MIN_TRADES`.
   - `lastTradeTs` = max timestamp; reject if older than `RECENCY_DAYS`.
3. **Score** (for ranking/trends, not a gate): start with `pnlPerVol`, optional corroboration bonus.
4. Return `{ address, snapshot, verdict, score, rejectReason? }`.

`/positions`/`/value` intentionally **not** called as a gate (ADR §4); leave a TODO seam for the
deferred Gamma lifetime-ROI refinement.

## Repository (`packages/store/src/repositories/prospects.ts`)

- `upsertProspectEvaluation(db, snapshot)` — insert/update by address (set `lastEvaluatedAt`).
- `getRecentlyRejected(db, sinceMs)` — addresses rejected within `REJECT_COOLDOWN_DAYS` (skip re-eval).
- `getDiscoveryState(db)` / `setDiscoveryState(db, {...})` — singleton run-state.
- Extend `wallets.ts`: `insertWallet` accepts `autoAdded`; add `markWalletHumanTouched(db, id)`;
  `getRetractableAutoLeaders(db)` (`autoAdded && !humanTouched && !autoCopy`, polygon);
  `countActivePolygonLeaders(db)`.
- Export all from `packages/store/src/index.ts`.

**Status:** ✅ Step 3 shipped — `packages/store/src/repositories/prospects.ts` (`upsertProspectEvaluation`
preserving `firstSeenAt`; `getRecentlyRejected(db, since)`; `getProspect`; singleton
`getDiscoveryState`/`setDiscoveryState` with partial-field upsert so a good run clears `lastError`
without losing `lastRunAt`). `wallets.ts` extended with `insertWallet({ autoAdded })`,
`getRetractableAutoLeaders` (polygon + active + autoAdded + !humanTouched + !autoCopy), and
`countActivePolygonLeaders`. Exported from the store index. `prospects.test.ts` covers all of it
(6 tests). Build + tests green (523).

## The job (`apps/runner/src/prospectDiscoveryJob.ts`)

`startProspectDiscoveryJob(db, { intervalMs, nominator?, fetchImpl? })` returning `{ stop }`,
following `polymarketResolutionJob.ts`. Wire in `apps/runner/src/index.ts` (start + `stop()` in
shutdown). On `setInterval` tick **and** once on boot, run only if
`now - lastRunAt >= INTERVAL_MS` (last-run persistence, ADR §10).

Cycle (skip entirely if `!PROSPECT_DISCOVERY_ENABLED`):
1. `nominations = nominator.nominate()`.
2. Drop addresses that are already leaders (`getAllWallets` polygon) or recently rejected (cooldown).
3. Evaluate each remaining; `upsertProspectEvaluation` for **every** result (promoted and rejected — audit).
4. Collect qualifiers, sort by score desc.
5. **Capacity** = `MAX_LEADERS - countActivePolygonLeaders`. If `< needed`, run the **retraction sweep**:
   from `getRetractableAutoLeaders`, un-watch (`setWalletActive(false)`) the lowest-scoring ones that
   are below threshold or weaker than waiting qualifiers, freeing slots. Never touch `humanTouched`.
6. Promote up to `min(capacity, MAX_PROMOTIONS_PER_CYCLE)`:
   `insertWallet(db, { chain:"polygon", address, label: userName ?? address, active:true, autoCopy:false, autoAdded:true })`
   — **`autoCopy:false` is mandatory** (observe-first, ADR §6; `insertWallet` defaults it `true`).
   Link `prospects.promotedWalletId`.
7. `setDiscoveryState({ lastRunAt: now, promotedLastRun, lastError:null })`. Wrap in try/catch →
   record `lastError`. Use timeouts on all HTTP (consistent with ADR 0003's hang-isolation note).

## Observability

- Log per cycle: nominated / evaluated / promoted / retracted / rejected counts.
- Optional follow-up (not v1): a `/health` field for discovery freshness; a web "Prospects" view of the
  `prospects` table (provenance + score trends). The data is captured regardless.

## Tests (`pnpm build && pnpm test` green before any merge — non-negotiable)

- `leaderboardNominator.test.ts` — zod parse (string `rank`), MONTH∪ALL union, 50-row cap, 429 retry.
- `evaluateProspect.test.ts` — each gate (pnl floor, pnl/vol, sample, recency) accepts/rejects at the
  boundary; flat `/positions` does **not** reject; injected fetch.
- `prospects.test.ts` (store) — upsert, cooldown window, `getRetractableAutoLeaders` excludes
  `humanTouched`/`autoCopy` rows, capacity count. Use `TEST_DATABASE_URL` only (port 5434, `_test`).
- `prospectDiscoveryJob.test.ts` — cap respected, per-cycle limit respected, `autoCopy:false` on insert,
  sacrosanct leaders untouched, last-run gating, disabled-flag short-circuit.

## Build order (each step builds + tests green before the next)

1. ✅ Config knobs + `.env.example`.
2. ✅ Schema (3 changes) + generated migration; `markWalletHumanTouched` wired into human mutation paths.
3. ✅ `prospects` repo + wallet repo extensions + exports.
4. Nominator interface + leaderboard nominator + tests.
5. Evaluation stage + tests.
6. The job + runner wiring + tests.
7. Full `pnpm build && pnpm test`; commit per milestone; append to CHANGELOG.md.

## Workflow note (CLAUDE.md multi-model)

Steps 1–5 (config, schema scaffolding, nominator, evaluation, tests) are good **GLM** drafting work on
a `glm/prospect-discovery` branch. Promotion/retraction accounting and the `autoCopy:false`/sacrosanct
invariants are money-adjacent — **Opus reviews** the diff (`/code-review`) before it lands on `main`.

## Deferred (explicit non-goals for v1)

- Counterparty-crawl / active-market-scan nominators (seam exists).
- `/trades`+Gamma lifetime realized-ROI reconstruction (evaluation-stage TODO).
- Separate-cohort scoring of Polymarket leaders (still ADR 0003 §6).
- Auto-enabling auto-copy (always a human action).
