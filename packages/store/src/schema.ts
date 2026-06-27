import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  numeric,
  integer,
  bigint,
  doublePrecision,
  jsonb,
  unique,
  primaryKey,
  index,
} from "drizzle-orm/pg-core";

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const wallets = pgTable("wallets", {
  id: uuid("id").primaryKey().defaultRandom(),
  chain: text("chain").notNull(),
  address: text("address").notNull(),
  label: text("label").notNull(),
  active: boolean("active").notNull().default(true),
  // When false, the wallet is still watched and scored but the engine never opens new positions
  // from its signals (skip reason 'auto-copy-off'). Existing positions can still be sold to exit.
  autoCopy: boolean("auto_copy").notNull().default(true),
  // True when the prospect-discovery finder inserted this leader (vs. a human). Only auto-added,
  // untouched, non-auto-copy leaders are eligible for the retraction sweep (see humanTouched).
  autoAdded: boolean("auto_added").notNull().default(false),
  // Set true the moment a human acts on this leader (toggle active/auto-copy, relabel, delete). Once
  // true the row is sacrosanct: the discovery retraction sweep must never un-watch it. Wired at the
  // human/API layer, never inside setWalletActive/setWalletAutoCopy (the sweep calls those too).
  humanTouched: boolean("human_touched").notNull().default(false),
  addedAt: timestamptz("added_at").notNull().defaultNow(),
}, (t) => [unique().on(t.chain, t.address)]);

export const tokens = pgTable("tokens", {
  chain: text("chain").notNull(),
  address: text("address").notNull(),
  symbol: text("symbol").notNull(),
  name: text("name").notNull(),
  decimals: integer("decimals").notNull(),
  firstSeen: timestamptz("first_seen").notNull().defaultNow(),
  isBlocked: boolean("is_blocked").notNull().default(false),
}, (t) => [primaryKey({ columns: [t.chain, t.address] })]);

export const tradeSignals = pgTable("trade_signals", {
  id: uuid("id").primaryKey().defaultRandom(),
  chain: text("chain").notNull(),
  walletId: uuid("wallet_id").notNull().references(() => wallets.id),
  txHash: text("tx_hash").notNull(),
  source: text("source").notNull(),
  side: text("side").notNull(),
  tokenIn: text("token_in").notNull(),
  tokenOut: text("token_out").notNull(),
  amountIn: numeric("amount_in").notNull(),
  amountOut: numeric("amount_out").notNull(),
  venue: text("venue").notNull(),
  observedAt: timestamptz("observed_at").notNull(),
  confirmedAt: timestamptz("confirmed_at"),
  blockNumber: bigint("block_number", { mode: "number" }),
  // Decoder's confidence in the classification. 'decoded' signals are copyable/scoreable;
  // 'candidate' signals are persisted for human review but excluded from auto-copy and scoring.
  decodeStatus: text("decode_status").notNull().default("decoded"),
  confidence: numeric("confidence"),
  reason: text("reason"),
  externalUrl: text("external_url"),
  reviewStatus: text("review_status"),
  // Uniswap V4 poolId (bytes32 hex) from the Swap event; null for non-V4 venues. Pricing reads it
  // back to value V4-only tokens, whose pools can't be discovered on-chain by token pair.
  poolId: text("pool_id"),
  // Polymarket condition metadata for later resolution settlement. Null for all non-Polymarket
  // venues; the Polygon copy path persists it so marks/settlement can join a held outcome share
  // back to the market that ultimately resolves.
  conditionId: text("condition_id"),
  outcomeIndex: integer("outcome_index"),
}, (t) => [
  unique().on(t.chain, t.txHash, t.tokenIn, t.tokenOut, t.side),
  // Support recovering a V4 poolId for a held token (marks job + exit-sell depth), which look up
  // a signal by the traded token on either leg. Without these the lookup seq-scans the growing
  // signals history every marks tick.
  index("trade_signals_token_in_idx").on(t.tokenIn),
  index("trade_signals_token_out_idx").on(t.tokenOut),
]);

export const paperFills = pgTable("paper_fills", {
  id: uuid("id").primaryKey().defaultRandom(),
  signalId: uuid("signal_id").notNull().references(() => tradeSignals.id),
  decidedAt: timestamptz("decided_at").notNull(),
  decision: text("decision").notNull(),
  skipReason: text("skip_reason"),
  side: text("side").notNull(),
  tokenAddress: text("token_address").notNull(),
  quoteAddress: text("quote_address").notNull(),
  qty: numeric("qty").notNull(),
  priceUsd: numeric("price_usd").notNull(),
  notionalUsd: numeric("notional_usd").notNull(),
  feeUsd: numeric("fee_usd").notNull(),
  slippageBps: integer("slippage_bps").notNull(),
  latencyMs: integer("latency_ms").notNull(),
  provisional: boolean("provisional").notNull().default(false),
  voided: boolean("voided").notNull().default(false),
  priceSource: text("price_source"),
  priceVenue: text("price_venue"),
  pricePoolAddress: text("price_pool_address"),
  liquidityUsd: numeric("liquidity_usd"),
});

export const positions = pgTable("positions", {
  id: uuid("id").primaryKey().defaultRandom(),
  chain: text("chain").notNull(),
  tokenAddress: text("token_address").notNull(),
  qty: numeric("qty").notNull(),
  avgCostUsd: numeric("avg_cost_usd").notNull(),
  openedAt: timestamptz("opened_at").notNull().defaultNow(),
  closedAt: timestamptz("closed_at"),
  realizedPnlUsd: numeric("realized_pnl_usd").notNull().default("0"),
  sourceWalletId: uuid("source_wallet_id").references(() => wallets.id),
});

export const portfolioSnapshots = pgTable("portfolio_snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  ts: timestamptz("ts").notNull(),
  equityUsd: numeric("equity_usd").notNull(),
  cashUsd: numeric("cash_usd").notNull(),
  positionsValueUsd: numeric("positions_value_usd").notNull(),
  dailyPnlUsd: numeric("daily_pnl_usd").notNull(),
});

export const leaderStats = pgTable("leader_stats", {
  walletId: uuid("wallet_id").notNull().references(() => wallets.id),
  window: text("window").notNull(),
  trades: integer("trades").notNull().default(0),
  winRate: numeric("win_rate"),
  avgReturnPct: numeric("avg_return_pct"),
  medianHoldMinutes: numeric("median_hold_minutes"),
  realizedPnlUsd: numeric("realized_pnl_usd"),
  maxDrawdownPct: numeric("max_drawdown_pct"),
  score: numeric("score"),
  weight: numeric("weight").notNull().default("1"),
  updatedAt: timestamptz("updated_at").notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.walletId, t.window] })]);

export const priceMarks = pgTable("price_marks", {
  chain: text("chain").notNull(),
  tokenAddress: text("token_address").notNull(),
  ts: timestamptz("ts").notNull(),
  priceUsd: numeric("price_usd").notNull(),
  source: text("source").notNull(),
}, (t) => [primaryKey({ columns: [t.chain, t.tokenAddress, t.ts] })]);

export const chainState = pgTable("chain_state", {
  chain: text("chain").primaryKey(),
  lastBlock: bigint("last_block", { mode: "number" }).notNull(),
  updatedAt: timestamptz("updated_at").notNull().defaultNow(),
});

export const adaptationLog = pgTable("adaptation_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  ts: timestamptz("ts").notNull().defaultNow(),
  rule: text("rule").notNull(),
  oldValue: text("old_value").notNull(),
  newValue: text("new_value").notNull(),
  evidenceJson: jsonb("evidence_json"),
});

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamptz("updated_at").notNull().defaultNow(),
});

// Single-row operational heartbeat written by the runner (~every 10s) and read by apps/api's
// /health and /metrics. jsonb payload (non-money telemetry) so the shape can evolve without a
// migration; a stale row is itself the "runner is down" signal.
export const runnerHealth = pgTable("runner_health", {
  id: text("id").primaryKey().default("runner"),
  ts: timestamptz("ts").notNull(),
  payload: jsonb("payload").notNull(),
});

// Per-active Polygon wallet polling telemetry for the Polymarket watcher. Unlike runner_health,
// this survives restarts and lets the watcher resume a second-granular cursor without replaying.
export const polymarketPollState = pgTable("polymarket_poll_state", {
  walletId: uuid("wallet_id").primaryKey().references(() => wallets.id),
  lastPolledAt: timestamptz("last_polled_at"),
  lastSuccessAt: timestamptz("last_success_at"),
  lastErrorAt: timestamptz("last_error_at"),
  lastError: text("last_error"),
  cursorTimestamp: bigint("cursor_timestamp", { mode: "number" }),
  cursorKeys: jsonb("cursor_keys").$type<string[]>(),
  fetchedCount: integer("fetched_count").notNull().default(0),
  recordedCount: integer("recorded_count").notNull().default(0),
  duplicateCount: integer("duplicate_count").notNull().default(0),
  pageCount: integer("page_count").notNull().default(0),
  durationMs: integer("duration_ms"),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  updatedAt: timestamptz("updated_at").notNull().defaultNow(),
}, (t) => [index("polymarket_poll_state_updated_at_idx").on(t.updatedAt)]);

// A wallet nominated by a discovery source (the Nominator) and run through the source-agnostic
// evaluation stage. Every evaluation — promoted or rejected — upserts a row here for provenance and
// audit. A rejection within the cooldown window suppresses re-evaluation; a promotion links the
// leader it created via promotedWalletId. Polygon (Polymarket) only for v1; see ADR 0005.
export const prospects = pgTable("prospects", {
  address: text("address").primaryKey(), // lowercase proxyWallet
  source: text("source").notNull(), // "leaderboard" (the Nominator)
  userName: text("user_name"),
  xUsername: text("x_username"),
  // latest evaluation snapshot (provenance / audit)
  pnlUsd: doublePrecision("pnl_usd"),
  volUsd: doublePrecision("vol_usd"),
  pnlPerVol: doublePrecision("pnl_per_vol"),
  tradeCount: integer("trade_count"),
  lastTradeTs: bigint("last_trade_ts", { mode: "number" }),
  score: doublePrecision("score"),
  verdict: text("verdict").notNull(), // "promoted" | "rejected"
  rejectReason: text("reject_reason"),
  firstSeenAt: timestamptz("first_seen_at").notNull().defaultNow(),
  lastEvaluatedAt: timestamptz("last_evaluated_at").notNull().defaultNow(),
  promotedWalletId: uuid("promoted_wallet_id").references(() => wallets.id),
});

// Single-row run-state for the discovery job: when it last ran (for interval gating across restarts),
// the last error (if the cycle threw), and how many leaders it promoted on the last run.
export const prospectDiscoveryState = pgTable("prospect_discovery_state", {
  id: integer("id").primaryKey().default(1), // single row
  lastRunAt: timestamptz("last_run_at"),
  lastError: text("last_error"),
  promotedLastRun: integer("promoted_last_run").notNull().default(0),
});
