# Tradebot

Paper-trading copy-trader (ETH + Base). **`PLAN.md` is the single source of truth — read the relevant phase section before starting work on it, and follow its phases in order.** Milestone history lives in `CHANGELOG.md` (not here — keep this file lean).

## Non-negotiable rules (full detail in PLAN.md §0.4)

- Simulated money only. Never build real execution, never handle private keys.
- Never modify anything under `C:\Users\Willie\Documents\GMGN` (the predecessor app — read-only reference; PLAN.md §8 lists what to port from it).
- `pnpm build && pnpm test` must be green before declaring any phase done; commit at every milestone.
- Secrets only via `.env` (already created, gitignored). Never commit or print key values. `.env.example` mirrors it with blank values.
- TypeScript strict, ESM, viem (never ethers/web3.js), zod at boundaries, bigint for raw token amounts, lowercase addresses.
- Tests never touch the real DB or live network — `TEST_DATABASE_URL` only (port 5434, name must end in `_test`).
- If a command fails twice with the same error, stop and report instead of retrying.
- Ask before adding any dependency not listed in PLAN.md §2.

## Multi-model workflow (GLM drafts, Opus reviews)

Two assistants work this repo: **Opus 4.8** (`claude`) and **GLM 5.2** (`ccr code`, via OpenRouter). They share no conversation context — **all handoff happens through git**.

- **GLM 5.2 drafts.** Use it for boilerplate, test scaffolding, repetitive refactors, first-draft features, and large-file/log summaries. It must **not** be the final word on anything touching the non-negotiable rules above (money simulation, key handling, pricing/engine accounting).
- **Opus reviews.** Architecture, ADRs, debugging subtle bugs, security, and the final `/code-review` gate before merge are Opus's job. Opus verifies GLM's work against the non-negotiable rules before it lands on `main`.
- **Handoff = a branch + a clear commit.** Name drafting branches `glm/<short-description>`; review/fix branches `opus/<short-description>`. Never have both models editing the same files simultaneously — split by branch or task.
- **Nothing merges to `main` without `pnpm build && pnpm test` green** (already a non-negotiable) **and** an Opus review pass on the diff.

**Which model to use (rule of thumb):** default to **GLM** for "just do it" work (tests, scaffolding, refactors, first drafts, summaries); switch to **Opus** for "be careful here" work (money/keys/pricing accounting, phase design, subtle bugs, pre-merge review). If unsure which bucket a task is in, that hesitation is the signal — use Opus. Inside an Opus session, Opus should flag cheap grunt work as GLM-suitable; anything GLM produces that touches the non-negotiable rules goes through an Opus `/code-review` pass before it merges.

**Enforcement:** a versioned pre-commit hook (`.githooks/pre-commit`) blocks direct commits to `main`. It is active via `git config core.hooksPath .githooks` — **a fresh clone must run that once** to enable it. Override a one-off with `git commit --no-verify` (use sparingly).

## Status

All planned phases (0–9) complete as of 2026-06-20. Remaining gate: the 72h soak test (PLAN §10). Full milestone history in `CHANGELOG.md`. When you finish a milestone, append it to `CHANGELOG.md` and update this one-line summary — do not grow a changelog here.
