# Tradebot

Paper-trading copy-trader (ETH + Base). **`PLAN.md` is the single source of truth — read it in full before doing anything, and follow its phases in order.** Track the current phase in this file's "Status" section below as you complete work.

## Non-negotiable rules (full detail in PLAN.md §0.4)

- Simulated money only. Never build real execution, never handle private keys.
- Never modify anything under `C:\Users\Willie\Documents\GMGN` (the predecessor app — read-only reference; PLAN.md §8 lists what to port from it).
- `pnpm build && pnpm test` must be green before declaring any phase done; commit at every milestone.
- Secrets only via `.env` (already created, gitignored). Never commit or print key values. `.env.example` mirrors it with blank values.
- TypeScript strict, ESM, viem (never ethers/web3.js), zod at boundaries, bigint for raw token amounts, lowercase addresses.
- Tests never touch the real DB or live network — `TEST_DATABASE_URL` only (port 5434, name must end in `_test`).
- If a command fails twice with the same error, stop and report instead of retrying.
- Ask before adding any dependency not listed in PLAN.md §2.

## Status

- Phase 0: **complete** (2026-06-10). 20 tests passing, committed 2f760ed.
- Phase 1: **complete** (2026-06-10). Committed 0024d63.
- Phase 2: **complete** (2026-06-10). 79 tests passing, committed 2302607.
- Phase 3: **complete** (2026-06-10). 91 tests passing, committed d23ad0c.
- Phase 4: **complete** (2026-06-10). 149 tests passing, committed f71c06a.
- Phase 5: **complete** (2026-06-11). 193 non-Docker tests passing, committed 747a828.
- Phase 6: **complete** (2026-06-11). 195 tests passing, committed 8a8d50d.
- Code review round 2: **complete** (2026-06-12). All findings 4.1–4.10 fixed on `fix/code-review-2026-06-11`. `pnpm build && pnpm test` green.
- Hybrid GMGN plan (2026-06-12): 6-part feature plan agreed — full plan in memory file `hybrid-gmgn-plan.md`, terminology in `CONTEXT.md`, key decision in `docs/adr/0001-persist-candidates-outside-scoring.md`. **Part 1 (candidate persistence) complete**: capped reconnect backfill window, added engine staleness veto via block timestamp (skip reason `stale-signal`), added `decode_status`/`confidence`/`reason` to `trade_signals`, persist candidate decodes instead of dropping them, prevent the engine from auto-copying candidates, and make scorer count decoded signals only. Validation: `pnpm build` and `pnpm test` green on 2026-06-12.
- Hybrid GMGN plan Part 2: **complete** (2026-06-12). Added candidate review queue: `review_status` workflow on `trade_signals`, API endpoints to list/copy/dismiss candidates, runner job that executes copy requests through the paper engine at current decision time, and `/candidates` dashboard page. Validation: `pnpm build` and `pnpm test` green.
- Candidate review hardening: **complete** (2026-06-12). Added store tests for candidate listing/status transitions and paper-engine test proving manual candidate copy uses the normal fill path while leaving the persisted signal as `decode_status='candidate'`. Validation: `pnpm build` and `pnpm test` green.
- Wallet validation hotfix: **complete** (2026-06-12). Root cause was an active malformed wallet row (`address='vein'`) being accepted through settings and then handed to ingest. Deactivated row `4fe658ca-7a2c-4c98-ad84-5bff03402e2a`, added API/store/UI validation and a legacy active-row guard. Re-check found no active malformed wallet rows. Validation: `pnpm build` and `pnpm test` green.
- Token display links: **complete** (2026-06-12). Signals, fills, candidates, and open positions now hydrate token symbol/name from `tokens` where available and the web UI links contract addresses to Etherscan or BaseScan. Validation: `pnpm build` and `pnpm test` green.
- Alchemy Free-tier getLogs hotfix: **complete** (2026-06-12). ETH reconnect backfill now uses 10-block `eth_getLogs` chunks to satisfy Alchemy Free-tier limits; Base already used 10-block chunks. Validation: `pnpm --filter @tradebot/ingest test` and `pnpm build` green.
- Parts 1–2 + hotfixes merged to `main` locally (2026-06-15, ff from `feat/candidate-persistence`).
- Hybrid GMGN plan now lives in `PLAN.md` as **Phase 8** (committed 2026-06-15); statuses tracked there.
- Hybrid GMGN plan Part 5 (reprocess tool): **complete** (2026-06-15) on `feat/reprocess-tool`. Added pure `summarizeReprocess` + types in `packages/decoder`, and `scripts/reprocess.ts` (`pnpm reprocess [path…]`, defaults to `./recordings`) that re-derives signals from recordings via the live decoder and diffs against persisted `trade_signals`. Read-only over trading state. Unit tests for the diff; CLI smoke-tested. Validation: `pnpm build` and `pnpm test` green.
- Hybrid GMGN plan Part 4 (portfolio analytics): **complete** (2026-06-15) on `feat/portfolio-analytics`. Added pure `derivePortfolioAnalytics` + `getPortfolioAnalytics` store query, `GET /analytics`, a ported MetricStrip, and a PnL-by-token table on `/portfolio`. Metrics: win rate, realized PnL, fee drag, avg hold, open exposure, skip rate, fees paid, copied count. Unit + DB-integration tests. Validation: `pnpm build` and `pnpm test` green.
- Hybrid GMGN plan Part 3 (wallet toggles): **complete** (2026-06-15) on `feat/wallet-toggles`. Added `auto_copy` column to `wallets` (default true, migration 0005); surfaced `active` as a "Watching"/"Stop watching" toggle with a greyed "Not watching" list (re-enablable); added a per-wallet **Auto-copy** toggle. Engine caches auto-copy-off wallet IDs (refreshed on the 60s settings timer) and vetoes their **buys** with skip reason `auto-copy-off` — sells still flow through to exit positions, and manual candidate copies bypass it via `reviewStatus='copying'`. New `PATCH /wallets/:id` accepts `{ active?, autoCopy? }`. Validation: `pnpm build` and `pnpm test` green.
