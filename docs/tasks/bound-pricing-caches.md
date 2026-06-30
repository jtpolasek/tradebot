# Task: bound the in-memory pricing caches

**Lane:** GLM draft → Opus review (mechanical, no non-negotiable rules touched).
**Source:** PLAN.md Phase 9 item 8, deferred follow-up (b) — "bound the TTL-only pricing caches (`llamaCache`/`poolCache`) — low risk, TTL-bounded."
**Branch:** `glm/bound-pricing-caches` (do NOT commit to `main` — a pre-commit hook blocks it).

## Problem

`packages/pricing/src/price.ts` holds module-level `Map` caches that are **TTL-checked on read but never size-bounded**. Stale entries for tokens that are never priced again are never evicted, so over a long-running process (the 72h soak, PLAN §10) the Maps grow unbounded with every distinct token seen — a slow memory leak.

The unbounded caches (grow per distinct token):
- `llamaCache` — key `` `${chain}:${address}` ``, 30s TTL (`LLAMA_TTL_MS`)
- `marketCache` — key `` `${chain}:${token}` ``, 5min TTL (`MARKET_TTL_MS`) — this is the plan's "poolCache" (renamed)

**Also bound the two Polymarket caches in `packages/pricing/src/polymarket.ts`** — same TTL-on-read,
never-evicted leak, and they grow per distinct *market* (Polymarket markets churn continuously, and
prospect discovery keeps adding Polygon leaders):
- `quoteCache` — key per market, TTL-checked on read at `polymarket.ts:174`, written but never evicted
- `marketStatusCache` — key per market, read at `polymarket.ts:343`/`371`, same pattern

Route both through the same `cacheSet` helper. Their `clearCaches()`-equivalent reset
(`polymarket.ts:389-390`) and size getters (`413`/`418`) must keep working unchanged.

**Leave `chainlinkCache` alone** — it is keyed by `EvmChainId`, so it holds at most 2 entries. Not a leak.

## Requirement

Add a **maximum entry count** to `llamaCache` and `marketCache` with simple LRU-ish eviction: when inserting into a full cache, evict the oldest entry first. A `Map` preserves insertion order, so the first key is the oldest — `map.delete(map.keys().next().value)` evicts it. (Optional nicety: on a cache *hit*, `delete`+`set` to move the key to the most-recent position so it survives eviction — true LRU. Keep it if it's clean, skip if it complicates.)

Suggested shape — a tiny local helper, no new dependency:

```ts
const MAX_CACHE_ENTRIES = 5_000; // generous; ~tokens seen per TTL window

function cacheSet<K, V>(map: Map<K, V>, key: K, value: V): void {
  if (map.size >= MAX_CACHE_ENTRIES && !map.has(key)) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}
```

Then replace the two `llamaCache.set(...)` / `marketCache.set(...)` call sites with `cacheSet(llamaCache, ...)` / `cacheSet(marketCache, ...)`. Do not change TTL behavior, keys, or values.

## Constraints (non-negotiable for this task)

- **Do not** touch pricing math, TTLs, cache keys, or the `clearCaches()` export (tests depend on it — it must still clear all three Maps).
- **Do not** add a dependency (no `lru-cache` etc.) — PLAN §2 governs deps and this doesn't warrant one.
- TypeScript strict, ESM, match surrounding style. No comments on obvious lines.
- One focused commit: `test:`/`feat:`/`chore:` as fits. Imperative message.

## Acceptance

- [ ] `llamaCache`, `marketCache`, `quoteCache`, and `marketStatusCache` writes go through the size-bounded helper; `chainlinkCache` untouched.
- [ ] A new unit test in `packages/pricing/src/price.test.ts` proves the bound: insert > `MAX_CACHE_ENTRIES` distinct keys (temporarily lower the cap or insert via the real price path with mocked fetches) and assert the Map size never exceeds the cap and the oldest key was evicted. Use the existing `clearCaches()` in `beforeEach`.
- [ ] `pnpm build` (10 pkgs) and `pnpm test` (17 tasks) green.
- [ ] Updated entry in CLAUDE.md "Status" and `status.md` noting the follow-up is closed.

## Out of scope

- The other deferred item (a) — live full-pipeline V4 re-check. That needs a real post-deploy trade; not codeable here.
- Any change to `marks.ts`, the engine, or the store.

## Handoff back to Opus

Push `glm/bound-pricing-caches`, then it gets an Opus `/code-review` pass before merge to `main`.
