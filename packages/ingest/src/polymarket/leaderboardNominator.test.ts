import { describe, it, expect, vi } from "vitest";
import {
  fetchLeaderboard,
  createLeaderboardNominator,
  LeaderboardRowSchema,
  type LeaderboardRow,
} from "./leaderboardNominator.js";

const BASE = "https://data-api.polymarket.com";

function sampleRow(over: Partial<Record<keyof LeaderboardRow, unknown>> = {}): Record<string, unknown> {
  return {
    rank: "1", // API sends rank as a string
    proxyWallet: "0xAAA1111111111111111111111111111111111111",
    userName: "alice",
    xUsername: "alice_x",
    verifiedBadge: true,
    vol: 100_000,
    pnl: 50_000,
    ...over,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

describe("LeaderboardRowSchema", () => {
  it("coerces the string rank to a number", () => {
    const parsed = LeaderboardRowSchema.parse(sampleRow({ rank: "7" }));
    expect(parsed.rank).toBe(7);
    expect(typeof parsed.rank).toBe("number");
  });

  it("rejects a row missing pnl", () => {
    const bad = sampleRow();
    delete bad["pnl"];
    expect(() => LeaderboardRowSchema.parse(bad)).toThrow();
  });

  it("tolerates missing optional userName/xUsername/verifiedBadge", () => {
    const parsed = LeaderboardRowSchema.parse({
      rank: "3",
      proxyWallet: "0xbbb",
      vol: 1,
      pnl: 2,
    });
    expect(parsed.userName).toBeUndefined();
  });
});

describe("fetchLeaderboard", () => {
  it("builds the URL with timePeriod, orderBy and limit", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([sampleRow()]));
    const rows = await fetchLeaderboard(BASE, {
      timePeriod: "MONTH",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(rows).toHaveLength(1);
    const url = String((fetchImpl.mock.calls[0] as unknown[])[0]);
    expect(url).toContain("/v1/leaderboard?timePeriod=MONTH");
    expect(url).toContain("orderBy=PNL");
    expect(url).toContain("limit=50");
  });

  it("retries on HTTP 429 then succeeds", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(null, 429))
      .mockResolvedValueOnce(jsonResponse([sampleRow()]));
    const rows = await fetchLeaderboard(BASE, {
      timePeriod: "MONTH",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(rows).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  }, 10_000);

  it("throws on a non-429 error status", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(null, 500));
    await expect(
      fetchLeaderboard(BASE, { timePeriod: "MONTH", fetchImpl: fetchImpl as unknown as typeof fetch })
    ).rejects.toThrow(/500/);
  });

  it("parses the API 50-row cap without complaint", async () => {
    const board = Array.from({ length: 50 }, (_, i) =>
      sampleRow({ rank: String(i + 1), proxyWallet: `0x${String(i).padStart(40, "0")}` })
    );
    const fetchImpl = vi.fn(async () => jsonResponse(board));
    const rows = await fetchLeaderboard(BASE, {
      timePeriod: "MONTH",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(rows).toHaveLength(50);
  });
});

describe("createLeaderboardNominator", () => {
  it("lowercases addresses and maps the primary board numbers", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([sampleRow()]));
    const nom = createLeaderboardNominator({
      baseUrl: BASE,
      window: "MONTH",
      corroborateAll: false,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const out = await nom.nominate();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      address: "0xaaa1111111111111111111111111111111111111",
      source: "leaderboard",
      userName: "alice",
      pnlUsd: 50_000,
      volUsd: 100_000,
      corroborated: false,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1); // no ALL board pulled
  });

  it("pulls ALL/PNL when corroborateAll and flags addresses on both boards", async () => {
    const onBoth = "0xaaa1111111111111111111111111111111111111";
    const monthOnly = "0xbbb2222222222222222222222222222222222222";
    const allOnly = "0xccc3333333333333333333333333333333333333";
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("timePeriod=MONTH")) {
        return jsonResponse([
          sampleRow({ proxyWallet: onBoth, pnl: 50_000, vol: 100_000 }),
          sampleRow({ proxyWallet: monthOnly, pnl: 30_000, vol: 90_000 }),
        ]);
      }
      // ALL board
      return jsonResponse([
        sampleRow({ proxyWallet: onBoth.toUpperCase(), pnl: 999_000, vol: 999_000 }),
        sampleRow({ proxyWallet: allOnly, pnl: 80_000, vol: 200_000 }),
      ]);
    });
    const nom = createLeaderboardNominator({
      baseUrl: BASE,
      window: "MONTH",
      corroborateAll: true,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const out = await nom.nominate();
    const byAddr = new Map(out.map((n) => [n.address, n]));

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(out).toHaveLength(3); // union of both boards

    // on both → corroborated, MONTH numbers kept (not the inflated ALL numbers)
    expect(byAddr.get(onBoth)).toMatchObject({ corroborated: true, pnlUsd: 50_000, volUsd: 100_000 });
    // month-only → not corroborated
    expect(byAddr.get(monthOnly)).toMatchObject({ corroborated: false });
    // all-only → joins the union with ALL numbers, not corroborated
    expect(byAddr.get(allOnly)).toMatchObject({ corroborated: false, pnlUsd: 80_000 });
  });

  it("does not pull a second board when window is ALL", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([sampleRow()]));
    const nom = createLeaderboardNominator({
      baseUrl: BASE,
      window: "ALL",
      corroborateAll: true,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await nom.nominate();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
