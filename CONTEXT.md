# Tradebot

Paper-trading copy-trader for ETH mainnet and Base. Watches leader wallets, decodes their swaps, and simulates copying them with paper money.

## Language

**Leader**:
A tracked wallet whose trades the bot considers copying.
_Avoid_: Wallet (ambiguous — the bot has no wallet of its own), trader

**Trade Signal**:
A decoded trade performed by a leader, persisted regardless of whether it gets copied. On ETH/Base this is an AMM swap; on Polygon it is a Polymarket order-book fill of outcome shares. Same record, same lifecycle; the venue distinguishes them.
_Avoid_: Transaction, tx, event, swap (too AMM-specific)

**Outcome Share**:
A Polymarket position unit: an ERC-1155 CTF token representing one side of a binary market (e.g. "Yes"). Priced 0–1, where the price _is_ its USD value per share (no quote-asset conversion). Resolves to exactly $1 or $0 when the market settles.
_Avoid_: Token (it has no ERC-20 decimals), share (when ambiguous with equities)

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

**Orphaned position**:
A copied position the bot still holds after the leader has already sold out of it — the leader's exit signal arrived too stale to copy normally. Force-closed at the current price (never the leader's stale rate; see ADR 0004), not erased.
_Avoid_: Stuck position, stale position, dangling trade

**Resolution**:
The settlement of a Polymarket market: every outcome share becomes worth exactly $1 (winning side) or $0 (losing side). A forced close of any still-open copied position that realizes its PnL — distinct from a Fill, which is driven by a leader's trade. Has no ETH/Base analog. Detected by polling market status (Gamma API) by conditionId.
_Avoid_: Settlement (when ambiguous with general accounting), expiry
