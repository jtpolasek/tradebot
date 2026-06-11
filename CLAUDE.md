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
