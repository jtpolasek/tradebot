import { describe, expect, it } from "vitest";
import { baselineWeightForTradeCount } from "./scorer.js";

describe("baselineWeightForTradeCount", () => {
  it("uses 0.5 weight while the leader has fewer than five trades", () => {
    expect(baselineWeightForTradeCount(0)).toBe(0.5);
    expect(baselineWeightForTradeCount(4)).toBe(0.5);
  });

  it("uses neutral 1.0 weight once the leader reaches five trades", () => {
    expect(baselineWeightForTradeCount(5)).toBe(1.0);
    expect(baselineWeightForTradeCount(20)).toBe(1.0);
  });
});
