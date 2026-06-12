import { describe, it, expect } from "vitest";
import { isStaleSignal } from "./engine.js";

const NOW = 1_800_000_000_000; // fixed epoch ms

describe("isStaleSignal", () => {
  it("is not stale when there is no block timestamp (mempool / live)", () => {
    expect(isStaleSignal({}, NOW, 180_000)).toBe(false);
    expect(isStaleSignal({ blockTimestamp: null }, NOW, 180_000)).toBe(false);
  });

  it("is not stale when the block is within the max age", () => {
    expect(isStaleSignal({ blockTimestamp: NOW - 60_000 }, NOW, 180_000)).toBe(false);
  });

  it("is not stale exactly at the boundary", () => {
    expect(isStaleSignal({ blockTimestamp: NOW - 180_000 }, NOW, 180_000)).toBe(false);
  });

  it("is stale when the block is older than the max age", () => {
    expect(isStaleSignal({ blockTimestamp: NOW - 180_001 }, NOW, 180_000)).toBe(true);
  });

  it("flags an hours-old backfilled block as stale", () => {
    expect(isStaleSignal({ blockTimestamp: NOW - 4 * 60 * 60_000 }, NOW, 180_000)).toBe(true);
  });
});
