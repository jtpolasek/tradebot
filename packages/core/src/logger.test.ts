import { describe, it, expect, vi, afterEach } from "vitest";
import { installCrashHandlers } from "./logger.js";

describe("installCrashHandlers", () => {
  const teardowns: Array<() => void> = [];

  afterEach(() => {
    for (const t of teardowns.splice(0)) t();
    vi.restoreAllMocks();
  });

  it("logs fatal and exits non-zero on an unhandled rejection", () => {
    const fatal = vi.fn();
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    teardowns.push(installCrashHandlers({ fatal } as never));

    const reason = new Error("boom");
    process.emit("unhandledRejection", reason, Promise.reject(reason).catch(() => undefined));

    expect(fatal).toHaveBeenCalledWith({ err: reason }, expect.stringContaining("unhandled promise rejection"));
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("logs fatal and exits non-zero on an uncaught exception", () => {
    const fatal = vi.fn();
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    teardowns.push(installCrashHandlers({ fatal } as never));

    const err = new Error("kaboom");
    process.emit("uncaughtException", err);

    expect(fatal).toHaveBeenCalledWith({ err }, expect.stringContaining("uncaught exception"));
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("teardown removes the listeners it added", () => {
    const fatal = vi.fn();
    const before = {
      rejection: process.listenerCount("unhandledRejection"),
      exception: process.listenerCount("uncaughtException"),
    };

    const teardown = installCrashHandlers({ fatal } as never);
    expect(process.listenerCount("unhandledRejection")).toBe(before.rejection + 1);
    expect(process.listenerCount("uncaughtException")).toBe(before.exception + 1);

    teardown();
    expect(process.listenerCount("unhandledRejection")).toBe(before.rejection);
    expect(process.listenerCount("uncaughtException")).toBe(before.exception);
  });
});
