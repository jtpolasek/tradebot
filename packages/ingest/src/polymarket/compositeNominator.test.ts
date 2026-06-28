import { describe, expect, it, vi } from "vitest";
import type { Nomination, Nominator } from "./nominator.js";
import { createCompositeNominator } from "./compositeNominator.js";

function nominator(rows: Nomination[]): Nominator {
  return { nominate: vi.fn(async () => rows) };
}

function nomination(address: string, source: string, over: Partial<Nomination> = {}): Nomination {
  return {
    address,
    source,
    pnlUsd: 10_000,
    volUsd: 100_000,
    ...over,
  };
}

describe("createCompositeNominator", () => {
  it("runs all nominators and preserves source order", async () => {
    const first = nominator([nomination("0xaaa", "leaderboard")]);
    const second = nominator([nomination("0xbbb", "active-market")]);

    const out = await createCompositeNominator({ nominators: [first, second] }).nominate();

    expect(first.nominate).toHaveBeenCalledTimes(1);
    expect(second.nominate).toHaveBeenCalledTimes(1);
    expect(out.map((row) => row.address)).toEqual(["0xaaa", "0xbbb"]);
  });

  it("dedupes by lowercased address and merges source provenance", async () => {
    const first = nominator([
      nomination("0xAAA", "leaderboard", { userName: "leader", pnlUsd: 50_000, corroborated: false }),
    ]);
    const second = nominator([
      nomination("0xaaa", "counterparty-crawl", { userName: "crawl", pnlUsd: 90_000, corroborated: true }),
    ]);

    const out = await createCompositeNominator({ nominators: [first, second] }).nominate();

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      address: "0xaaa",
      source: "leaderboard,counterparty-crawl",
      userName: "leader",
      pnlUsd: 50_000,
      corroborated: true,
    });
  });

  it("does not duplicate a source already present in a merged source list", async () => {
    const first = nominator([nomination("0xaaa", "leaderboard,counterparty-crawl")]);
    const second = nominator([nomination("0xaaa", "leaderboard")]);

    const out = await createCompositeNominator({ nominators: [first, second] }).nominate();

    expect(out[0]?.source).toBe("leaderboard,counterparty-crawl");
  });
});
