import { describe, it, expect } from "vitest";
import { sigmoid, computeZScore, computeScore, scoreToWeight, shouldAutoMute } from "./weights.js";

describe("sigmoid", () => {
  it("sigmoid(0) = 0.5", () => {
    expect(sigmoid(0)).toBeCloseTo(0.5);
  });

  it("sigmoid(1) ≈ 0.7311", () => {
    expect(sigmoid(1)).toBeCloseTo(0.73106, 4);
  });

  it("sigmoid(-1) ≈ 0.2689", () => {
    expect(sigmoid(-1)).toBeCloseTo(0.26894, 4);
  });
});

describe("computeZScore", () => {
  it("cohort size 1 → z = 0", () => {
    expect(computeZScore(100, [100])).toBe(0);
  });

  it("all same values → z = 0", () => {
    expect(computeZScore(5, [5, 5, 5])).toBe(0);
  });

  it("hand-computed: cohort [100, 200, 300, 400]", () => {
    // mean=250, variance=12500, std≈111.803
    // z(100) = (100-250)/111.803 ≈ -1.3416
    // z(250) = 0
    // z(400) = (400-250)/111.803 ≈ 1.3416
    const cohort = [100, 200, 300, 400];
    expect(computeZScore(100, cohort)).toBeCloseTo(-1.3416, 3);
    expect(computeZScore(250, cohort)).toBeCloseTo(0, 3);
    expect(computeZScore(400, cohort)).toBeCloseTo(1.3416, 3);
  });
});

describe("computeScore", () => {
  it("all zeros → score 0", () => {
    expect(computeScore(0, 0, 0, 0)).toBe(0);
  });

  it("hand-computed: pnlZ=1, winRateZ=0.5, avgRetZ=0.8, drawdownZ=-0.2", () => {
    // 0.35*1 + 0.25*0.5 + 0.25*0.8 - 0.15*(-0.2)
    // = 0.35 + 0.125 + 0.2 + 0.03 = 0.705
    expect(computeScore(1, 0.5, 0.8, -0.2)).toBeCloseTo(0.705, 5);
  });

  it("high drawdown penalises score", () => {
    const withDD = computeScore(1, 1, 1, 2);    // -0.15*2 = -0.3 penalty
    const noDD = computeScore(1, 1, 1, 0);
    expect(withDD).toBeLessThan(noDD);
  });
});

describe("scoreToWeight", () => {
  it("score 0 → weight 1.0", () => {
    expect(scoreToWeight(0)).toBeCloseTo(1.0);
  });

  it("score 1 → weight ≈ 1.462", () => {
    // 2 * sigmoid(1) = 2 * 0.73106 = 1.46212
    expect(scoreToWeight(1)).toBeCloseTo(1.4621, 3);
  });

  it("score -1 → weight ≈ 0.538", () => {
    expect(scoreToWeight(-1)).toBeCloseTo(0.5379, 3);
  });

  it("very high score → clamped to 2", () => {
    expect(scoreToWeight(100)).toBeCloseTo(2, 5);
  });

  it("very low score → clamped to 0", () => {
    expect(scoreToWeight(-100)).toBeCloseTo(0, 5);
  });
});

describe("shouldAutoMute", () => {
  it("score null → false", () => {
    expect(shouldAutoMute(null)).toBe(false);
  });

  it("score -1.5 → true (< -1)", () => {
    expect(shouldAutoMute(-1.5)).toBe(true);
  });

  it("score -1.0 → false (not strictly less)", () => {
    expect(shouldAutoMute(-1.0)).toBe(false);
  });

  it("score -0.5 → false", () => {
    expect(shouldAutoMute(-0.5)).toBe(false);
  });

  it("score 0 → false", () => {
    expect(shouldAutoMute(0)).toBe(false);
  });
});
