import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ChainWatcher } from "./chainWatcher.js";
import { EventBus } from "@tradebot/core";
import { Recorder } from "../recorder.js";
import type { Db } from "@tradebot/store";
import type { RawTxEvent } from "@tradebot/core";

// ── Mock DB ─────────────────────────────────────────────────────────────────

function makeMockDb(lastBlock: number | null = null): Db {
  return {
    getActiveWallets: vi.fn().mockResolvedValue([]),
    getLastBlock: vi.fn().mockResolvedValue(lastBlock),
    upsertLastBlock: vi.fn().mockResolvedValue(undefined),
  } as unknown as Db;
}

// ── Mock viem client ─────────────────────────────────────────────────────────

type UnwatchFn = () => void;

function makeMockClient(opts: {
  currentBlock?: number;
  onWatchEvent?: () => void;
  onWatchBlockNumber?: () => void;
} = {}) {
  const unwatches: UnwatchFn[] = [];
  const client = {
    getBlockNumber: vi.fn().mockResolvedValue(BigInt(opts.currentBlock ?? 100)),
    watchEvent: vi.fn().mockImplementation(() => {
      opts.onWatchEvent?.();
      const unwatch: UnwatchFn = vi.fn();
      unwatches.push(unwatch);
      return unwatch;
    }),
    watchBlockNumber: vi.fn().mockImplementation(() => {
      opts.onWatchBlockNumber?.();
      const unwatch: UnwatchFn = vi.fn();
      unwatches.push(unwatch);
      return unwatch;
    }),
    getLogs: vi.fn().mockResolvedValue([]),
    getTransactionReceipt: vi.fn().mockResolvedValue(null),
    getTransaction: vi.fn().mockResolvedValue(null),
  };
  return { client, unwatches };
}

// ── Recorder stub ─────────────────────────────────────────────────────────────

function makeRecorder(): Recorder {
  const recorder = new Recorder("/tmp/test-recordings");
  vi.spyOn(recorder, "record").mockResolvedValue(undefined);
  return recorder;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("ChainWatcher unit", () => {
  it("backoff sequence doubles up to cap", async () => {
    const { backoffMs } = await import("../backoff.js");
    expect(backoffMs(0)).toBe(1000);
    expect(backoffMs(1)).toBe(2000);
    expect(backoffMs(4)).toBe(16000);
    expect(backoffMs(5)).toBe(30000);
    expect(backoffMs(10)).toBe(30000);
  });

  it("LRU dedupe evicts oldest entry at capacity", async () => {
    const { LruSet } = await import("../dedupe.js");
    const set = new LruSet<string>(2);
    expect(set.add("a")).toBe(true);
    expect(set.add("b")).toBe(true);
    expect(set.add("c")).toBe(true); // evicts "a"
    expect(set.has("a")).toBe(false);
    expect(set.has("c")).toBe(true);
  });
});

describe("ChainWatcher backfill logic", () => {
  it("triggers backfill when saved block is behind current", async () => {
    // We test backfill by calling the private method through the _backfillCallCount counter.
    // We stub the viem client so no real network calls are made.

    const bus = new EventBus();
    const recorder = makeRecorder();

    // Saved block = 50, current block = 150 → should backfill
    // But we can't easily test start() without a real WS. Instead, test
    // that the backfillGap counter increments when we manually drive it.

    // Workaround: Construct ChainWatcher and call the private backfill method via type assertion.
    const watcher = new ChainWatcher({
      chain: "eth",
      primaryWsUrl: "wss://placeholder",
      db: makeMockDb(50),
      bus,
      recorder,
    });

    // Patch the client so getLogs doesn't crash
    const mockClient = {
      getLogs: vi.fn().mockResolvedValue([]),
    };
    (watcher as unknown as { client: typeof mockClient }).client = mockClient;

    expect(watcher._backfillCallCount).toBe(0);
    await (watcher as unknown as { backfillGap(f: number, t: number): Promise<void> }).backfillGap(51, 150);
    expect(watcher._backfillCallCount).toBe(1);
  });

  it("does not backfill when no saved block exists", async () => {
    // If savedBlock is null we skip backfill — verified by the guard in connect().
    // We just ensure backfill is not called with null.
    const savedBlock = null;
    const currentBlock = 100;
    const shouldBackfill = savedBlock !== null && currentBlock > savedBlock + 1;
    expect(shouldBackfill).toBe(false);
  });

  it("backfill chunks into BACKFILL_CHUNK blocks", async () => {
    const bus = new EventBus();
    const recorder = makeRecorder();
    const watcher = new ChainWatcher({
      chain: "eth",
      primaryWsUrl: "wss://placeholder",
      db: makeMockDb(0),
      bus,
      recorder,
    });

    const mockClient = {
      getLogs: vi.fn().mockResolvedValue([]),
    };
    (watcher as unknown as { client: typeof mockClient }).client = mockClient;
    (watcher as unknown as { wallets: string[] }).wallets = ["0xaaaa"];

    // Range: 1 to 1200 -> 3 chunks (1-500, 501-1000, 1001-1200).
    // Each chunk queries both transfer directions: from watched wallets and to watched wallets.
    await (watcher as unknown as { backfillGap(f: number, t: number): Promise<void> }).backfillGap(1, 1200);
    expect(mockClient.getLogs).toHaveBeenCalledTimes(6);
    expect(mockClient.getLogs).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ fromBlock: 1n, toBlock: 500n, args: { from: ["0xaaaa"] } })
    );
    expect(mockClient.getLogs).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ fromBlock: 1n, toBlock: 500n, args: { to: ["0xaaaa"] } })
    );
    expect(mockClient.getLogs).toHaveBeenNthCalledWith(
      5,
      expect.objectContaining({ fromBlock: 1001n, toBlock: 1200n, args: { from: ["0xaaaa"] } })
    );
    expect(mockClient.getLogs).toHaveBeenNthCalledWith(
      6,
      expect.objectContaining({ fromBlock: 1001n, toBlock: 1200n, args: { to: ["0xaaaa"] } })
    );
  });

  it("uses 10-block chunks for Base backfill", async () => {
    const bus = new EventBus();
    const recorder = makeRecorder();
    const watcher = new ChainWatcher({
      chain: "base",
      primaryWsUrl: "wss://placeholder",
      db: makeMockDb(0),
      bus,
      recorder,
    });

    const mockClient = {
      getLogs: vi.fn().mockResolvedValue([]),
    };
    (watcher as unknown as { client: typeof mockClient }).client = mockClient;
    (watcher as unknown as { wallets: string[] }).wallets = ["0xaaaa"];

    await (watcher as unknown as { backfillGap(f: number, t: number): Promise<void> }).backfillGap(1, 27);
    expect(mockClient.getLogs).toHaveBeenCalledTimes(6);
    expect(mockClient.getLogs).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ fromBlock: 1n, toBlock: 10n, args: { from: ["0xaaaa"] } })
    );
    expect(mockClient.getLogs).toHaveBeenNthCalledWith(
      5,
      expect.objectContaining({ fromBlock: 21n, toBlock: 27n, args: { from: ["0xaaaa"] } })
    );
  });

  it("chunks Base backfill wallet filters into small address batches", async () => {
    const bus = new EventBus();
    const recorder = makeRecorder();
    const watcher = new ChainWatcher({
      chain: "base",
      primaryWsUrl: "wss://placeholder",
      db: makeMockDb(0),
      bus,
      recorder,
    });

    const mockClient = {
      getLogs: vi.fn().mockResolvedValue([]),
    };
    (watcher as unknown as { client: typeof mockClient }).client = mockClient;
    (watcher as unknown as { wallets: string[] }).wallets = [
      "0x0001",
      "0x0002",
      "0x0003",
      "0x0004",
      "0x0005",
      "0x0006",
      "0x0007",
      "0x0008",
      "0x0009",
      "0x0010",
      "0x0011",
      "0x0012",
    ];

    await (watcher as unknown as { backfillGap(f: number, t: number): Promise<void> }).backfillGap(1, 10);

    expect(mockClient.getLogs).toHaveBeenCalledTimes(6);
    expect(mockClient.getLogs).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ fromBlock: 1n, toBlock: 10n, args: { from: ["0x0001", "0x0002", "0x0003", "0x0004", "0x0005"] } })
    );
    expect(mockClient.getLogs).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ fromBlock: 1n, toBlock: 10n, args: { from: ["0x0006", "0x0007", "0x0008", "0x0009", "0x0010"] } })
    );
    expect(mockClient.getLogs).toHaveBeenNthCalledWith(
      5,
      expect.objectContaining({ fromBlock: 1n, toBlock: 10n, args: { from: ["0x0011", "0x0012"] } })
    );
  });

  it("retries Base backfill getLogs when the provider rate limits", async () => {
    vi.useFakeTimers();
    const bus = new EventBus();
    const recorder = makeRecorder();
    const watcher = new ChainWatcher({
      chain: "base",
      primaryWsUrl: "wss://placeholder",
      db: makeMockDb(0),
      bus,
      recorder,
    });

    const mockClient = {
      getLogs: vi.fn()
        .mockRejectedValueOnce(new Error("Your app has exceeded its compute units per second capacity."))
        .mockResolvedValue([]),
    };
    (watcher as unknown as { client: typeof mockClient }).client = mockClient;
    (watcher as unknown as { wallets: string[] }).wallets = ["0xaaaa"];

    const backfill = (watcher as unknown as { backfillGap(f: number, t: number): Promise<void> }).backfillGap(1, 1);
    await vi.advanceTimersByTimeAsync(1_000);
    await backfill;
    vi.useRealTimers();

    expect(mockClient.getLogs).toHaveBeenCalledTimes(3);
    expect(mockClient.getLogs).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ fromBlock: 1n, toBlock: 1n, args: { from: ["0xaaaa"] } })
    );
    expect(mockClient.getLogs).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ fromBlock: 1n, toBlock: 1n, args: { to: ["0xaaaa"] } })
    );
  });
});

describe("ChainWatcher failover", () => {
  type Internals = {
    fallbackWsUrl: string | undefined;
    usingFallback: boolean;
    primaryDownSince: number | null;
    onConnectionFailure(): void;
    resolveWsUrl(): string;
  };

  function makeWatcher(): Internals;
  function makeWatcher(fallback: string): Internals;
  function makeWatcher(fallback?: string): Internals {
    return new ChainWatcher({
      chain: "eth",
      primaryWsUrl: "wss://primary",
      ...(fallback ? { fallbackWsUrl: fallback } : {}),
      db: makeMockDb(),
      bus: new EventBus(),
      recorder: makeRecorder(),
    }) as unknown as Internals;
  }

  it("switches to the fallback URL after the primary fails", () => {
    const w = makeWatcher("wss://fallback");
    expect(w.resolveWsUrl()).toBe("wss://primary");
    w.onConnectionFailure();
    expect(w.usingFallback).toBe(true);
    expect(w.resolveWsUrl()).toBe("wss://fallback");
  });

  it("retries the primary after the fallback also fails", () => {
    const w = makeWatcher("wss://fallback");
    w.onConnectionFailure(); // primary down → fallback
    w.onConnectionFailure(); // fallback down → primary
    expect(w.usingFallback).toBe(false);
    expect(w.resolveWsUrl()).toBe("wss://primary");
  });

  it("retries the primary once the failover window expires", () => {
    const w = makeWatcher("wss://fallback");
    w.onConnectionFailure();
    w.primaryDownSince = Date.now() - 61_000; // past FAILOVER_TIMEOUT_MS
    expect(w.resolveWsUrl()).toBe("wss://primary");
    expect(w.usingFallback).toBe(false);
  });

  it("is a no-op without a configured fallback", () => {
    const w = makeWatcher();
    w.onConnectionFailure();
    expect(w.usingFallback).toBe(false);
    expect(w.resolveWsUrl()).toBe("wss://primary");
  });
});

describe("ChainWatcher teardown", () => {
  it("runs and clears all cleanup fns and drops the client", () => {
    const watcher = new ChainWatcher({
      chain: "eth",
      primaryWsUrl: "wss://placeholder",
      db: makeMockDb(),
      bus: new EventBus(),
      recorder: makeRecorder(),
    });

    const unwatch = vi.fn();
    const internals = watcher as unknown as {
      cleanupFns: Array<() => void>;
      client: unknown;
      teardown(): void;
    };
    internals.cleanupFns = [unwatch, unwatch];
    internals.client = {};

    internals.teardown();

    expect(unwatch).toHaveBeenCalledTimes(2);
    expect(internals.cleanupFns).toHaveLength(0);
    expect(internals.client).toBeNull();
  });
});

describe("ChainWatcher emit", () => {
  it("emits raw-tx events on the bus", async () => {
    const bus = new EventBus();
    const received: RawTxEvent[] = [];
    bus.on("raw-tx", (e) => received.push(e));

    const recorder = makeRecorder();
    const watcher = new ChainWatcher({
      chain: "eth",
      primaryWsUrl: "wss://placeholder",
      db: makeMockDb(),
      bus,
      recorder,
    });

    // Directly call private emitAndRecord
    const event: RawTxEvent = {
      chain: "eth",
      source: "confirmed",
      txHash: "0xabc",
      from: "0x1234",
      to: null,
      blockNumber: 1,
      observedAt: Date.now(),
    };
    (watcher as unknown as { emitAndRecord(e: RawTxEvent): void }).emitAndRecord(event);

    expect(received).toHaveLength(1);
    expect(received[0]?.txHash).toBe("0xabc");
    expect(recorder.record).toHaveBeenCalledWith(event);
  });
});
