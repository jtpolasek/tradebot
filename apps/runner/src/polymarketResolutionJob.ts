import { createLogger } from "@tradebot/core";
import { getOpenPolymarketPositionsForSettlement } from "@tradebot/store";

const logger = createLogger("runner:polymarket-resolution");

type RunnerDb = Parameters<typeof getOpenPolymarketPositionsForSettlement>[0];

type SettlementCandidate = {
  chain: "polygon";
  tokenAddress: string;
  qty: number;
  avgCostUsd: number;
  sourceWalletId: string | null;
  conditionId: string;
  outcomeIndex: number;
};

type PolymarketSettlementEngine = {
  settlePolymarketPosition(position: SettlementCandidate): Promise<"settled" | "skipped">;
};

export function startPolymarketResolutionJob(
  db: RunnerDb,
  engine: PolymarketSettlementEngine,
  opts: { intervalMs?: number } = {},
): { stop: () => void } {
  const intervalMs = opts.intervalMs ?? 60_000;
  let running = false;

  const run = () => {
    if (running) return;
    running = true;
    void (async () => {
      const positions = await getOpenPolymarketPositionsForSettlement(db);
      for (const position of positions) {
        try {
          await engine.settlePolymarketPosition(position);
        } catch (err) {
          logger.error({
            err,
            tokenAddress: position.tokenAddress,
            conditionId: position.conditionId,
            walletId: position.sourceWalletId,
          }, "polymarket settlement failed");
        }
      }
    })()
      .catch((err: unknown) => logger.error({ err }, "polymarket settlement check failed"))
      .finally(() => {
        running = false;
      });
  };

  run();
  const timer = setInterval(run, intervalMs);
  return { stop: () => clearInterval(timer) };
}
