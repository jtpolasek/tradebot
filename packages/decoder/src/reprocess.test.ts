import { describe, it, expect } from "vitest";
import { summarizeReprocess, type ReprocessSignal } from "./reprocess.js";

const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const TOKEN = "0xaaaa000000000000000000000000000000000001";

function sig(overrides: Partial<ReprocessSignal> & { txHash: string }): ReprocessSignal {
  return {
    chain: "eth",
    walletId: "w1",
    decodeStatus: "decoded",
    side: "buy",
    tokenInAddress: USDC,
    tokenOutAddress: TOKEN,
    reason: null,
    ...overrides,
  };
}

describe("summarizeReprocess", () => {
  it("reports no changes when stored and derived match", () => {
    const both = [sig({ txHash: "0x1" })];
    const report = summarizeReprocess(both, [sig({ txHash: "0x1" })]);
    expect(report.summary.changed).toBe(0);
    expect(report.changes).toEqual([]);
  });

  it("detects a status upgrade (candidate -> decoded)", () => {
    const stored = [sig({ txHash: "0x1", decodeStatus: "candidate" })];
    const derived = [sig({ txHash: "0x1", decodeStatus: "decoded" })];
    const report = summarizeReprocess(stored, derived);
    expect(report.summary.statusChanges).toBe(1);
    expect(report.changes[0]?.kinds).toContain("status");
    expect(report.changes[0]?.storedStatus).toBe("candidate");
    expect(report.changes[0]?.derivedStatus).toBe("decoded");
  });

  it("detects a side flip", () => {
    const stored = [sig({ txHash: "0x1", side: "buy" })];
    const derived = [sig({ txHash: "0x1", side: "sell", tokenInAddress: TOKEN, tokenOutAddress: USDC })];
    const report = summarizeReprocess(stored, derived);
    expect(report.summary.sideChanges).toBe(1);
    expect(report.changes[0]?.kinds).toContain("side");
  });

  it("counts newly-derived and missing-derived signals", () => {
    const stored = [sig({ txHash: "0x1" }), sig({ txHash: "0x2" })];
    const derived = [sig({ txHash: "0x2" }), sig({ txHash: "0x3" })];
    const report = summarizeReprocess(stored, derived);
    expect(report.summary.newlyDerived).toBe(1); // 0x3
    expect(report.summary.missingDerived).toBe(1); // 0x1
    expect(report.summary.stored).toBe(2);
    expect(report.summary.derived).toBe(2);
    const newly = report.changes.find((c) => c.kinds.includes("newly-derived"));
    const missing = report.changes.find((c) => c.kinds.includes("missing-derived"));
    expect(newly?.txHash).toBe("0x3");
    expect(missing?.txHash).toBe("0x1");
  });

  it("flags a copy-token-address improvement when stored had none", () => {
    const stored = [sig({ txHash: "0x1", side: "buy", tokenOutAddress: "" })];
    const derived = [sig({ txHash: "0x1", side: "buy", tokenOutAddress: TOKEN })];
    const report = summarizeReprocess(stored, derived);
    expect(report.summary.copyTokenAddressImprovements).toBe(1);
    expect(report.changes[0]?.kinds).toContain("copy-token-address");
  });
});
