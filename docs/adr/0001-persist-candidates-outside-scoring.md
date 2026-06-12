# Persist candidates in trade_signals, but exclude them from leader scoring

The decoder used to discard ambiguous decodes entirely — `analyzePairs` produced a status
("decoded" / "candidate" / "skipped"), a confidence, and a reason, but none of it was
persisted, and candidate-grade results returned no signal at all. That made the bot
invisible-by-design: when it declined to copy a leader's trade, there was no record that
the trade ever existed. We decided to persist candidate-grade decodes as rows in
`trade_signals` (with `decode_status`, `confidence`, `reason` columns) and surface them
in a review queue with Copy/Dismiss actions, while keeping them out of automatic
execution and out of leader scoring.

## Consequences

- **Leader scoring counts only `decode_status = 'decoded'` signals.** Candidates are the
  decoder's uncertainty, not the leader's behavior — letting them into the scorer would
  distort weights with rows whose side or token may simply be wrong.
- **Manual copies from the review queue are excluded from leader scoring too.** A late
  manual copy executes at the price prevailing when the human clicks, not the leader's
  price; crediting or blaming the leader for the reviewer's timing would corrupt the
  stats. They DO count in portfolio analytics, which measure the portfolio rather than
  any leader.
- **Manual copies execute at current price, never backdated to the leader's price.**
  Backdating would let hindsight (reviewing only candidates that aged well) flatter the
  paper portfolio's PnL.

## Considered options

- **Labels only (keep dropping ambiguous decodes):** less work, no schema change, but a
  review queue can never exist and missed trades stay invisible. Rejected — visibility
  was the point.
- **Separate `candidates` table:** keeps `trade_signals` "pure," but a candidate that
  gets manually copied would have to migrate tables, and every read surface would need
  a union. Rejected for the simpler status column plus scorer-side filter.
- **Backdated manual fills:** rejected per above — survivorship-biased PnL.
