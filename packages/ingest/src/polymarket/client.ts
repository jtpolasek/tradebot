import { z } from "zod";
import { backoffMs, sleep } from "../backoff.js";

/**
 * One trade as returned by the Polymarket Data API `/trades` endpoint. Validated at the boundary;
 * fields we don't consume are ignored. `timestamp` is epoch **seconds** (converted to ms on use),
 * `asset` is the ERC-1155 CTF tokenId (a long decimal string, NOT a 0x address), and `price` is the
 * 0–1 outcome-share price. Verified against live docs 2026-06-18.
 */
export const PolymarketTradeSchema = z.object({
  proxyWallet: z.string(),
  side: z.enum(["BUY", "SELL"]),
  asset: z.string().min(1),
  conditionId: z.string(),
  size: z.number(),
  price: z.number(),
  timestamp: z.number(),
  title: z.string(),
  slug: z.string().optional().default(""),
  eventSlug: z.string().optional().default(""),
  outcome: z.string(),
  outcomeIndex: z.number().optional(),
  transactionHash: z.string(),
});

export type PolymarketTrade = z.infer<typeof PolymarketTradeSchema>;

const TradesResponseSchema = z.array(PolymarketTradeSchema);

const RATE_LIMIT_RETRIES = 4;

export interface FetchPolymarketJsonOptions<T> {
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch | undefined;
  retries?: number | undefined;
  /**
   * Invoked on a non-2xx, non-429 response before throwing. Return a value to short-circuit with it
   * (e.g. treat a known 400 as an empty page); return undefined to fall through to the thrown error.
   */
  onError?: ((status: number, bodyText: string) => T | undefined) | undefined;
}

/**
 * Single rate-limit-aware fetch+validate for the Polymarket Data API. Retries 429s with exponential
 * backoff and parses the body through `schema`. `fetchTrades` and `fetchLeaderboard` both delegate here
 * so the 429 policy lives in exactly one place (the two previously diverged — see CODE_REVIEW PD.8).
 */
export async function fetchPolymarketJson<T>(
  baseUrl: string,
  path: string,
  // Input left unconstrained so schemas with `.default()` (output ≠ input shape) still bind T to the
  // parsed output type cleanly.
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  opts: FetchPolymarketJsonOptions<T> = {}
): Promise<T> {
  const doFetch = opts.fetchImpl ?? fetch;
  const retries = opts.retries ?? RATE_LIMIT_RETRIES;
  const url = `${baseUrl.replace(/\/$/, "")}${path}`;

  for (let attempt = 0; ; attempt++) {
    const res = await doFetch(url);
    if (res.status === 429 && attempt < retries) {
      await sleep(backoffMs(attempt, 1_000, 15_000));
      continue;
    }
    if (!res.ok) {
      if (opts.onError) {
        // Guard against a body reader that throws synchronously (e.g. a partial mock with no text()).
        const body = await Promise.resolve().then(() => res.text()).catch(() => "");
        const fallback = opts.onError(res.status, body);
        if (fallback !== undefined) return fallback;
      }
      throw new Error(`Polymarket Data API ${res.status} for ${path}`);
    }
    const json: unknown = await res.json();
    return schema.parse(json);
  }
}

export interface FetchTradesOptions {
  limit?: number;
  offset?: number;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Fetch a user's most recent trades (newest-first). The `user` param accepts either the EOA or the
 * Polymarket proxy address — whatever the user pasted from a profile works. Retries on HTTP 429 with
 * exponential backoff (mirrors the EVM watcher's rate-limit handling).
 */
export async function fetchTrades(
  baseUrl: string,
  user: string,
  opts: FetchTradesOptions = {}
): Promise<PolymarketTrade[]> {
  const limit = opts.limit ?? 100;
  const offset = opts.offset ?? 0;
  const path = `/trades?user=${encodeURIComponent(user)}&limit=${limit}&offset=${offset}`;

  return fetchPolymarketJson(baseUrl, path, TradesResponseSchema, {
    fetchImpl: opts.fetchImpl,
    // The Data API caps pagination at a fixed history depth and rejects deeper offsets with a 400
    // ("max historical activity offset of 3000 exceeded"). That is a hard ceiling, not a transient
    // failure: treat it as "no more history" (empty page) so a very active wallet whose new trades
    // since the last cursor exceed that depth can't wedge the poller in a permanent failure loop.
    onError: (status, body) =>
      status === 400 && body.includes("max historical activity offset") ? [] : undefined,
  });
}
