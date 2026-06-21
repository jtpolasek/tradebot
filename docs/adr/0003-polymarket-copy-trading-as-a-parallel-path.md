# Copy-trade Polymarket via a parallel path, not the EVM pipeline

The bot copies leader wallets on ETH and Base by decoding AMM swaps, pricing tokens from
on-chain pools, and running a paper engine with liquidity/slippage vetoes. Polymarket trading
already exists in the codebase but only as **record-only**: `PolymarketWatcher`
(`packages/ingest/src/polymarket/watcher.ts`) polls the Data API per watched polygon wallet and
writes every trade as a `decodeStatus:"candidate"` `TradeSignal`, deliberately decoupled from the
bus/decoder/pricing/engine. Those rows surface in the review queue and stop there — never scored,
priced, filled, marked, or exited.

We decided to make Polymarket a first-class **paper copy-trade source** (scored eventually,
auto-copyable, filled, marked, exited) — but to implement it as a **path parallel to the EVM
pipeline rather than by extending that pipeline to a third chain.** The EVM engine already throws
on any non-EVM chain by construction (`PaperEngine.evm()`, with the comment "The engine only ever
processes EVM trades"), and nearly every assumption underneath it is AMM-specific in ways that do
not hold on Polymarket:

1. **No AMM pool.** Polymarket is a central-limit order book (CLOB) of binary outcome shares. There
   is no pool to discover, no reserves, no `findBestMarket`, no Chainlink quote conversion.
2. **Outcome shares are already USD-denominated.** A share's 0–1 price *is* its USD value; there is
   no quote asset and no TWAP. Liquidity is order-book depth/spread, not pool TVL.
3. **A third exit mode with no EVM analog: resolution.** When a market settles, every share becomes
   worth exactly $1 (winning side) or $0 (losing side) — a forced close that realizes PnL even if
   the leader never sold.

Forcing polygon through the decoder + bus + AMM pricing + EVM-shaped vetoes would mean
`if (chain === polygon)` branches threaded through hot EVM code that has nothing to say about
order books. Instead, Polymarket gets its own price source, its own engine entry path, and its own
veto set, reusing only the data model (`TradeSignal`, `positions`, FIFO accounting) and the
decision knobs (sizing, the auto-copy toggle).

## Decisions

1. **Confidently-decoded Polymarket trades are normal `TradeSignal`s, not candidates.** They are
   gated by the per-leader **auto-copy** toggle exactly like EVM trades. `Candidate` reverts to its
   glossary meaning — genuine decode ambiguity only. (This supersedes the record-only-candidate
   behavior and amends ADR 0001; see Consequences.)
2. **Copy-fill price is the current CLOB best ask (buy) / best bid (sell) at copy-time**, from a
   Polymarket price source parallel to the AMM `pricing` package. The leader's executed price is
   rejected: polling makes it stale, and booking paper fills at stale prices manufactures fictional
   PnL.
3. **Exits are copy-sell + resolution settlement only.** No price-move stop rules — a "Yes" drifting
   0.60→0.30 is a probability re-rating, not a memecoin dump, and a leader still holding is
   expressing conviction.
4. **Auto-copy is triggered by a parallel polling job**, not by emitting on the EVM bus. The job
   reads new confirmed polygon signals and calls a Polymarket-aware engine entry path; the watcher
   stays decoupled and the EVM hot path is untouched. Polling latency is irrelevant for
   slow-moving prediction markets (and Decision 2 already re-prices at copy-time).
5. **Illiquidity gate is a max-spread veto plus a hard closed/resolved-market guard.** The AMM
   liquidity-USD, TWAP-divergence, and fallback-price vetoes are dropped; weight, auto-copy,
   staleness, blocklist, and balance vetoes are reused. Copying a buy into an already-resolved
   market is the prediction-market rug — vetoed as a correctness gate.
6. **Scoring is deferred for v1.** Polymarket leaders run at baseline weight 1.0, gated only by the
   auto-copy toggle and vetoes. Mixing them into the EVM z-score cohort is meaningless (bounded
   0–1 returns vs. unbounded memecoin variance), and realized round-trips accrue slowly because
   PnL is resolution-gated. Separate-cohort scoring is the documented eventual target.
7. **Pure parity for manual review.** No review-queue entry for Polymarket: auto-copy on → copy,
   off → an `auto-copy-off` skip fill. The toggle is the only control.

## Consequences

- **Amends ADR 0001.** ADR 0001 excluded Polymarket trades from scoring on the grounds that they
  were candidates ("the decoder's uncertainty, not the leader's behavior"). After Decision 1 they
  are no longer candidates, so that rationale no longer applies. They remain excluded from scoring
  in v1 for a *different* reason — Decision 6 (cohort mismatch + resolution-lagged PnL). ADR 0001's
  candidate-exclusion logic still stands for genuine EVM decode ambiguity.
- **A separate engine entry path bypasses `evm()`.** It never indexes `rpcClients`, never calls the
  AMM pricing functions, and uses the CLOB price source + Polymarket veto set. Positions reuse the
  existing table keyed by the CTF tokenId as `tokenAddress` (already how the watcher stores it);
  FIFO accounting and `applySellToState` are reused, with resolution modeled as a forced sell at
  $1/$0.
- **`conditionId` must be persisted.** The watcher currently drops it. Resolution settlement cannot
  map a held CTF tokenId to a win/lose payout without it. New nullable column + migration, plus the
  outcome→token mapping needed to decide which side won.
- **Two new background jobs.** A Polymarket marks writer (CLOB price → mark, so equity/valuation and
  later scoring work) and a resolution settler (poll Gamma by `conditionId` → force-close open
  positions at $1/$0). The existing marks and exit jobs stay hard-gated to EVM.
- **A third Polymarket API surface.** Data API (already used, `/trades`) + CLOB (`/price`, `/book`)
  + Gamma (market/resolution status). More external dependency and rate-limit surface; all confined
  to the polygon path and kept off the EVM hot path.
- **No score-gated protection in v1.** With constant weight 1.0 and no auto-mute, a poorly performing
  Polymarket leader is reined in only by the human toggling auto-copy off. Acceptable until
  separate-cohort scoring lands.

## Considered options

- **Unify through the bus/decoder/pricing as a third chain:** rejected. The engine throws on non-EVM
  by design and the AMM assumptions (pool discovery, reserves, quote conversion, TWAP) have no CLOB
  equivalent. Unification means chain-branching hot EVM code for a market structure it cannot model.
- **Fill at the leader's executed price (no new API):** rejected. Free, but polling makes it stale;
  booking fills at prices that no longer exist fabricates PnL, defeating the point of an honest paper
  sim.
- **Port the EVM price-move stop rules to Polymarket:** rejected for v1. Stop/take-profit semantics
  misfire on probability re-ratings; copy-sell + resolution cover honest exits.
- **Score Polymarket leaders in the existing cohort now:** rejected. Cross-asset-class z-scores are
  meaningless and would gate copying on noise. Deferred until a separate cohort with real resolution
  data exists.
- **Keep everything in the review queue (manual-only, no auto-copy):** rejected as the target, though
  it is effectively the pre-existing state. The goal is parity with EVM auto-copy; the manual path
  remains available for EVM candidates regardless.
- **Split Polymarket into its own standalone app/process:** rejected for v1. The attraction is
  process isolation (a CLOB/Gamma hang can't wedge the EVM hot path) and independent deploy/scaling
  (interval-polled vs. websocket-realtime). But the decisive blocker is that `PaperEngine` is a
  single-instance, single-portfolio authority: it loads cash/positions/portfolio in-memory and writes
  one snapshot series. A second engine instance in another process would mutate the same
  cash/positions/snapshots in the DB concurrently — races on cash, double-counted equity, conflicting
  snapshots — which the single-instance design exists to prevent (a money-accounting non-negotiable).
  A separate app also still depends on `store`/`core`/`paper-engine`/`pricing`, so it buys process
  isolation, not module isolation — and most of the isolation upside is already had in-process (the
  watcher is decoupled and the engine runs on an error-catching `PQueue`; wrapping the CLOB/Gamma
  calls in timeouts closes the rest). **The one condition that flips this:** if Polymarket should have
  its *own* cash pool and equity curve ("two bots" rather than one account trading three venues), a
  standalone app with its own engine instance and snapshot series becomes clean and the isolation
  benefits come free. That is a product choice, not a technical one; revisit only if a separate
  Polymarket portfolio is wanted.
