import { config, EventBus } from "../packages/core/dist/index.js";
import { PaperEngine } from "../packages/paper-engine/dist/index.js";
import { getPolymarketMarketStatus } from "../packages/pricing/dist/index.js";
import { closeDb, getDb, getOpenPolymarketPositionsForSettlement } from "../packages/store/dist/index.js";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { pathToFileURL } from "url";

const dummyRpcClient = {
  readContract: async () => {
    throw new Error("settle:polymarket does not support EVM RPC reads");
  },
};

export async function main(): Promise<void> {
  const db = getDb(config.DATABASE_URL);
  const engine = new PaperEngine(db, new EventBus(), config, dummyRpcClient as never);
  await engine.start();
  engine.stop();

  const report: string[] = [];
  const positions = await getOpenPolymarketPositionsForSettlement(db);
  let settled = 0;
  let skipped = 0;
  let failed = 0;

  for (const position of positions) {
    try {
      const result = await engine.settlePolymarketPosition(position);
      if (result === "settled") settled += 1;
      else {
        skipped += 1;
        report.push(await formatSkipped(position));
      }
    } catch (err) {
      failed += 1;
      console.error(
        `failed token=${position.tokenAddress} condition=${position.conditionId} wallet=${position.sourceWalletId ?? ""}`,
      );
      console.error(err);
    }
  }

  const summary = `Polymarket settlement: candidates=${positions.length} settled=${settled} skipped=${skipped} failed=${failed}`;
  const reportPath = await writeReport([summary, "", ...report]);
  console.log(summary);
  console.log(`Report written: ${reportPath}`);
  await closeDb();
  if (failed > 0) process.exit(1);
}

async function formatSkipped(position: Awaited<ReturnType<typeof getOpenPolymarketPositionsForSettlement>>[number]): Promise<string> {
  const status = await getPolymarketMarketStatus(position.conditionId);
  const prices = status?.outcomePrices?.join("/") ?? "";
  return [
    "SKIPPED",
    `Market: ${position.token?.name ?? "(unknown)"}`,
    `Outcome: ${position.token?.symbol ?? ""} (index ${position.outcomeIndex})`,
    `Qty: ${position.qty}`,
    `Avg cost: ${position.avgCostUsd}`,
    `Condition: ${position.conditionId}`,
    `Gamma: active=${status?.active ?? ""} closed=${status?.closed ?? ""} resolved=${status?.resolved ?? ""} prices=${prices}`,
    "",
  ].join("\n");
}

async function writeReport(lines: string[]): Promise<string> {
  const dir = "reports";
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(dir, `polymarket-settlement-${stamp}.txt`);
  await writeFile(path, `${lines.join("\n")}\n`, "utf8");
  return path;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(async (err: unknown) => {
    console.error(err);
    await closeDb();
    process.exit(1);
  });
}
