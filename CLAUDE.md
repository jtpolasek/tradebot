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
- Hybrid GMGN plan (2026-06-12): 6-part feature plan agreed — full plan in memory file `hybrid-gmgn-plan.md`, terminology in `CONTEXT.md`, key decision in `docs/adr/0001-persist-candidates-outside-scoring.md`. **Part 1 (candidate persistence) in progress**: add `decode_status`/`confidence`/`reason` to `trade_signals`, stop dropping ambiguous decodes, engine acts on `decoded` only, scorer counts `decoded` only.
