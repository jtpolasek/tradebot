# Task: back off the WS liveness watchdog during a sustained outage

**Lane:** Opus-authored or GLM draft → Opus review (touches ingestion resilience / hot path — not money/keys, but review required).
**Source:** Follow-up from the WS liveness watchdog (commit `578dee9`, `fix(ingest): add WS liveness watchdog`). Surfaced live on 2026-06-25 during a **Base mainnet block-production outage** (Base network down, not Alchemy/our key — confirmed by HTTP working while newHeads delivered 0 across every provider).
**Branch:** `opus/watchdog-reconnect-backoff` (or `glm/…`; do NOT commit to `main` — pre-commit hook blocks it).

## Problem

The liveness watchdog in `packages/ingest/src/evm/chainWatcher.ts` (`checkLiveness`) forces a reconnect when no block arrives within `stallTimeoutMs` (eth 150s / base 90s). That's correct for a **zombie WS** (socket open, subscription silently dead) — a reconnect re-subscribes and recovers.

But when the **chain itself is down** (e.g. Base block production halted), there are no blocks to deliver from *any* endpoint, so every forced reconnect immediately re-stalls and the watchdog fires again ~every `stallTimeoutMs`. The result is **reconnect-thrashing**: a tight teardown→connect→backfill→stall loop for the entire duration of a multi-hour chain outage. Each cycle also re-runs `connect()` (a `getBlockNumber` + `planBackfill` + re-subscribe), spending CU and churning sockets for no benefit.

This is benign (it logs loudly and recovers the instant the chain returns) but wasteful and noisy over a long outage.

## Requirement

Add **bounded backoff** to the watchdog's forced reconnects so a sustained outage settles into occasional retries instead of hammering every `stallTimeoutMs`:

- Track consecutive watchdog-forced reconnects that did **not** result in a fresh event (i.e. the chain re-stalled without delivering a block after reconnecting).
- After each such failure, grow the effective stall-retry interval with exponential backoff (reuse `backoffMs` from `../backoff.js`, same 1s→30s family already used by `runLoop`), capped (e.g. cap the watchdog's reconnect interval at a few minutes — a chain outage doesn't need sub-minute polling).
- **Reset the counter the moment a real block arrives** (i.e. on the next `subscribeNewHeads` `onBlockNumber` / any genuine event that advances `lastEventTs` beyond the connect seed), so normal operation and one-off zombie recoveries are unaffected.

Keep the existing behaviour for the *first* stall (react promptly at `stallTimeoutMs`); only subsequent back-to-back failures back off.

## Watch out for

- **Don't confuse the connect-time seed with a real event.** `connect()` sets `lastEventTs = Date.now()`; a real recovery is a *block* arriving after that. The reset condition must key off an actual `onBlockNumber`/event, not the seed, or the backoff will never engage (the seed always looks "fresh" right after reconnect). Consider a separate `lastBlockTs` distinct from the seeded `lastEventTs`, or a flag set in `onBlockNumber`.
- **Interaction with the QuickNode failover** (`onConnectionFailure`): the watchdog currently forces a teardown that runLoop treats as a clean reconnect (not a failure), so it does **not** trip the fallback. Decide whether N consecutive watchdog stalls *should* flip to the configured fallback URL — for a provider-specific outage that helps; for a chain-wide outage (the Base case) it won't. Probably: keep watchdog backoff independent of failover, but note the choice in the commit.
- Don't break the existing watchdog unit tests (`chainWatcher.test.ts` → "ChainWatcher liveness watchdog"); add cases for: backoff grows on repeated stalls, and resets when a block finally arrives.

## Acceptance

`pnpm build && pnpm test` green. New tests cover the backoff-grows and reset-on-recovery paths. Manual sanity: during a simulated dead-newHeads chain, reconnect attempts space out instead of firing every `stallTimeoutMs`.
