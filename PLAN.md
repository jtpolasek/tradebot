# Tradebot — Crypto Copy-Trading Platform (Paper Trading) — IMPLEMENTATION PLAN

**This document is the single source of truth.** Follow it exactly. Work through phases **in order**. Do not skip ahead, do not invent features not listed here, and do not "improve" the architecture. When this document and your own judgment conflict, this document wins. When something is genuinely ambiguous or broken in a way this document does not anticipate, STOP and ask the user instead of guessing.

---

## 0. Context you must understand before writing any code

### 0.1 What this project is

A paper-trading (simulated money, NO real transactions, NO private keys) copy-trading platform:

1. **Watch** a configurable set of wallets ("leaders") on **Ethereum mainnet and Base** via WebSocket.
2. **Detect** their DEX swaps in real time (mempool when possible, confirmed blocks always).
3. **Mirror** each swap into a simulated portfolio with realistic fill modeling (slippage, gas, latency).
4. **Score leaders and adapt**: per-leader position sizing, trade filters, and exit rules improve from accumulated data.

**Non-goals — never build these:** real order execution, private key handling, MEV, CEX trading, front-running.

### 0.2 The predecessor app (IMPORTANT)

A previous version of this product exists at **`C:\Users\Willie\Documents\GMGN`**. It is a Next.js 16 monolith with SQLite. It works, it is well-tested, but it polls for wallet activity every 60 seconds instead of streaming, and it has no leader-scoring brain. **You are building its replacement in this repo**, and you must **PORT specific proven modules from it instead of rewriting them**. Section 8 lists exactly which files to port and how. The old app stays untouched and runnable — **never modify anything inside `C:\Users\Willie\Documents\GMGN`**. You may read from it freely.

### 0.3 Environment facts (verified on this machine)

- **OS:** Windows 11. Shell is **PowerShell** (use `$env:VAR`, `Remove-Item`, etc.). Git Bash also exists.
- **Node:** v25.4.0 installed. Target **Node >= 22, ESM only** (`"type": "module"` everywhere).
- **pnpm:** NOT installed. Install it first via Corepack: `corepack enable; corepack prepare pnpm@latest --activate`. If corepack is unavailable, `npm install -g pnpm`. Verify with `pnpm --version` before proceeding.
- **Docker:** installed (v29). Used ONLY for Postgres. If `docker compose up -d` fails because Docker Desktop is not running, tell the user to start Docker Desktop — do not try to install Postgres another way.
- **API keys:** the old app's `C:\Users\Willie\Documents\GMGN\.env.local` contains working keys (`ALCHEMY_API_KEY`, `BASE_ALCHEMY_API_KEY`, `ZEROX_API_KEY`, `UNISWAP_API_KEY`, `ETHERSCAN_API_KEY`). Copy the values you need into this repo's `.env` (gitignored). **Never commit any key. Never print a key's value in output.**

### 0.4 Hard rules for the implementer

1. **Run `pnpm build && pnpm test` and get green before declaring any phase done.** A phase is not done because the code "looks right."
2. **TypeScript strict mode, no `any`** unless interfacing with untyped JSON (then validate with zod immediately).
3. **bigint discipline:** raw token amounts stay `bigint` from decode to storage. Convert to `number` only for USD values. NEVER `parseFloat`/`Number()` a raw token amount.
4. **Addresses are lowercase everywhere** (storage, maps, comparisons). Checksum only for display.
5. **Money in the DB is `numeric` (Postgres), never `float`.** Raw token amounts stored as `numeric` or text.
6. **Secrets only via `.env`** (gitignored, with a complete `.env.example` committed). Config is loaded once through a zod-validated module; nothing else reads `process.env`.
7. **Do not add dependencies not listed in this plan** without asking. Specifically banned: ethers v5/v6, web3.js, lodash, axios (use native `fetch`), moment (use `Date`/`Intl`).
8. **If a command fails twice with the same error, stop and report** the error and your diagnosis. Do not loop.
9. **Commit at every milestone** with imperative messages (`feat: …`, `fix: …`, `test: …`). Initialize git in Phase 0. Never commit `.env`, `recordings/`, or `node_modules`.
10. **Do not block the event loop** in bus handlers: the decode path is pure/sync; DB writes go through `p-queue` (concurrency 4).
11. Tests must NEVER touch a real database file or live network. Unit tests use fixtures; integration tests use the dockerized test DB (Section 10). The old app once had a test suite wipe its production SQLite file — do not repeat that class of mistake.

---

## 1. Architecture

```
                        ┌──────────────────────────────────────────────┐
                        │              packages/ingest                  │
  Alchemy/QuickNode ──▶ │  EVM WS subscriptions (pending tx + logs)     │
  WS endpoints          │  per-chain ChainWatcher (eth, base)           │
                        └──────────────┬───────────────────────────────┘
                                       │ RawTxEvent (in-proc event bus)
                        ┌──────────────▼───────────────────────────────┐
                        │            packages/decoder                   │
                        │  Swap detection: router ABIs + balance-delta  │
                        │  Emits normalized TradeSignal                 │
                        └──────────────┬───────────────────────────────┘
                                       │ TradeSignal
                 ┌─────────────────────┼─────────────────────┐
                 ▼                     ▼                     ▼
   ┌──────────────────────┐ ┌────────────────────┐ ┌──────────────────┐
   │ packages/paper-engine│ │ packages/pricing   │ │ packages/store   │
   │ mirror decision →    │ │ pool spot price,   │ │ Postgres writes  │
   │ simulated fill →     │ │ token metadata,    │ │ (signals, fills, │
   │ portfolio ledger     │ │ liquidity depth    │ │  positions, pnl) │
   └──────────┬───────────┘ └────────────────────┘ └──────────────────┘
              │ hourly / weekly jobs
   ┌──────────▼───────────┐          ┌──────────────────────────────┐
   │ packages/brain       │          │ apps/api  (Fastify REST+WS)  │
   │ leader scoring,      │          │ apps/web  (Next.js dashboard)│
   │ sizing weights,      │          └──────────────────────────────┘
   │ trade filters        │
   └──────────────────────┘
```

- **One Node process** (`apps/runner`) hosts the hot path: ingest → decode → paper fill. No Redis, no microservices, no message broker. The event bus is an in-process typed `EventEmitter`.
- Postgres is the durability layer. `apps/api` and `apps/web` read from Postgres, not from the runner.
- **Latency budget:** signal observed on WS → paper fill recorded < 150 ms.

## 2. Tech stack (exact — do not substitute)

| Concern | Choice | Notes |
|---|---|---|
| Language | TypeScript, Node 22+ target, ESM, `strict: true`, `moduleResolution: NodeNext` | |
| Monorepo | pnpm workspaces + turborepo | |
| EVM lib | **viem** (latest 2.x) | typed ABI decoding + native WS. NOT ethers, NOT web3.js |
| RPC | Alchemy WS (primary). QuickNode (fallback) only if the user provides QuickNode URLs; otherwise implement the failover slot but leave it unconfigured | |
| DB | PostgreSQL 16 (docker-compose) + **Drizzle ORM** + `drizzle-kit` migrations | |
| Hot state | in-process `Map`s | NO Redis |
| API | Fastify 5 + zod | |
| Dashboard | Next.js 15+ App Router + Tailwind (Phase 6 — port from old app) | |
| Tests | Vitest | |
| Validation | zod at every boundary (env, API routes, external JSON) | |
| Logging | pino (pretty in dev via `pino-pretty`) | |
| Misc deps allowed | `p-queue`, `uuid` (or `crypto.randomUUID`), `dotenv` | |

## 3. Repository layout

```
tradebot/
  package.json            # workspace root, "private": true
  pnpm-workspace.yaml
  turbo.json
  tsconfig.base.json
  .env.example            # EVERY env var documented; never commit .env
  .gitignore              # .env, .env.*, node_modules, dist, recordings/, *.tsbuildinfo
  docker-compose.yml      # postgres:16 only (+ a "test" profile postgres on another port)
  PLAN.md                 # this file
  packages/
    core/                 # shared types, config loader, event bus, logger
    store/                # drizzle schema + migrations + repositories
    ingest/               # chain watchers (evm)
    decoder/              # swap detection & normalization
    pricing/              # token metadata, USD pricing, liquidity reads
    paper-engine/         # mirroring rules, fill simulation, ledger
    brain/                # scoring, weights, filters
  apps/
    runner/               # long-running daemon wiring everything together
    api/                  # fastify REST + WS
    web/                  # next.js dashboard (Phase 6)
```

Every package: `src/`, `package.json` with `"type": "module"`, its own `tsconfig.json` extending `tsconfig.base.json`, tests colocated as `*.test.ts`. Packages import each other via workspace protocol (`"@tradebot/core": "workspace:*"`).

## 4. Core domain types (`packages/core/src/types.ts`)

Implement **exactly** these. Every package speaks them. Do not add fields without asking.

```ts
export type ChainId = "eth" | "base"; // "sol" reserved for a later phase — do NOT build Solana

export interface TrackedWallet {
  id: string;            // uuid
  chain: ChainId;
  address: string;       // lowercase 0x…
  label: string;
  active: boolean;
  addedAt: Date;
}

/** Raw observation from a chain watcher. */
export interface RawTxEvent {
  chain: ChainId;
  source: "mempool" | "confirmed";
  txHash: string;
  from: string;                 // lowercase
  to: string | null;            // lowercase
  blockNumber: number | null;   // null when mempool
  observedAt: number;           // Date.now() captured at WS receipt
  input?: `0x${string}`;        // mempool: calldata
  logs?: { address: string; topics: string[]; data: string }[]; // confirmed: receipt logs
  status?: "success" | "reverted"; // confirmed only, from receipt
  nonce?: number;               // needed for replacement detection
  valueWei?: bigint;            // native ETH sent with the tx
}

/** Normalized, decoded trade by a leader wallet. */
export interface TradeSignal {
  id: string;                   // uuid
  chain: ChainId;
  walletId: string;
  txHash: string;
  source: "mempool" | "confirmed";
  side: "buy" | "sell";         // relative to the non-quote token
  tokenIn: TokenRef;            // what the leader spent
  tokenOut: TokenRef;           // what the leader received
  amountIn: bigint;             // raw units
  amountOut: bigint;            // raw (estimated if mempool)
  venue: string;                // "uniswap-v2" | "uniswap-v3" | "uniswap-v4" | "aerodrome" | "unknown-router" | "balance-delta"
  observedAt: number;
  confirmedAt: number | null;
  blockNumber: number | null;
}

export interface TokenRef {
  chain: ChainId;
  address: string;   // lowercase; use the chain's WETH address for native ETH legs
  symbol: string;
  decimals: number;
}

export interface PaperFill {
  id: string;
  signalId: string;
  decidedAt: number;
  decision: "copied" | "skipped";
  skipReason?: string;          // "below-min-liquidity" | "leader-weight-zero" | "token-blocklist" | "insufficient-balance" | "dust" | "no-position" | "leader-tx-reverted" | ...
  side: "buy" | "sell";
  token: TokenRef;              // the non-quote asset
  quoteToken: TokenRef;
  qty: number;                  // human units of token
  priceUsd: number;             // simulated fill price
  notionalUsd: number;
  feeUsd: number;               // gas + dex fee model
  slippageBps: number;
  latencyMs: number;            // signal.observedAt -> fill timestamp
  provisional: boolean;         // true when sourced from a mempool signal, until confirmed
}
```

**Event bus** (`packages/core/src/bus.ts`): a small class wrapping Node `EventEmitter` with typed channels:

```ts
type BusEvents = {
  "raw-tx": RawTxEvent;
  "trade-signal": TradeSignal;
  "signal-confirmed": { signalId: string; confirmed: TradeSignal }; // mempool signal later confirmed
  "signal-voided": { signalId: string; reason: "reverted" | "replaced" };
  "paper-fill": PaperFill;
};
```

Synchronous emit, in-process only. Handlers must never `await` inside the emit path — they enqueue work internally.

## 5. Database schema (`packages/store`)

Drizzle tables, Postgres. `numeric` for all money/amount columns. Timestamps `timestamptz`, always UTC.

```sql
wallets(id uuid pk, chain text, address text, label text, active bool, added_at timestamptz,
        unique(chain, address))

tokens(chain text, address text, symbol text, name text, decimals int,
       first_seen timestamptz, is_blocked bool default false,
       pk(chain, address))

trade_signals(id uuid pk, chain text, wallet_id uuid fk, tx_hash text, source text,
              side text, token_in text, token_out text, amount_in numeric, amount_out numeric,
              venue text, observed_at timestamptz, confirmed_at timestamptz, block_number bigint,
              unique(chain, tx_hash, token_in, token_out))   -- dedupes mempool+confirmed

paper_fills(id uuid pk, signal_id uuid fk, decided_at timestamptz, decision text, skip_reason text,
            side text, token_address text, quote_address text, qty numeric, price_usd numeric,
            notional_usd numeric, fee_usd numeric, slippage_bps int, latency_ms int,
            provisional bool default false, voided bool default false)

positions(id uuid pk, chain text, token_address text, qty numeric, avg_cost_usd numeric,
          opened_at timestamptz, closed_at timestamptz null, realized_pnl_usd numeric default 0,
          source_wallet_id uuid)

portfolio_snapshots(id uuid pk, ts timestamptz, equity_usd numeric, cash_usd numeric,
                    positions_value_usd numeric, daily_pnl_usd numeric)

leader_stats(wallet_id uuid, window text,  -- '7d' | '30d' | 'all'
             trades int, win_rate numeric, avg_return_pct numeric, median_hold_minutes numeric,
             realized_pnl_usd numeric, max_drawdown_pct numeric, score numeric, weight numeric,
             updated_at timestamptz, pk(wallet_id, window))

price_marks(chain text, token_address text, ts timestamptz, price_usd numeric, source text,
            pk(chain, token_address, ts))

chain_state(chain text pk, last_block bigint, updated_at timestamptz)  -- for backfill after WS gaps

adaptation_log(id uuid pk, ts timestamptz, rule text, old_value text, new_value text, evidence_json jsonb)
```

Repositories expose narrow typed functions (`insertSignal`, `upsertPosition`, `latestMark`, `getLastBlock`, …). **No raw SQL and no Drizzle calls outside `packages/store`.**

## 6. Configuration (`.env.example` — create with ALL of these, documented)

```
DATABASE_URL=postgres://tradebot:tradebot@localhost:5433/tradebot
TEST_DATABASE_URL=postgres://tradebot:tradebot@localhost:5434/tradebot_test
ALCHEMY_API_KEY=                 # copy value from old app's .env.local
BASE_ALCHEMY_API_KEY=            # separate Alchemy key for Base; falls back to ALCHEMY_API_KEY if blank
QUICKNODE_ETH_WS=                # optional fallback; leave blank if none
QUICKNODE_BASE_WS=               # optional fallback; leave blank if none
ZEROX_API_KEY=                   # copy from old app; used by ported quote client (pricing fallback)
API_KEY=                         # any random string; auths apps/api requests
PAPER_STARTING_CASH_USD=100000
BASE_TRADE_PCT=0.01
MAX_TRADE_PCT=0.03
MIN_NOTIONAL_USD=50
MIN_LIQUIDITY_USD=150000
COPY_DELAY_PENALTY_BPS_ETH=10
COPY_DELAY_PENALTY_BPS_BASE=5
GAS_USD_ETH=4
GAS_USD_BASE=0.03
SIZING_MODE=fixed                # fixed | proportional
LOG_LEVEL=info
```

Config module (`packages/core/src/config.ts`): zod schema, parse once at boot, fail fast with a readable message listing every missing/invalid var. Ports 5433/5434 are deliberate (5432 may be in use).

---

## 7. Phase plan

Statuses for the user: announce start/finish of each phase. After each phase: `pnpm build && pnpm test` green, then `git commit`.

### Phase 0 — Scaffold (target: half a day)

1. `git init`, `.gitignore`, pnpm workspace root, `pnpm-workspace.yaml` (`packages/*`, `apps/*`), turbo with `build`/`test`/`dev` pipelines, `tsconfig.base.json` (strict, NodeNext, ES2022 target, declaration on).
2. `docker-compose.yml`: service `db` = `postgres:16-alpine` on host port **5433**, user/pass/db all `tradebot`, named volume; service `db-test` = same image on **5434**, db `tradebot_test`, `profiles: ["test"]`.
3. `packages/core`: types (Section 4), config loader, pino logger factory, event bus + unit test (emit/receive typing).
4. `packages/store`: full Drizzle schema (Section 5), `drizzle.config.ts`, migration generated via `drizzle-kit generate`, script `pnpm db:migrate` (runs migrations with `drizzle-kit migrate` or a small migrate.ts), plus repository stubs for wallets and chain_state with tests against the test DB.
5. `apps/runner`: boots, loads config, connects to DB (simple `select 1`), logs "ready", clean shutdown on SIGINT.
6. Root scripts: `pnpm build`, `pnpm test`, `pnpm dev` (turbo), `pnpm db:migrate`, `pnpm db:up` (`docker compose up -d db`).

**Accept:** fresh clone → `pnpm i && pnpm db:up && pnpm db:migrate && pnpm build && pnpm test` all green; runner starts and logs ready.

### Phase 1 — EVM ingestion (target: 2 days)

`packages/ingest/src/evm/chainWatcher.ts` — class, one instance per chain, built on viem `createPublicClient({ transport: webSocket(url) })`. Alchemy WS URLs: `wss://eth-mainnet.g.alchemy.com/v2/<KEY>` and `wss://base-mainnet.g.alchemy.com/v2/<KEY>`.

Three subscriptions per chain:

1. **Confirmed logs (reliable backbone):** subscribe to ERC-20 `Transfer(address,address,uint256)` logs with topic filters for tracked wallets — one subscription with `from ∈ wallets`, one with `to ∈ wallets` (topic positions 1 and 2; addresses must be padded to 32 bytes in topics). On a hit, fetch `getTransactionReceipt(txHash)` (dedupe so one tx → one fetch), build `RawTxEvent{source:"confirmed"}` with all receipt logs + `status`. Resubscribe when the tracked set changes.
2. **Pending transactions (latency win, Alchemy only, expect it to work on eth and yield ~nothing on base):** raw WS JSON-RPC `eth_subscribe` with `["alchemy_pendingTransactions", { fromAddress: [tracked…], hashesOnly: false }]` over a plain `WebSocket` (viem doesn't expose this custom subscription — use the `ws` npm package or viem's `getRpcClient`). Emits `RawTxEvent{source:"mempool"}` with calldata + nonce.
3. **New heads:** `watchBlockNumber` → update `chain_state.last_block`, heartbeat log every block on base / every 5 blocks on eth.

Resilience (all required):
- Auto-reconnect with exponential backoff 1s → 30s cap; resubscribe everything on reconnect.
- Gap backfill: on reconnect, `getLogs` (Transfer topic + wallet filters) from `chain_state.last_block + 1` to current head, in chunks of ≤ 500 blocks; emit as confirmed events.
- Dedupe: LRU set of `${source}:${txHash}` (size 50k). A tx seen in mempool then confirmed emits twice **on purpose** (decoder handles it); exact duplicates within a source emit once.
- Provider failover skeleton: if QuickNode URLs configured and Alchemy WS down > 60s, switch confirmed-logs to QuickNode while retrying Alchemy. If not configured, just keep retrying Alchemy.

Also in this phase: **the recorder.** Every `RawTxEvent` is appended as JSONL to `recordings/<chain>-<date>.jsonl` (gitignored). `bigint` fields serialized as strings with a `"__bigint"` marker or via a custom replacer — round-trippable.

**Accept:** with 2–3 known-active wallets in the DB (ask the user for addresses, or use well-known active wallets for a smoke test), runner logs `RawTxEvent`s within ~1 block of their on-chain activity on both chains. Unit tests for: backoff timing, LRU dedupe, topic padding, JSONL round-trip. Reconnect test: kill/restart the WS connection programmatically and assert backfill fires.

### Phase 2 — Swap decoding + replay harness (target: 3 days)

`packages/decoder`. Input `RawTxEvent`, output zero or more `TradeSignal`s. Strategies in order:

**Strategy A — known venue logs (confirmed txs):** decode receipt logs by event signature:
- Uniswap V2 `Swap(address,uint256,uint256,uint256,uint256,address)` — also matches Sushi and Aerodrome vAMM.
- Uniswap V3 `Swap(address,address,int256,int256,uint160,uint128,int24)` — also matches Aerodrome CL (slipstream).
- Uniswap V4 `Swap` on the PoolManager singleton (eth + base).
Keep a `venues.ts` registry `{ chain, name, eventAbi, verify }`. Verify the emitting contract is a real pool via factory `getPool`/`getPair` call, cached forever per address (in-memory Map + `tokens`-style DB cache is fine). If verification RPC fails, fall through to Strategy B rather than erroring.

**Strategy B — balance-delta (universal fallback, REQUIRED — this is the workhorse).** For any confirmed tx from a tracked wallet: net all ERC-20 `Transfer` amounts where the wallet is `from` (spent) or `to` (received), plus native ETH (tx `valueWei` and WETH `Deposit`/`Withdrawal` logs). Exactly one token net-negative and one net-positive → swap, `venue:"balance-delta"`. More than 2 tokens moved → pick the largest in/out pair by USD value, log a warning. **PORT the pairing/side logic from the old app** — see Section 8, `candidates.ts`.

**Strategy C — mempool calldata (eth only, best-effort):** decode Uniswap UniversalRouter `execute`, V2/V3 router `swapExact*` families. Use `amountOutMin`/`amountInMax` from calldata as the conservative estimate. Unrecognized calldata → emit nothing (confirmed path will catch it). Do not chase exotic routers.

**Dedup/normalize:** decoder keeps `Map<"chain:txHash", TradeSignal>`. Confirmed event for an existing mempool signal → emit `signal-confirmed` (not a new signal), update amounts from logs. Confirmed receipt with `status:"reverted"` → emit `signal-voided{reason:"reverted"}`. A different txHash confirming with the same `from`+`nonce` as a pending mempool signal → `signal-voided{reason:"replaced"}`.

**Side classification:** quote assets per chain — eth: USDC, USDT, DAI, WETH; base: USDC, WETH, cbBTC (hardcode addresses in `packages/core/src/chains.ts` along with WETH addresses and chain ids). tokenOut is quote → `sell`; tokenIn is quote → `buy`; both quotes → ignore (stable rotation, not copyable); neither → emit two signals (sell of tokenIn + buy of tokenOut).

**Token metadata:** first sight of an address → read `symbol`/`name`/`decimals` on-chain via multicall, persist to `tokens`. Handle bytes32 symbols (decode, trim nulls) and missing decimals (default 18, log warning).

**Replay harness (REQUIRED this phase):** `apps/runner --replay <file.jsonl> [--speed N]` reads recorded events and pushes them through the bus at original or accelerated timing. This is how you test everything downstream without waiting for live trades.

**Accept:** fixture tests — download 6 real tx receipts via Alchemy RPC (`eth_getTransactionReceipt` over HTTPS) and save as JSON in `packages/decoder/test/fixtures/`: a Uniswap V2 swap, a V3 swap, a V4 swap, a 1inch aggregation, an Aerodrome (base) swap, a multi-hop UniversalRouter trade. Each fixture decodes to the hand-verified `TradeSignal` (cross-check token amounts against Etherscan/Basescan UI). Plus unit tests for side classification, two-signal emission, dedupe, void-on-revert.

### Phase 3 — Pricing (target: 1.5 days)

`packages/pricing`:

- `getUsdPrice(token): Promise<number | null>` routing: stablecoins (the quote lists above) → 1.0; WETH → Chainlink ETH/USD aggregator (`latestRoundData`; eth feed `0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419`, base feed `0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70`); other tokens → deepest Uniswap V3 (or Aerodrome on base) pool vs a quote asset, `slot0` sqrtPriceX96 → price (mind decimals on both sides), multiplied by the quote's USD price; final fallback → DefiLlama `https://coins.llama.fi/prices/current/{chain}:{address}` (chain slugs: `ethereum`, `base`) with a 30s in-memory cache.
- `getLiquidityUsd(token): Promise<number | null>`: USD value of the quote-side reserves of the deepest pool (approximation is fine: quote reserve × quote USD price × 2). Cache 5 min.
- **Marks job:** every 60s persist a `price_marks` row for every token with an open position. Started by the runner.
- **PORT the 0x and Uniswap quote clients from the old app** (Section 8) as an additional price source `getQuotePrice(token, notionalUsd)` used by the paper engine when available — real quotes beat the linear model.

**Accept:** unit tests with mocked RPC for the sqrtPriceX96 math (hand-computed expected values, both token-order cases); live smoke test prints WETH ≈ market price, USDC = 1.0, and two random meme-token prices within ~2% of DexScreener; marks rows appear every minute while runner is live.

### Phase 4 — Paper trading engine (target: 3 days)

`packages/paper-engine`. One portfolio: cash USD + positions map. Loaded from DB at boot, held in memory, **every mutation written through to DB in the same tick** (via the p-queue).

**Mirror decision** `decide(signal): {action:"copy", notionalUsd} | {action:"skip", reason}`:
1. Leader weight from brain (Phase 5; until then constant 1.0 via a stub interface — define `WeightProvider` now). Weight 0 → skip `leader-weight-zero`.
2. Token blocked in `tokens.is_blocked` → skip `token-blocklist`.
3. `getLiquidityUsd(token) < MIN_LIQUIDITY_USD` → skip `below-min-liquidity` (null liquidity → skip too, reason `no-liquidity-data`).
4. Sizing: `notional = equity * BASE_TRADE_PCT * leaderWeight`, clamped to `[MIN_NOTIONAL_USD, equity * MAX_TRADE_PCT]`. Buy with insufficient cash → clamp to cash; cash < MIN_NOTIONAL → skip `insufficient-balance`. `SIZING_MODE=proportional`: scale by the leader's trade notional relative to their median recent trade notional (clamped 0.25×–4×) — implement both modes, default fixed.
5. Sells: only if we hold a position in that token opened from this leader's signals. Sell the same **fraction** the leader sold of their estimated holding (cumulative net from their signals); unknown holding → sell 100%. No position → skip `no-position`. Never short.

**Fill simulation** `fill(signal, notionalUsd): PaperFill`:
- Base price: `getQuotePrice` (ported 0x client) if available, else `getUsdPrice`.
- `slippageBps = dexFeeBps(venue) + impactBps + delayPenaltyBps(chain)` where `impactBps = 10_000 * notional / (2 * liquidityUsd)` (cap impactBps at 500, log if hit), dexFeeBps: v2/aerodrome 30, v3 30 (or pool fee tier if known), unknown 30.
- Buys fill at `price * (1 + slippageBps/10_000)`, sells at `price * (1 - slippageBps/10_000)`.
- `feeUsd = GAS_USD_<CHAIN> + dex fee component of the notional`.
- Mempool-sourced fill → `provisional: true`. On `signal-confirmed`: recompute price, adjust the fill (update row). On `signal-voided`: void the fill, restore cash/position exactly, record reason.

**Ledger:** avg-cost positions, realized PnL on sells, `portfolio_snapshots` every 5 min + after every fill. **PORT the accounting/ledger modules from the old app** (Section 8) — `applyTradeToState` and `verifyLedger` are proven; adapt their types, keep their test expectations.

**Exit rules (ported, config-gated):** port `checkExitTrigger`/`calcExitQuantity` from the old app's `exitWorker.ts`; runner job every 60s checks open positions against latest marks, executes paper sells when TP/SL hit. Default disabled via settings.

**Accept:** integration test feeding 20 scripted signals (buys, sells incl. fractional, a revert-void, an unknown token, an insufficient-cash clamp) through bus → engine → store; assert final cash, positions, realized PnL to the cent against hand-computed values in the test file. Then a live (or replay) run of ≥ 24 h: equity curve renders from snapshots, no crash, never negative cash. Run `verifyLedger` against the DB at the end — zero mismatches.

### Phase 5 — Brain: scoring & adaptation (target: 3 days)

`packages/brain`. Deterministic and explainable. Hourly job + on-demand.

**Leader scoring** per wallet per window (7d/30d/all): reconstruct the leader's own round trips from their `trade_signals` (FIFO match buys→sells per token; open remainder marked at latest `price_marks`). Compute `trades, win_rate, avg_return_pct, median_hold_minutes, realized_pnl_usd, max_drawdown_pct` (drawdown over the cumulative-PnL series of their closed trades). Score: `0.35*z(pnl) + 0.25*z(win_rate) + 0.25*z(avg_return) − 0.15*z(drawdown)` with z-scores across the tracked cohort (cohort size 1 → z = 0). `trades < 5` in window → score null, weight default 0.5.

**Weight mapping:** `weight = clamp(2 * sigmoid(score), 0, 2)`; 7d score < −1 → weight 0 (auto-mute, log event + `adaptation_log` row). Persist to `leader_stats`; paper-engine's `WeightProvider` reads from memory, refreshed after each scoring run.

**Adaptive filters (weekly job, every change writes `adaptation_log`, hard bounds enforced):**
- Liquidity notch: if fills on tokens with liquidity < $300k underperform fills above by a margin (compare avg realized+marked return; require ≥ 10 fills per bucket), raise `MIN_LIQUIDITY_USD` one notch 150k→300k→500k; symmetric loosening, never below 150k or above 500k.
- Per-leader category filter: bucket tokens by liquidity tier (majors ≥ $5M / mid / long-tail < $500k); if a leader's copied fills lose money in a tier over ≥ 10 fills, mute that leader for that tier.
- Runtime-adjustable settings live in a `settings` table (key/value jsonb) read at boot and after each adaptation — env vars are the defaults, settings table is the override.

**Accept:** unit tests for FIFO reconstruction (incl. partial sells and open remainder), z-score/weight math with hand-computed values, auto-mute trigger, and the liquidity-notch rule with synthetic fills. Seeded synthetic 30-day dataset → profitable leader weight > 1.2, losing leader → 0.

### Phase 6 — API + dashboard (target: 3 days; may start after Phase 4)

`apps/api` (Fastify): `GET/POST/DELETE /wallets`, `GET /signals?since=`, `GET /fills?since=`, `GET /portfolio` (equity/cash/positions with latest marks), `GET /leaders`, `GET /adaptations`, `GET/PATCH /settings`. zod on every route; auth = `X-Api-Key` header equals `API_KEY` env. WS endpoint `/stream` pushing `trade-signal` and `paper-fill` (api process polls Postgres every 2s for new rows — it does NOT share the runner's bus).

`apps/web` (Next.js + Tailwind): pages — Portfolio (equity curve, open positions), Leaders (score/weight table + history), Live Feed, Settings (wallet CRUD, config + adaptation log). **Port/adapt the old app's dashboard UI** (`src/app/page.tsx`, `src/components/`, `src/app/globals.css` on its `ui-redesign` branch) — restyle data fetching to hit `apps/api`; do not rebuild the design from scratch. Charts: `lightweight-charts`.

**Accept:** add wallet via UI → its signals appear in the feed within a block of leader activity; portfolio page matches DB snapshots.

### Phase 7+ (DO NOT BUILD): Solana adapter, ML. Out of scope until the user explicitly asks.

---

## 8. Porting guide — proven modules from the old app

Source root: `C:\Users\Willie\Documents\GMGN\src\lib\`. For each: copy the file **and its colocated `*.test.ts`**, adapt imports/types to `@tradebot/*`, keep the test's expected values unchanged (they encode hand-verified math). Note the old app uses `number` for amounts in places — when adapting to bigint raw amounts, convert at the boundary, and keep USD math in `number` as the old code does.

| Old file | Destination | What it gives you | Adaptation notes |
|---|---|---|---|
| `money.ts` (+test) | `packages/core/src/money.ts` | `toBaseUnits`, `fromBaseUnits`, `normalizeAddress`, USD formatters | Nearly drop-in. Phase 0. |
| `accounting.ts` (+test) | `packages/paper-engine/src/accounting.ts` | `applyTradeToState` (avg-cost position math, realized PnL), `applyTotalLossToState` | Core of Phase 4 ledger. Map its trade input shape to `PaperFill`. |
| `ledger.ts` (+test) | `packages/paper-engine/src/ledger.ts` | `ledgerDeltaFromTrade`, `derivePortfolioTotals`, `derivePositions`, `verifyLedger` | Use `verifyLedger` in Phase 4 acceptance + a `pnpm verify:ledger` script. |
| `candidates.ts` (+test) | `packages/decoder/src/balanceDelta.ts` | transfer-grouping + in/out pairing + side heuristics — this IS Strategy B | Rework input from Alchemy transfer rows to receipt `Transfer` logs; keep `analyzePairs` logic and tests. |
| `copy.ts` (+test) | `packages/paper-engine/src/sizing.ts` | `sizeCopyTrade`, `calculateCashCappedBuyUsd`, `estimateSourceNotionalUsd`, error classification | Merge with Phase 4 decision rules; plan's sizing formula wins where they conflict, keep the cash-capping behavior. |
| `fees.ts` (+test) | `packages/pricing/src/fees.ts` | `valueUnpricedFees` (0x fee valuation) | Used with the ported 0x client. |
| `zerox.ts` (+test) | `packages/pricing/src/zerox.ts` | 0x price/quote client with sanity checks (`assertUsableZeroxQuote`) | Keep; it's the best fill-price source. Needs `ZEROX_API_KEY`. |
| `uniswap.ts` (+test) | `packages/pricing/src/uniswapQuote.ts` | Uniswap quote fallback | Optional; port if `zerox.ts` references it (it does). |
| `exitWorker.ts` (+test) | `packages/paper-engine/src/exits.ts` | `checkExitTrigger`, `calcExitQuantity` | Pure functions port as-is; rewrite the worker loop against new repos. |
| `constants.ts` | `packages/core/src/chains.ts` | chain ids, well-known token addresses | Merge with quote-asset lists from Phase 2. |

Do NOT port: `db.ts`/`repositories.ts` (SQLite → replaced by Drizzle store), `external.ts`'s Alchemy *polling* (replaced by WS ingest — but its token-metadata resolution logic is a useful reference), `copyWorker.ts` loop (replaced by bus-driven engine), any React code before Phase 6.

## 9. Known pitfalls (read before each phase)

1. **Base mempool is private** — the pending-tx stream yields little/nothing on base. Code must be fine with that; confirmed-logs is the source of truth on both chains.
2. **Always check `receipt.status`** — reverted leader txs must void provisional fills.
3. **Mempool replacement:** same `from`+nonce confirming under a different hash → void the provisional fill.
4. **Fee-on-transfer/rebasing tokens:** never compute received amounts from calldata; balance-delta from logs is the truth.
5. **bigint discipline** (Section 0.4 rule 3). Also: JSON.stringify throws on bigint — every serialization point needs the replacer.
6. **Topic filtering:** addresses in log topics are 32-byte left-padded; build topics with viem's `pad`, compare lowercase.
7. **One tx, many Swap logs** (aggregator split routes): when Strategy A finds multiple conflicting Swap logs in one receipt, prefer Strategy B's net result.
8. **Subscription limits:** > ~100 tracked wallets per chain → chunk topic filters into groups of 50 per subscription.
9. **Time:** store UTC; latency math uses `Date.now()` captured at WS receipt, never block timestamps.
10. **Windows:** paths with backslashes in scripts — use `path.join`/`pathToFileURL`; npm lifecycle scripts run in cmd by default, keep them cross-platform (no `&&`-chained `cd`, no `rm -rf` — use `rimraf`-free node scripts or `node --eval`).
11. **ESM:** all imports of local files need explicit `.js` extensions in emitted output (`moduleResolution: NodeNext` enforces this in source as `.js`). Vitest handles TS directly.
12. **Drizzle numeric columns return strings** — parse at the repository boundary, return `number` (USD) or `bigint` (raw amounts) from repos.

## 10. Testing & verification

- **Unit:** every formula in this plan has a test with hand-computed expected values (slippage, impact, z-scores, FIFO, sqrtPriceX96).
- **Fixtures:** decoder tests run on recorded real receipts committed to the repo. No network in unit tests.
- **Integration:** scripted `RawTxEvent`s through the real bus + real (dockerized test) Postgres on port 5434 (`docker compose --profile test up -d db-test`). Vitest setup truncates test-DB tables between runs. Tests must refuse to run against `DATABASE_URL` — they use `TEST_DATABASE_URL` only, and assert the DB name ends in `_test` before truncating anything.
- **Replay:** after Phase 2, every behavior change should be sanity-checked with `--replay` on accumulated recordings.
- **Soak:** before calling the system done, 72 h live run — zero unhandled rejections, reconnects recover, flat memory.
- `pnpm test` green before any phase is declared complete. No skipped tests left behind.

## 11. Build order summary

| Phase | Deliverable | Est. |
|---|---|---|
| 0 | Scaffold + DB + config + ported `money.ts` | 0.5 d |
| 1 | ETH+Base watchers, resilient WS, backfill, recorder | 2 d |
| 2 | Decoder (A/B/C) + ported balance-delta + replay harness | 3 d |
| 3 | Pricing + marks + ported 0x/Uniswap quote clients | 1.5 d |
| 4 | Paper engine + ported accounting/ledger/exits | 3 d |
| 5 | Brain: scoring, weights, adaptive filters | 3 d |
| 6 | API + dashboard (port old UI) | 3 d |

Porting cuts the original 13-day estimate to roughly 9–10 days. The old app keeps running in parallel as the reference until the new system passes its soak test.
