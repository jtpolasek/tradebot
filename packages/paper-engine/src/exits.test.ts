import { describe, it, expect } from "vitest";
import { checkExitTrigger, calcExitQuantity } from "./exits.js";

describe("checkExitTrigger", () => {
  it("returns tp when pnlPct meets takeProfitPct exactly", () => {
    expect(checkExitTrigger({
      currentPriceUsd: 1.5,
      averageEntryUsd: 1.0,
      takeProfitPct: 50,
      stopLossPct: null,
    })).toBe("tp");
  });

  it("returns tp when pnlPct exceeds takeProfitPct", () => {
    expect(checkExitTrigger({
      currentPriceUsd: 2.0,
      averageEntryUsd: 1.0,
      takeProfitPct: 50,
      stopLossPct: null,
    })).toBe("tp");
  });

  it("returns null when pnlPct is just below takeProfitPct", () => {
    expect(checkExitTrigger({
      currentPriceUsd: 1.499,
      averageEntryUsd: 1.0,
      takeProfitPct: 50,
      stopLossPct: null,
    })).toBeNull();
  });

  it("returns sl when pnlPct meets stopLossPct exactly", () => {
    expect(checkExitTrigger({
      currentPriceUsd: 4.0,
      averageEntryUsd: 5.0,
      takeProfitPct: null,
      stopLossPct: 20,
    })).toBe("sl");
  });

  it("returns sl when pnlPct exceeds stopLossPct", () => {
    expect(checkExitTrigger({
      currentPriceUsd: 0.5,
      averageEntryUsd: 1.0,
      takeProfitPct: null,
      stopLossPct: 20,
    })).toBe("sl");
  });

  it("returns null when pnlPct is just above stopLossPct threshold", () => {
    expect(checkExitTrigger({
      currentPriceUsd: 0.801,
      averageEntryUsd: 1.0,
      takeProfitPct: null,
      stopLossPct: 20,
    })).toBeNull();
  });

  it("returns null when both thresholds are null", () => {
    expect(checkExitTrigger({
      currentPriceUsd: 999,
      averageEntryUsd: 1.0,
      takeProfitPct: null,
      stopLossPct: null,
    })).toBeNull();
  });

  it("prefers tp over sl when both fire simultaneously", () => {
    expect(checkExitTrigger({
      currentPriceUsd: 1.5,
      averageEntryUsd: 1.0,
      takeProfitPct: 50,
      stopLossPct: 20,
    })).toBe("tp");
  });
});

describe("calcExitQuantity", () => {
  it("returns full quantity for 100%", () => {
    expect(calcExitQuantity(1000, 100)).toBe(1000);
  });

  it("returns half quantity for 50%", () => {
    expect(calcExitQuantity(1000, 50)).toBe(500);
  });

  it("handles fractional tokens", () => {
    expect(calcExitQuantity(333.333, 50)).toBeCloseTo(166.6665, 4);
  });
});
