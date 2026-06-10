import { describe, it, expect } from "vitest";
import { TRANSFER_TOPIC, padAddressToTopic, buildFromTopics, buildToTopics, chunk } from "./topics.js";

const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";

describe("TRANSFER_TOPIC", () => {
  it("matches the well-known ERC-20 Transfer event signature hash", () => {
    expect(TRANSFER_TOPIC).toBe("0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef");
  });
});

describe("padAddressToTopic", () => {
  it("pads a 20-byte address to 32 bytes", () => {
    const padded = padAddressToTopic(WETH);
    expect(padded).toHaveLength(66); // 0x + 64 hex chars
    expect(padded.toLowerCase()).toContain(WETH.slice(2).toLowerCase());
    // Leading zeros for padding
    expect(padded.startsWith("0x000000000000000000000000")).toBe(true);
  });

  it("produces topic that ends with the lowercase address", () => {
    const padded = padAddressToTopic(USDC).toLowerCase();
    expect(padded.endsWith(USDC.slice(2))).toBe(true);
  });
});

describe("buildFromTopics", () => {
  it("puts Transfer topic at [0], addresses at [1], null at [2]", () => {
    const [t0, t1, t2] = buildFromTopics([WETH]);
    expect(t0).toBe(TRANSFER_TOPIC);
    expect(Array.isArray(t1)).toBe(true);
    expect(t2).toBeNull();
    expect((t1 as string[]).length).toBe(1);
  });
});

describe("buildToTopics", () => {
  it("puts Transfer topic at [0], null at [1], addresses at [2]", () => {
    const [t0, t1, t2] = buildToTopics([WETH, USDC]);
    expect(t0).toBe(TRANSFER_TOPIC);
    expect(t1).toBeNull();
    expect(Array.isArray(t2)).toBe(true);
    expect((t2 as string[]).length).toBe(2);
  });
});

describe("chunk", () => {
  it("splits array into chunks of given size", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("returns single chunk when smaller than size", () => {
    expect(chunk([1, 2], 5)).toEqual([[1, 2]]);
  });

  it("returns empty array for empty input", () => {
    expect(chunk([], 3)).toEqual([]);
  });
});
