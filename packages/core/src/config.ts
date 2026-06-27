import { z } from "zod";
import { config as loadDotenv } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(__dirname, "../../../.env") });

const envBoolean = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return value;
}, z.boolean());

const schema = z.object({
  DATABASE_URL: z.string().url(),
  TEST_DATABASE_URL: z.string().url().optional(),
  ALCHEMY_API_KEY: z.string().min(1),
  BASE_ALCHEMY_API_KEY: z.string().optional(),
  QUICKNODE_ETH_WS: z.string().optional(),
  QUICKNODE_BASE_WS: z.string().optional(),
  // 0x is retired (the API stopped serving our calls). The env var is intentionally parsed and
  // discarded so an uncommented key in .env can never re-enable the dead 0x fill path at runtime.
  ZEROX_API_KEY: z.string().optional().transform(() => undefined),
  API_KEY: z.string().min(1),
  PAPER_STARTING_CASH_USD: z.coerce.number().positive().default(100_000),
  BASE_TRADE_PCT: z.coerce.number().positive().default(0.01),
  MAX_TRADE_PCT: z.coerce.number().positive().default(0.03),
  MIN_NOTIONAL_USD: z.coerce.number().positive().default(50),
  // Fraction of PAPER_STARTING_CASH_USD kept un-invested as a buffer. The engine opens no new
  // positions once cash would drop below this floor (sells/exits still flow), so a copy run can't
  // grind the book down to zero. 0 disables the buffer (stop only when cash literally can't cover
  // the next trade).
  MIN_CASH_RESERVE_PCT: z.coerce.number().min(0).max(1).default(0.05),
  MIN_LIQUIDITY_USD: z.coerce.number().positive().default(150_000),
  MAX_SIGNAL_AGE_SEC: z.coerce.number().positive().default(180),
  // Polymarket's data-api indexes trades with a multi-minute lag, so a leader's trade is already
  // 4-10 min old by the time we can query it. The EVM 180s gate (we see on-chain swaps in seconds)
  // would reject every Polymarket signal, so Polygon gets its own, looser staleness budget.
  POLYMARKET_MAX_SIGNAL_AGE_SEC: z.coerce.number().positive().default(900),
  COPY_DELAY_PENALTY_BPS_ETH: z.coerce.number().nonnegative().default(10),
  COPY_DELAY_PENALTY_BPS_BASE: z.coerce.number().nonnegative().default(5),
  GAS_USD_ETH: z.coerce.number().nonnegative().default(4),
  GAS_USD_BASE: z.coerce.number().nonnegative().default(0.03),
  SIZING_MODE: z.enum(["fixed", "proportional"]).default("fixed"),
  ALLOW_FALLBACK_PRICE_BUYS: envBoolean.default(false),
  MAX_SPOT_TWAP_DIVERGENCE_BPS: z.coerce.number().nonnegative().default(300),
  MAX_CHAINLINK_STALENESS_SEC: z.coerce.number().positive().default(3600),
  HEARTBEAT_INTERVAL_MS: z.coerce.number().positive().default(10_000),
  HEARTBEAT_STALE_SEC: z.coerce.number().positive().default(30),
  CHAIN_STALE_SEC_ETH: z.coerce.number().positive().default(60),
  CHAIN_STALE_SEC_BASE: z.coerce.number().positive().default(30),
  // Liveness watchdog: force a WS reconnect if no block arrives within this window (a silently
  // dead "zombie" subscription fires no error). Generous vs block cadence to avoid thrashing.
  WS_STALL_SEC_ETH: z.coerce.number().positive().default(150),
  WS_STALL_SEC_BASE: z.coerce.number().positive().default(90),
  // Polymarket poller freshness threshold. Generous vs the 20s poll so a brief gap between ticks
  // isn't flagged; a genuinely stalled poller still surfaces in /health.
  CHAIN_STALE_SEC_POLYGON: z.coerce.number().positive().default(120),
  POLYMARKET_POLL_MS: z.coerce.number().positive().default(20_000),
  POLYMARKET_DATA_API_URL: z.string().url().default("https://data-api.polymarket.com"),
  POLYMARKET_CLOB_API_URL: z.string().url().default("https://clob.polymarket.com"),
  POLYMARKET_GAMMA_API_URL: z.string().url().default("https://gamma-api.polymarket.com"),
  POLYMARKET_MAX_SPREAD_BPS: z.coerce.number().nonnegative().default(500),
  // Marks/resolution job cadence (ms). Both loop serially over every open Polygon position against
  // public Polymarket endpoints, so raise these under a large open-position count to avoid 429s.
  POLYMARKET_MARKS_INTERVAL_MS: z.coerce.number().positive().default(60_000),
  POLYMARKET_RESOLUTION_INTERVAL_MS: z.coerce.number().positive().default(60_000),
  // Prospect auto-discovery (ADR 0005, docs/prospect-discovery-plan.md). Finds good Polymarket
  // wallets from the public leaderboard and promotes them to leaders observe-first (watched,
  // auto-copy OFF). Off by default: the job is wired but inert until a human opts in.
  PROSPECT_DISCOVERY_ENABLED: envBoolean.default(false),
  // Leaderboard moves slowly (PnL over a window), so discovery runs ~daily. The job persists its
  // last-run time and only fires when this interval has elapsed, so restarts neither thrash nor stall.
  PROSPECT_DISCOVERY_INTERVAL_MS: z.coerce.number().positive().default(86_400_000),
  // Which leaderboard window drives discovery. MONTH = recent form (still-active edge), which is what
  // forward copy-trading needs; ALL is whale-/survivor-biased and used only to corroborate.
  PROSPECT_LEADERBOARD_WINDOW: z.enum(["DAY", "WEEK", "MONTH", "ALL"]).default("MONTH"),
  // Also pull the ALL/PNL board and boost wallets that rank well in both windows (more credibly
  // skilled than a single hot month).
  PROSPECT_CORROBORATE_ALL: envBoolean.default(true),
  // Stage-1 absolute PnL floor (USD) — ignore micro-accounts. Barely bites the MONTH/PNL board
  // (probe: rank 50 ≈ $543k), but guards lower boards and future nominators.
  PROSPECT_MIN_PNL_USD: z.coerce.number().nonnegative().default(10_000),
  // Stage-1 efficiency gate: pnl/vol (profit per dollar transacted). Whale-neutral and filters most
  // market-makers for free (they churn huge vol for thin pnl). Probe: PNL leaders 0.39-0.68, VOL
  // market-makers 0.013 and negative — 0.03 cleanly separates them. Open tuning item.
  PROSPECT_MIN_PNL_PER_VOL: z.coerce.number().nonnegative().default(0.03),
  // Stage-2 anti-luck sample size: minimum trades visible via /trades.
  PROSPECT_MIN_TRADES: z.coerce.number().positive().default(20),
  // Stage-2 recency gate (days): reject wallets whose newest trade is older than this. Probe: the #1
  // wallet last traded 11 days ago, so a 7-day window would wrongly reject it.
  PROSPECT_RECENCY_DAYS: z.coerce.number().positive().default(14),
  // Hard cap on auto-promoted leaders — each watched polygon wallet adds Data API poll load
  // (POLYMARKET_POLL_MS), so growth must be bounded.
  PROSPECT_MAX_LEADERS: z.coerce.number().positive().default(25),
  // Promote at most this many per cycle (gradual fill, not a flood).
  PROSPECT_MAX_PROMOTIONS_PER_CYCLE: z.coerce.number().positive().default(3),
  // Don't re-run Stage-2 pulls on a recently-rejected wallet for this many days.
  PROSPECT_REJECT_COOLDOWN_DAYS: z.coerce.number().positive().default(7),
  RSS_SOFT_LIMIT_MB: z.coerce.number().positive().default(1536),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
});

function parseConfig() {
  const result = schema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Config validation failed:\n${issues}`);
  }
  return result.data;
}

export const config = parseConfig();
export type Config = typeof config;
