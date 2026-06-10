import { describe, it, expect } from "vitest";
import { serializeEvent, deserializeEvent, bigintReplacer, bigintReviver } from "./recorder.js";
import type { RawTxEvent } from "@tradebot/core";

const event: RawTxEvent = {
  chain: "eth",
  source: "confirmed",
  txHash: "0xabc",
  from: "0x1234567890123456789012345678901234567890",
  to: "0x0987654321098765432109876543210987654321",
  blockNumber: 19_000_000,
  observedAt: 1_700_000_000_000,
  valueWei: 1_000_000_000_000_000_000n,
};

describe("JSONL round-trip", () => {
  it("serializes bigint as __bigint marker", () => {
    const line = serializeEvent(event);
    expect(line).toContain("__bigint");
    expect(line).toContain("1000000000000000000");
  });

  it("deserializes back to original bigint", () => {
    const line = serializeEvent(event);
    const restored = deserializeEvent(line);
    expect(restored.valueWei).toBe(1_000_000_000_000_000_000n);
  });

  it("round-trips all fields", () => {
    const line = serializeEvent(event);
    const restored = deserializeEvent(line);
    expect(restored.chain).toBe(event.chain);
    expect(restored.txHash).toBe(event.txHash);
    expect(restored.blockNumber).toBe(event.blockNumber);
    expect(restored.observedAt).toBe(event.observedAt);
    expect(restored.valueWei).toBe(event.valueWei);
  });

  it("handles event without bigint fields", () => {
    const minimal: RawTxEvent = {
      chain: "base",
      source: "mempool",
      txHash: "0xdef",
      from: "0xaaaa",
      to: null,
      blockNumber: null,
      observedAt: Date.now(),
    };
    const restored = deserializeEvent(serializeEvent(minimal));
    expect(restored.valueWei).toBeUndefined();
    expect(restored.to).toBeNull();
  });

  it("bigintReplacer handles nested bigints", () => {
    const obj = { a: 1n, b: { c: 2n } };
    const serialized = JSON.stringify(obj, bigintReplacer);
    const parsed = JSON.parse(serialized, bigintReviver) as typeof obj;
    expect(parsed.a).toBe(1n);
    expect(parsed.b.c).toBe(2n);
  });
});
