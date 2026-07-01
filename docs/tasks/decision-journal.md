# Task: decision journal (features + counterfactual labels for every signal)

**Lane:** Sonnet 5 draft → Opus review (schema + logging is mechanical; labeling math gets extra review scrutiny).
**Source:** ADR 0006 Decisions 2–3; CONTEXT.md `Decision Journal`.
**Branch:** `sonnet/decision-journal` (do NOT commit to `main` — review gate applies before merge).

## Problem

The engine already persists every decision — copies as real fills, vetoes as zero-quantity skip
fills with a `skipReason` (`packages/paper-engine/src/engine.ts` `recordSkip`, ~L474). But it does
**not** capture the feature vector known at decision time, and vetoed signals never get an outcome.
Any future learned copy filter (ADR 0006 Decision 4) needs both, and this data cannot be
reconstructed retroactively — it must be collected from now on, before the 72h soak.

## Requirement

### 1. Journal row per decision

New table `decision_journal` (drizzle schema + migration in `packages/store`):

- `id`, `fillId` (FK to the fill row — copies *and* skips both produce fills today), `signalId` if
  distinct, `walletId`, `venue`/`chain`, `tokenAddress`, `decidedAt`
- `decision` (`copied` | `skipped`) + `skipReason`
- `features` JSONB + `featureSetVersion` int (start at 1)
- Label columns, all nullable, filled later by the labeling job:
  `entryPriceUsd` (price a copy did/would have entered at),
  `returnPct1h`, `returnPct24h`, `returnPct72h` (fixed-horizon counterfactuals),
  `leaderExitReturnPct`, `leaderExitAt` (leader-exit mirror, when the leader actually exits),
  `labeledAt` per horizon or a small `labelsState` JSONB — keep it simple.

### 2. Feature vector v1 (ADR 0006 / grilling Q7: tiers 1+2 only)

Captured at decision time on the engine's decision path — everything is already in memory or one
cheap DB read; **no external calls**:

- Leader score-window stats (win rate, avg return, median hold, drawdown — from `brain` scoring)
- Signal age / latency ms, venue + chain
- Token liquidity USD + liquidity tier, modeled slippage bps, notional USD, leader's trade size
- Engine state: cash level, open-position count
- Cheap context: hour-of-day + day-of-week (UTC), leader's recent signal frequency, token age since
  first-seen, count of other watched leaders currently holding the token

Missing values are `null`, never fabricated. Schema is JSONB precisely so features can evolve —
bump `featureSetVersion` on any change.

### 3. Horizon-labeling job

A small in-runner job (follow the existing job pattern, e.g. `startProspectDiscoveryJob`) that
periodically finds journal rows with an unmatured horizon past due (`decidedAt + 1h/24h/72h <=
now`) and marks the hypothetical position via the existing pricing path, writing `returnPct*`.
For skips, entry price = the price a copy would have filled at (the engine computes this before
vetoing in most branches; where it never got that far, use the signal's observed price).

### 4. Leader-exit label

When the engine processes a leader's sell for a token that has open journal rows for that
leader+token, compute and write `leaderExitReturnPct` on those rows. Undefined (stays null) when
the leader never exits — that is expected, per ADR 0006.

## Constraints (non-negotiable for this task)

- **Never** changes a fill decision. Journal writes are fire-and-forget relative to the engine —
  a journal failure must not fail or delay the fill path (log and continue).
- No new dependency. TypeScript strict, ESM, zod at boundaries, bigint for raw amounts, lowercase
  addresses.
- Tests use `TEST_DATABASE_URL` only (port 5434, `_test` suffix); no live network.
- Labeling math (returnPct) touches accounting-adjacent territory — keep it dead simple
  (`(mark - entry) / entry * 100`) and unit-test it; Opus reviews this file hardest.

## Acceptance

- [ ] Migration + schema for `decision_journal`; repository fns in `packages/store`.
- [ ] Every engine decision (copy and every skip branch) writes a journal row with features v1.
- [ ] Labeling job fills horizon labels as they mature; leader-exit label written on leader sells.
- [ ] Unit tests: feature capture on copy + skip, horizon labeling math, leader-exit matching,
      journal failure does not break the fill path.
- [ ] `pnpm build` and `pnpm test` green.

## Out of scope

- Shadow quoting (separate task, Opus lane: `docs/tasks/shadow-quoting.md`).
- Any ML/training code, model files, or feature engineering beyond v1 list.
- Backfilling labels for pre-journal fills.

## Handoff back to Opus

Push `sonnet/decision-journal`; Opus `/code-review` pass before merge to `main`.
