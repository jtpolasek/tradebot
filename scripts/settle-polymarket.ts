import { config, EventBus } from "../packages/core/dist/index.js";
import { PaperEngine } from "../packages/paper-engine/dist/index.js";
import { closeDb, getDb, getOpenPolymarketPositionsForSettlement } from "../packages/store/dist/index.js";
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

  const positions = await getOpenPolymarketPositionsForSettlement(db);
  let settled = 0;
  let skipped = 0;
  let failed = 0;

  for (const position of positions) {
    try {
      const result = await engine.settlePolymarketPosition(position);
      if (result === "settled") settled += 1;
      else skipped += 1;
    } catch (err) {
      failed += 1;
      console.error(
        `failed token=${position.tokenAddress} condition=${position.conditionId} wallet=${position.sourceWalletId ?? ""}`,
      );
      console.error(err);
    }
  }

  console.log(`Polymarket settlement: candidates=${positions.length} settled=${settled} skipped=${skipped} failed=${failed}`);
  await closeDb();
  if (failed > 0) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(async (err: unknown) => {
    console.error(err);
    await closeDb();
    process.exit(1);
  });
}
