export type ExitTrigger = "tp" | "sl" | null;

export function checkExitTrigger(input: {
  currentPriceUsd: number;
  averageEntryUsd: number;
  takeProfitPct: number | null;
  stopLossPct: number | null;
}): ExitTrigger {
  if (input.averageEntryUsd <= 0) return null;
  const pnlPct = ((input.currentPriceUsd - input.averageEntryUsd) / input.averageEntryUsd) * 100;
  if (input.takeProfitPct !== null && pnlPct >= input.takeProfitPct) return "tp";
  if (input.stopLossPct !== null && pnlPct <= -input.stopLossPct) return "sl";
  return null;
}

export function calcExitQuantity(positionQuantity: number, exitSizePct: number): number {
  return positionQuantity * (exitSizePct / 100);
}

export type ExitRules = {
  enabled: boolean;
  takeProfitPct: number | null;
  stopLossPct: number | null;
  exitSizePct: number;
};

export type ExitCheckDeps = {
  getOpenPositions: () => Promise<Array<{
    id: string;
    chain: string;
    tokenAddress: string;
    qty: number;
    avgCostUsd: number;
    sourceWalletId: string | null;
  }>>;
  getLatestPrice: (chain: string, tokenAddress: string) => Promise<number | null>;
  executeSell: (pos: { id: string; chain: string; tokenAddress: string; qty: number; avgCostUsd: number; sourceWalletId: string | null }, trigger: ExitTrigger) => Promise<void>;
};

const pendingExits = new Set<string>();
let lastCheckedAt = 0;

export async function runExitCheck(rules: ExitRules, deps: ExitCheckDeps): Promise<void> {
  if (!rules.enabled) return;
  if (rules.takeProfitPct === null && rules.stopLossPct === null) return;
  if (Date.now() - lastCheckedAt < 60_000) return;
  lastCheckedAt = Date.now();

  const allPositions = await deps.getOpenPositions();
  const positions = allPositions.filter((p) => p.qty > 0 && !pendingExits.has(p.tokenAddress));
  if (!positions.length) return;

  await Promise.allSettled(
    positions.map(async (pos) => {
      const currentPriceUsd = await deps.getLatestPrice(pos.chain, pos.tokenAddress);
      if (currentPriceUsd === null) return;

      const trigger = checkExitTrigger({
        currentPriceUsd,
        averageEntryUsd: pos.avgCostUsd,
        takeProfitPct: rules.takeProfitPct,
        stopLossPct: rules.stopLossPct,
      });
      if (!trigger) return;

      pendingExits.add(pos.tokenAddress);
      try {
        const exitQty = calcExitQuantity(pos.qty, rules.exitSizePct);
        await deps.executeSell({ ...pos, qty: exitQty }, trigger);
      } finally {
        pendingExits.delete(pos.tokenAddress);
      }
    })
  );
}

export function resetExitWorkerState(): void {
  lastCheckedAt = 0;
  pendingExits.clear();
}
