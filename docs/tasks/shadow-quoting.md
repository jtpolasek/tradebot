# Task: shadow quoting (measure fill-model error against real executable quotes)

**Lane:** Opus builds (pricing/quoter math feeds fill-model calibration — "be careful" bucket).
**Source:** ADR 0006 Decision 1; CONTEXT.md `Shadow Quote`.
**Branch:** `opus/shadow-quoting`.

## Problem

The paper fill model's constants are hand-set and unmeasured: flat gas per chain, linear impact
`notional/(2*liquidity)`, flat delay-penalty bps (`packages/paper-engine/src/engine.ts`
`modeledSlippageBps`). Nobody knows the model's error vs reality, so headline paper PnL is
unverified. The goal (grilling 2026-07-01, Q1) is paper PnL that would survive real execution —
that requires per-fill ground truth.

0x is retired (`a52839a` — API stopped serving; `ZEROX_API_KEY` is parsed-and-discarded in
`config.ts`). Do **not** resurrect it.

## Requirement

At each *executed* paper fill (buys and sells; skips are out of scope), also fetch a real
executable quote for the same size, and persist the modeled-vs-quoted delta. Instrumentation only.

### Quote sources

- **ETH/Base:** on-chain quoter via `eth_call` against the **same pool the leader traded** —
  Uniswap QuoterV2 for V2/V3-style routes, the V4 Quoter using the decoded `poolId` (reuse the
  ADR 0002 plumbing in `packages/pricing`). Existing viem RPC; no new dep, no API key.
- **Polymarket:** public CLOB book (`clob.polymarket.com` book endpoint, keyless). Walk the book
  with the copy size → volume-weighted executable price for our notional.

### Persistence

New table `shadow_quotes`: `fillId` FK, `venue`/`chain`, `quotedAt`, `quoteSource`
(`quoter-v2` | `quoter-v4` | `clob-book`), `modeledPriceUsd`, `quotedPriceUsd`, `deltaBps`
(signed: positive = reality worse than model), `quoteRaw` JSONB, `status`
(`ok` | `no-route` | `error`) + `errorReason`.

### Behavior

- **Never affects the fill.** Quote fetch runs after the fill decision, fire-and-forget; a quote
  failure logs `status: error` and moves on. No retry storms — one attempt, short timeout.
- Quote the **same size** the paper engine filled, same direction.
- A `no-route`/empty-book result is itself signal — persist it, don't drop it.

### Reporting

A tiny read query or report script (`reports/` or `scripts/`) summarizing delta distribution:
count, median/p90 `deltaBps` by venue and by liquidity tier. This is what post-soak calibration
reads (ADR 0006 Decision 4).

## Constraints (non-negotiable for this task)

- Simulated money only — quotes are read-only calls; never build anything that could execute.
- No new dependency, no new API key. TypeScript strict, ESM, viem, zod at boundaries.
- Tests: mock the RPC/HTTP; `TEST_DATABASE_URL` only.
- Must land (with the decision journal) **before** the 72h soak starts — the soak doubles as
  calibration dataset #1 (ADR 0006).

## Acceptance

- [ ] Migration + schema for `shadow_quotes`; repository fns in `packages/store`.
- [ ] Every executed fill on ETH/Base/Polygon attempts exactly one shadow quote; delta persisted.
- [ ] Quote failure can never fail, delay, or alter a fill (test proves it).
- [ ] Delta-distribution report runs against the dev DB.
- [ ] `pnpm build` and `pnpm test` green.

## Out of scope

- Recalibrating fill-model constants (post-soak, separate task).
- Shadow quotes for skipped signals.
- Aggregator APIs (1inch/ParaSwap) — rejected in ADR 0006.
