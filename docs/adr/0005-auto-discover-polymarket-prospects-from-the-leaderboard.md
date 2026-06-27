# Auto-discover Polymarket leaders from the leaderboard, observe-first

Polymarket leaders are added by hand today (`insertWallet`, the settings page). We want an
**auto-finder**: a background job that discovers good Polymarket wallets and promotes them to tracked
leaders without a human pasting addresses. This ADR records the design decided in a grilling session,
and extends ADR 0003 (which made Polymarket a first-class copy-trade source but deferred scoring and
left v1 with "no score-gated protection").

## Context

The Polymarket Data API exposes an official leaderboard (`GET /v1/leaderboard`), ranked by `pnl` or
`vol` over a `timePeriod` (`DAY`/`WEEK`/`MONTH`/`ALL`), keyed by proxy wallet — same host we already
poll for `/trades`. But raw leaderboard rank is a poor proxy for "good to copy":

1. **Whale bias.** Rank rewards bankroll. A wallet up $2M on $50M volume (4%) outranks one up $200k
   on $400k (50%), though the latter is the better copy target.
2. **The market-maker trap.** Much top-leaderboard PnL is *market-making* (earning the spread by
   posting both sides), not directional conviction. Our copy mechanism (ADR 0003 Decision 2) copies a
   leader's directional fills at the current best ask/bid; we **cannot** replicate an MM's edge that
   way, and copying one leg of a hedged book at the worse price bleeds.

The watcher polls every active polygon wallet every `POLYMARKET_POLL_MS` (20s default), so the
watched-leader count scales Data API load linearly — discovery growth must be bounded.

## Decisions

1. **The leaderboard is a *nominator*, not the source of truth on quality.** Discovery and evaluation
   are split: a pluggable nominator proposes addresses; a source-agnostic evaluation stage recomputes
   quality. v1 ships the leaderboard nominator only; counterparty-crawl and active-market-scan are
   future nominators behind the same seam.
2. **New glossary term: `Prospect`** — a wallet nominated by a discovery source and under evaluation,
   not yet promoted to a Leader. Distinct from `Candidate` (a trade signal); see CONTEXT.md.
3. **Primary qualification metric is realized ROI-style efficiency, not raw rank.** Gated by a minimum
   trade count (anti-luck) and recent activity (anti-dead-wallet). Win rate is explicitly *not*
   primary (buying 0.97 favorites yields high win rate and negative expectancy).
4. **Two-stage funnel for measurement.** Stage 1 (zero extra calls): shortlist from the leaderboard
   by `pnl/vol` efficiency + an absolute `pnl` floor. `pnl/vol` is whale-neutral (both scale with
   size) and filters most market-makers for free (they churn huge `vol` for thin `pnl`). Stage 2
   (per-shortlisted wallet): pull `/trades` for recency (newest timestamp) and sample-size count.
   **`/positions`/`/value` are an opportunistic bonus, never a gate** — a live probe showed top
   wallets are routinely flat between bets ($9.2M-PnL #1 returned `positions:[]`, `value:0`), so
   requiring open positions would reject the best wallets. Full `/trades`+Gamma lifetime ROI
   reconstruction is deferred to the same evaluation stage as a later refinement (accurate but a
   per-wallet call-storm).

   *Probe (2026-06-27) confirmations:* leaderboard returns at most **50 rows** per
   `(timePeriod, orderBy)` regardless of `limit`; `rank` is a **string**; MONTH/PNL leaders sit at
   `pnl/vol` **0.39–0.68** while the MONTH/VOL board is market-makers at **0.013 and negative** — the
   `0.03` floor cleanly separates them.
5. **Poll the `MONTH` window primarily; `ALL` corroborates.** Forward copy-trading needs recent,
   still-active edge. A wallet strong in both MONTH and ALL is more credibly skilled than one with a
   single hot month.
6. **Observe-first promotion.** A qualifying Prospect is auto-inserted as a Leader with
   **Watching = on, Auto-copy = OFF**. The bot records/scores its real signals immediately (building
   our own evidence), but never spends a paper dollar until a human flips Auto-copy on. The job must
   pass `autoCopy: false` explicitly — `insertWallet` defaults it to `true`.
7. **Bounded growth.** Slow cadence (~daily), a hard cap on auto-promoted leaders, and a small
   per-cycle promotion limit — all env knobs. Protects Data API load.
8. **The finder may retract only its own untouched promotions.** It may un-watch a leader IT added
   that a human never engaged with (auto-copy still off) when that leader decays below threshold or a
   clearly-better prospect needs the slot at cap. **Any human-engaged leader is sacrosanct** — the
   moment a human flips auto-copy on (or otherwise acts on it), the finder never touches it again.
   This gives healthy churn toward the current best prospects without ever overriding human intent.
9. **Persist Prospects in a dedicated table.** One row per evaluated wallet (source, metrics snapshot,
   verdict, score, timestamps), enabling dedup/cooldown on rejects, promotion provenance (auditable
   "why was this added"), and score trends to tune thresholds with real data.
10. **An in-runner job with last-run persistence.** `startProspectDiscoveryJob(db, { intervalMs })`
    following the existing job pattern, wired in `index.ts`, with a poll-state row tracking
    `lastDiscoveryAt` so a restart at daily cadence neither thrashes nor stalls a full day. No new
    process — consistent with ADR 0003's single-engine/in-process rationale.

## Consequences

- **Extends ADR 0003.** ADR 0003 left v1 with no automated protection on the downside; Decision 8 adds
  a *bounded* automated control (retract own untouched only) without contradicting "human toggles
  auto-copy." Scoring is still deferred (ADR 0003 Decision 6); observe-first means auto-added leaders
  accrue forward signals that a future separate-cohort scorer can consume.
- **New schema:** a `prospects` table + a provenance marker on leaders (auto-added vs human-touched)
  to enforce the sacrosanct rule, plus a discovery poll-state row. Migrations required.
- **Cold-start is forward-only** (watcher.ts): a freshly promoted leader records nothing from its
  past, so observe-first evidence accrues only going forward — slowly, by design.
- **New config knobs** (defaults to calibrate after the soak): discovery interval, leaderboard window,
  shortlist size, min `pnl`, min `pnl/vol`, min trades, recency days, max leaders, max promotions per
  cycle, reject cooldown days.
- **More Data API surface** confined to the polygon path: the `/v1/leaderboard` endpoint plus Stage-2
  `/positions` pulls, all on the host already used for `/trades`.

## Considered options

- **Trust leaderboard PnL rank with a light filter:** rejected as primary. Cheapest, but inherits
  whale bias and the market-maker trap most strongly. `pnl/vol` keeps the cheap-Stage-1 benefit while
  neutralizing both.
- **Full `/trades`+Gamma lifetime ROI reconstruction in v1:** rejected for v1. Most accurate but a
  per-wallet call-storm; kept as the deferred evaluation-stage refinement.
- **Full-auto promotion (watch + auto-copy on):** rejected. A blind feedback loop where a bad finder
  compounds losses with no human gate — unacceptable even on paper.
- **Review queue (no auto-add):** rejected as the target — it isn't "auto." The manual add path
  remains available regardless.
- **Additive-only (never retract):** rejected. Safe, but the cap becomes a permanent ceiling that
  early mediocre finds squat forever. Decision 8's "retract own untouched" gives churn while keeping
  human intent inviolable.
- **Standalone script + external scheduler:** rejected for v1. A second deploy/ops surface that
  duplicates DB/client wiring the runner already has; the in-runner job shares lifecycle and health.
- **ALL-time leaderboard window:** rejected as primary. Whale- and survivor-biased; surfaces inactive
  wallets the recency gate rejects anyway. Used only to corroborate.
