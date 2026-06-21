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
  const doFetch = opts.fetchImpl ?? fetch;
  const url = `${baseUrl.replace(/\/$/, "")}/trades?user=${encodeURIComponent(user)}&limit=${limit}&offset=${offset}`;

  for (let attempt = 0; ; attempt++) {
    const res = await doFetch(url);
    if (res.status === 429 && attempt < RATE_LIMIT_RETRIES) {
      await sleep(backoffMs(attempt, 1_000, 15_000));
      continue;
    }
    if (!res.ok) {
      // The Data API caps pagination at a fixed history depth and rejects deeper offsets with a 400
      // ("max historical activity offset of 3000 exceeded"). That is a hard ceiling, not a transient
      // failure: treat it as "no more history" (empty page) so a very active wallet whose new trades
      // since the last cursor exceed that depth can't wedge the poller in a permanent failure loop.
      if (res.status === 400) {
        const body = await res.text().catch(() => "");
        if (body.includes("max historical activity offset")) return [];
      }
      throw new Error(`Polymarket Data API ${res.status} for user ${user}`);
    }
    const json: unknown = await res.json();
    return TradesResponseSchema.parse(json);
  }
}
