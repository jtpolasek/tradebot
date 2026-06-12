# Tradebot

Paper-trading copy-trader for ETH mainnet and Base. Watches leader wallets, decodes their swaps, and simulates copying them with paper money.

## Language

**Leader**:
A tracked wallet whose trades the bot considers copying.
_Avoid_: Wallet (ambiguous — the bot has no wallet of its own), trader

**Trade Signal**:
A decoded swap performed by a leader, persisted regardless of whether it gets copied.
_Avoid_: Transaction, tx, event

**Candidate**:
A trade signal the decoder could not classify confidently enough to copy automatically; it is persisted and surfaced for human review with the reason it was held back.
_Avoid_: Ambiguous signal, low-confidence decode

**Watching**:
Whether a leader is being tracked at all — subscriptions, signal recording, and scoring. Off frees ingest capacity and parks the leader without deleting its history.
_Avoid_: Active, enabled, deleted

**Auto-copy**:
Whether the bot may spend paper money on a watched leader's buys. Off keeps the leader watched and scored but never buying; on still respects every risk veto.
_Avoid_: Selected, copy mode

**Fill**:
The paper engine's recorded decision on a trade signal — either a simulated execution or a skip with a reason.
_Avoid_: Trade, order, execution
