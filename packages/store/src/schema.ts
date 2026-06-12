import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  numeric,
  integer,
  bigint,
  jsonb,
  unique,
  primaryKey,
} from "drizzle-orm/pg-core";

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const wallets = pgTable("wallets", {
  id: uuid("id").primaryKey().defaultRandom(),
  chain: text("chain").notNull(),
  address: text("address").notNull(),
  label: text("label").notNull(),
  active: boolean("active").notNull().default(true),
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
  reviewStatus: text("review_status"),
}, (t) => [unique().on(t.chain, t.txHash, t.tokenIn, t.tokenOut, t.side)]);

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
