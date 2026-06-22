import { createLogger } from "@tradebot/core";
import { getPendingPolymarketSignals } from "@tradebot/store";
import type { TradeSignal } from "@tradebot/core";

const logger = createLogger("runner:polymarket-copy");

type RunnerDb = Parameters<typeof getPendingPolymarketSignals>[0];
type EngineLike = {
  executePolymarketSignal(signal: TradeSignal): Promise<void>;
};

export function startPolymarketCopyJob(
  db: RunnerDb,
  engine: EngineLike,
  opts: { intervalMs?: number } = {},
): { stop: () => void } {
  let running = false;

  const run = () => {
    if (running) return;
    running = true;
    void (async () => {
      const signals = await getPendingPolymarketSignals(db, 25);
      for (const signal of signals) {
        try {
          await engine.executePolymarketSignal(signal);
        } catch (err) {
          logger.error({ err, signalId: signal.id }, "polymarket auto-copy failed");
        }
      }
    })()
      .catch((err: unknown) => logger.error({ err }, "polymarket auto-copy check failed"))
      .finally(() => {
        running = false;
      });
  };

  run();
  const timer = setInterval(run, opts.intervalMs ?? 5_000);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
