import { z } from "zod";
import { fetchPolymarketJson } from "./client.js";
import type { Nomination, Nominator } from "./nominator.js";

/**
 * One row of the Polymarket Data API `/v1/leaderboard` response. Probe-confirmed 2026-06-27: the board
 * returns at most 50 rows regardless of `limit`, `rank` is a **string**, and there is no ROI or trade
 * count. Fields we don't consume are ignored. (ADR 0005, prospect-discovery-plan.md §"Probe-confirmed".)
 */
export const LeaderboardRowSchema = z.object({
  rank: z.coerce.number(), // API sends a string; coerce to number
  proxyWallet: z.string(),
  userName: z.string().optional(),
  xUsername: z.string().optional(),
  verifiedBadge: z.boolean().optional(),
  vol: z.number(),
  pnl: z.number(),
});

export type LeaderboardRow = z.infer<typeof LeaderboardRowSchema>;

const LeaderboardResponseSchema = z.array(LeaderboardRowSchema);

export type LeaderboardWindow = "DAY" | "WEEK" | "MONTH" | "ALL";

export interface FetchLeaderboardOptions {
  timePeriod: LeaderboardWindow;
  orderBy?: "PNL" | "VOL" | undefined;
  limit?: number | undefined;
  fetchImpl?: typeof fetch | undefined;
}

/**
 * Fetch a leaderboard page. Shares the Data API's 429 backoff/parse policy with `fetchTrades` via
 * `fetchPolymarketJson`. The `limit` is passed through but the API caps the board at 50 rows regardless.
 */
export async function fetchLeaderboard(
  baseUrl: string,
  opts: FetchLeaderboardOptions
): Promise<LeaderboardRow[]> {
  const orderBy = opts.orderBy ?? "PNL";
  const limit = opts.limit ?? 50;
  const path = `/v1/leaderboard?timePeriod=${opts.timePeriod}&orderBy=${orderBy}&limit=${limit}`;
  return fetchPolymarketJson(baseUrl, path, LeaderboardResponseSchema, { fetchImpl: opts.fetchImpl });
}

export interface LeaderboardNominatorOptions {
  baseUrl: string;
  /** primary window pulled for the snapshot numbers, e.g. "MONTH" */
  window: LeaderboardWindow;
  /** also pull ALL/PNL and flag addresses that appear on both as corroborated */
  corroborateAll: boolean;
  fetchImpl?: typeof fetch | undefined;
}

const SOURCE = "leaderboard";

/**
 * The leaderboard Nominator: pulls the configured window's PNL board (and optionally the ALL/PNL board
 * for corroboration), unions by lowercased address keeping the primary window's numbers, and flags any
 * address that also appeared in ALL/PNL. Never judges quality — that is the evaluation stage's job.
 */
export function createLeaderboardNominator(opts: LeaderboardNominatorOptions): Nominator {
  return {
    async nominate(): Promise<Nomination[]> {
      const primary = await fetchLeaderboard(opts.baseUrl, {
        timePeriod: opts.window,
        orderBy: "PNL",
        limit: 50,
        fetchImpl: opts.fetchImpl,
      });

      const primaryAddrs = new Set(primary.map((r) => r.proxyWallet.toLowerCase()));
      let all: LeaderboardRow[] = [];
      if (opts.corroborateAll && opts.window !== "ALL") {
        all = await fetchLeaderboard(opts.baseUrl, {
          timePeriod: "ALL",
          orderBy: "PNL",
          limit: 50,
          fetchImpl: opts.fetchImpl,
        });
      }
      const allAddrs = new Set(all.map((r) => r.proxyWallet.toLowerCase()));

      const byAddress = new Map<string, Nomination>();
      const add = (row: LeaderboardRow) => {
        const address = row.proxyWallet.toLowerCase();
        // First row wins; the primary window is added first so its numbers are the ones kept.
        if (byAddress.has(address)) return;
        byAddress.set(address, {
          address,
          source: SOURCE,
          userName: row.userName,
          xUsername: row.xUsername,
          pnlUsd: row.pnl,
          volUsd: row.vol,
          // corroborated = present on *both* boards
          corroborated: primaryAddrs.has(address) && allAddrs.has(address),
        });
      };
      // Primary window first (its numbers win on overlap), then ALL-only addresses join the union.
      for (const row of primary) add(row);
      for (const row of all) add(row);

      return [...byAddress.values()];
    },
  };
}
