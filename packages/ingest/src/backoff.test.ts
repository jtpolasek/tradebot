import { describe, it, expect } from "vitest";
import { backoffMs } from "./backoff.js";

describe("backoffMs", () => {
  it("returns initial delay for attempt 0", () => {
    expect(backoffMs(0, 1000, 30000)).toBe(1000);
  });

  it("doubles each attempt", () => {
    expect(backoffMs(1, 1000, 30000)).toBe(2000);
    expect(backoffMs(2, 1000, 30000)).toBe(4000);
    expect(backoffMs(3, 1000, 30000)).toBe(8000);
    expect(backoffMs(4, 1000, 30000)).toBe(16000);
  });

  it("caps at max", () => {
    expect(backoffMs(5, 1000, 30000)).toBe(30000);
    expect(backoffMs(10, 1000, 30000)).toBe(30000);
    expect(backoffMs(100, 1000, 30000)).toBe(30000);
  });

  it("respects custom initial and cap", () => {
    expect(backoffMs(0, 500, 10000)).toBe(500);
    expect(backoffMs(3, 500, 10000)).toBe(4000);
    expect(backoffMs(5, 500, 10000)).toBe(10000);
  });
});
