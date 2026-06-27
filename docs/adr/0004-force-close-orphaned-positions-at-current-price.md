# Force-close orphaned EVM positions at the current price, not the leader's stale rate

When we copy a leader's fresh buy and hold it, the leader's matching sell can arrive too stale to
copy normally (backfill / poll lag past `MAX_SIGNAL_AGE_SEC`). That leaves an **orphaned position**:
shares we hold that the leader has already exited. Leaving it open poisons equity/valuation, so the
paper engine force-closes it on seeing the stale sell (`trySettleStaleEvmSell`). The decision here is
*which price* the close is booked at.

We price the force-close at the **current market**, most-honest source first:

1. **Live on-chain price** (`getUsdPriceResult`) — exists right now, DB-independent (RPC, not a DB
   read), and identical to how every normal EVM fill is priced.
2. **Last recorded mark** (`latestMark`) — only when the DB is reachable (it frequently is not at
   present).
3. **Leader's stale implied rate** (`amountOut·quoteUsd / amountIn`) — last resort, used **only** to
   guarantee the orphan closes when no current price is obtainable. Booked under
   `priceSource: "leader-implied-stale-sell"` so analytics can isolate these fills.

## Why

- **This knowingly contradicts ADR 0003 Decision 2** ("the leader's executed price is rejected;
  booking paper fills at stale prices manufactures fictional PnL"). That ruling holds for a normal
  copy-fill, where a reliable current price exists and the stale rate is strictly worse. It does
  *not* fit a forced orphan-close where often **no** current price is available and the position
  must come off the books regardless. The honest rule — current price first — is preserved; the
  stale rate survives only as a flagged fallback for the genuine no-data case.
- **Erasing the orphan ("as if it never happened") was rejected.** An orphan can only come from a
  *legitimately copied fresh buy* — stale buys are skipped before any position is created
  (`engine.ts` staleness gate), so there is no path to an orphan from a bad buy. Voiding that buy
  would delete real, already-held capital and discard exactly the round-trips the leader actually
  closed — systematically biasing measured performance and rewriting recorded snapshots. A
  force-close keeps the trade and books its real outcome.

## Consequences

- A stale leader sell against an open position now produces a `copied` sell fill instead of a
  `stale-signal` skip. Force-closes priced via the fallback tier carry
  `priceSource: "leader-implied-stale-sell"` and should be treated as lower-confidence PnL.
- If even the leader-implied rate is uncomputable, the orphan is left open (no fill) rather than
  closed at a fabricated price.
