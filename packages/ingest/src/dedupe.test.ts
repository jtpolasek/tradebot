import { describe, it, expect } from "vitest";
import { LruSet } from "./dedupe.js";

describe("LruSet", () => {
  it("returns false for duplicate adds", () => {
    const set = new LruSet<string>(10);
    expect(set.add("a")).toBe(true);
    expect(set.add("a")).toBe(false);
    expect(set.size).toBe(1);
  });

  it("evicts oldest when at capacity", () => {
    const set = new LruSet<number>(3);
    set.add(1);
    set.add(2);
    set.add(3);
    set.add(4); // evicts 1
    expect(set.has(1)).toBe(false);
    expect(set.has(4)).toBe(true);
    expect(set.size).toBe(3);
  });

  it("evicts in insertion order", () => {
    const set = new LruSet<string>(2);
    set.add("x");
    set.add("y");
    set.add("z"); // evicts x
    expect(set.has("x")).toBe(false);
    expect(set.has("y")).toBe(true);
    expect(set.has("z")).toBe(true);
  });

  it("handles capacity 1", () => {
    const set = new LruSet<string>(1);
    set.add("a");
    set.add("b");
    expect(set.has("a")).toBe(false);
    expect(set.has("b")).toBe(true);
  });

  it("throws on capacity < 1", () => {
    expect(() => new LruSet(0)).toThrow();
  });
});
