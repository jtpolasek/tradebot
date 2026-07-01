# Collect a decision journal (with vetoed-signal counterfactuals) before any ML

The goal is paper PnL that would survive real execution ("sim-realism"), and the natural ML slot is
a per-signal copy/skip classifier. We decided **not** to train anything yet: first instrument, then
learn. This ADR records the ordering and the two data-collection decisions that are impossible to
fix retroactively.

## Context

Training a copy filter needs labeled outcomes. Today we have neither volume (the 72h soak hasn't
run) nor trust: the fill model's constants (flat gas, linear impact `notional/(2*liquidity)`, flat
delay-penalty bps) are hand-set and unmeasured. A model trained now would learn fill-model fiction.
Worse, if only *copied* signals are logged, the dataset is survivor-biased forever — vetoed signals'
outcomes are unrecorded and unrecoverable.

## Decisions

1. **Shadow quotes measure fill-model error.** At each paper fill, also fetch a real executable
   quote and persist the modeled-vs-quoted delta. Instrumentation only — never affects the fill.
   Sources: on-chain quoter `eth_call` against the *same pool the leader traded* on ETH/Base
   (0x is retired — see `a52839a`; an aggregator would be a new external dep and answers the wrong
   question, since we copy a specific pool trade, not routing); the public CLOB book endpoint on
   Polymarket.
2. **Decision journal logs every signal, copied or vetoed,** with the full feature vector known at
   decision time plus the eventual outcome. See CONTEXT.md (`Decision Journal`).
3. **Vetoed signals get counterfactual outcomes, labeled two ways:** fixed horizons (entry +1h /
   +24h / +72h, marked via existing pricing) as the primary, always-present label; leader-exit
   mirror (return if we'd copied the leader's entry and exit) recorded when the leader actually
   exits. Horizons guarantee no missing-label bias; leader-exit is the truer strategy target but is
   undefined when the leader never sells.
4. **ML comes after calibration.** Build order: shadow quotes → decision journal → soak collects
   both → recalibrate fill-model constants from shadow-quote deltas → only then train the classifier
   (gradient-boosted trees on tabular features, not deep nets — small data).

## Consequences

- The 72h soak doubles as the first calibration dataset — shadow quoting and the journal should
  land before it runs.
- New persistence: shadow-quote deltas and journal rows (features + horizon/leader-exit labels);
  a small labeling job marks horizons as they mature.
- Extra per-fill RPC (`eth_call` quote) and per-horizon price lookups — the pending
  bound-pricing-caches task matters more once labeling runs.
- Until calibration lands, treat headline paper PnL as unverified.

## Considered options

- **Train on existing fills now:** rejected — few rows, survivor-biased, labels priced by an
  uncalibrated fill model.
- **Aggregator API (1inch/ParaSwap) for shadow quotes:** rejected — new key/dep/rate limits, repeats
  the 0x fragility, and measures routing rather than the copied pool.
- **Leader-exit as the only counterfactual label:** rejected — undefined for never-exiting leaders,
  creating missing-label bias; kept as a secondary label alongside fixed horizons.
