import { describe, it, expect, vi } from "vitest";
import { runLiquidityNotch, computePerLeaderMutes, classifyLiquidityTier } from "./adaptation.js";
import type { FillRecord, AdaptationDeps } from "./adaptation.js";

function fill(
  id: string,
  walletId: string,
  liquidityUsd: number | null,
  entryPrice: number,
  currentPrice: number
): FillRecord {
  return {
    id,
    walletId,
    tokenAddress: `0xtoken${id}`,
    side: "buy",
    qty: 100,
    entryPriceUsd: entryPrice,
    currentPriceUsd: currentPrice,
    notionalUsd: entryPrice * 100,
    liquidityUsd,
  };
}

describe("classifyLiquidityTier", () => {
  it("null → longtail", () => expect(classifyLiquidityTier(null)).toBe("longtail"));
  it("$300k → longtail (< $500k)", () => expect(classifyLiquidityTier(300_000)).toBe("longtail"));
  it("$500k → mid (boundary)", () => expect(classifyLiquidityTier(500_000)).toBe("mid"));
  it("$1M → mid", () => expect(classifyLiquidityTier(1_000_000)).toBe("mid"));
  it("$5M → major (boundary)", () => expect(classifyLiquidityTier(5_000_000)).toBe("major"));
  it("$499k → longtail (< $500k)", () => expect(classifyLiquidityTier(499_999)).toBe("longtail"));
  it("$100 → longtail", () => expect(classifyLiquidityTier(100)).toBe("longtail"));
});

describe("runLiquidityNotch", () => {
  it("does nothing when fewer than 10 fills per bucket", async () => {
    const setter = vi.fn();
    await runLiquidityNotch({
      getBuyFills: () => [
        fill("1", "w1", 100_000, 10, 8),
        fill("2", "w1", 500_000, 10, 12),
      ],
      getCurrentMinLiquidityUsd: () => 150_000,
      setMinLiquidityUsd: setter,
      logAdaptation: vi.fn(),
    });
    expect(setter).not.toHaveBeenCalled();
  });

  it("raises notch when below-boundary fills underperform", async () => {
    let captured: number | null = null;
    const capturedLogs: string[] = [];

    const belowFills = Array.from({ length: 12 }, (_, i) =>
      fill(`b${i}`, "w1", 100_000, 10, 8) // losing: -20%
    );
    const aboveFills = Array.from({ length: 12 }, (_, i) =>
      fill(`a${i}`, "w1", 500_000, 10, 13) // winning: +30%
    );

    await runLiquidityNotch({
      getBuyFills: () => [...belowFills, ...aboveFills],
      getCurrentMinLiquidityUsd: () => 150_000,
      setMinLiquidityUsd: async (v) => { captured = v; },
      logAdaptation: async (e) => { capturedLogs.push(e.rule); },
    });

    expect(captured).toBe(300_000);
    expect(capturedLogs).toContain("liquidity-notch-raise");
  });

  it("does not raise above 500k (hard upper bound)", async () => {
    let captured: number | null = null;

    const belowFills = Array.from({ length: 12 }, (_, i) =>
      fill(`b${i}`, "w1", 100_000, 10, 8)
    );
    const aboveFills = Array.from({ length: 12 }, (_, i) =>
      fill(`a${i}`, "w1", 600_000, 10, 14)
    );

    await runLiquidityNotch({
      getBuyFills: () => [...belowFills, ...aboveFills],
      getCurrentMinLiquidityUsd: () => 500_000,
      setMinLiquidityUsd: async (v) => { captured = v; },
      logAdaptation: vi.fn(),
    });

    expect(captured).toBeNull();
  });

  it("lowers notch when below-boundary outperforms by margin", async () => {
    let captured: number | null = null;

    const belowFills = Array.from({ length: 12 }, (_, i) =>
      fill(`b${i}`, "w1", 100_000, 10, 15) // winning: +50%
    );
    const aboveFills = Array.from({ length: 12 }, (_, i) =>
      fill(`a${i}`, "w1", 600_000, 10, 11) // small win: +10%
    );

    await runLiquidityNotch({
      getBuyFills: () => [...belowFills, ...aboveFills],
      getCurrentMinLiquidityUsd: () => 300_000,
      setMinLiquidityUsd: async (v) => { captured = v; },
      logAdaptation: vi.fn(),
    });

    expect(captured).toBe(150_000);
  });
});

describe("computePerLeaderMutes", () => {
  it("no mutes when fewer than 10 fills per tier", () => {
    const fills: FillRecord[] = Array.from({ length: 5 }, (_, i) =>
      fill(String(i), "w1", 100_000, 10, 8) // longtail, losing
    );
    const result = computePerLeaderMutes(fills);
    expect(result.size).toBe(0);
  });

  it("mutes leader for longtail when all 10+ fills lose money", () => {
    const fills: FillRecord[] = Array.from({ length: 12 }, (_, i) =>
      fill(String(i), "w1", 100_000, 10, 8) // longtail, losing: -20%
    );
    const result = computePerLeaderMutes(fills);
    expect(result.get("w1")).toContain("longtail");
  });

  it("no mute when some fills are profitable", () => {
    const losing = Array.from({ length: 9 }, (_, i) =>
      fill(`l${i}`, "w1", 100_000, 10, 8)
    );
    const winning = [fill("w0", "w1", 100_000, 10, 12)];
    const result = computePerLeaderMutes([...losing, ...winning]);
    // 10 fills but not all losing
    expect(result.get("w1")).toBeUndefined();
  });

  it("mutes different tiers independently", () => {
    const longtailFills = Array.from({ length: 10 }, (_, i) =>
      fill(`lt${i}`, "w2", 100_000, 10, 8)
    );
    const majorFills = Array.from({ length: 10 }, (_, i) =>
      fill(`mj${i}`, "w2", 6_000_000, 10, 12) // winning — no mute
    );
    const result = computePerLeaderMutes([...longtailFills, ...majorFills]);
    const tiers = result.get("w2");
    expect(tiers).toContain("longtail");
    expect(tiers).not.toContain("major");
  });

  it("synthetic 30-day scenario: profitable leader not muted, losing leader muted", () => {
    // profitable leader: all longtail fills win
    const profitableFills = Array.from({ length: 15 }, (_, i) =>
      fill(`p${i}`, "profitable", 200_000, 10, 14) // +40%
    );
    // losing leader: all longtail fills lose
    const losingFills = Array.from({ length: 15 }, (_, i) =>
      fill(`l${i}`, "loser", 200_000, 10, 7) // -30%
    );
    const result = computePerLeaderMutes([...profitableFills, ...losingFills]);
    expect(result.get("loser")).toContain("longtail");
    expect(result.get("profitable")).toBeUndefined();
  });
});
