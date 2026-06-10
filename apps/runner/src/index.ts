import { config, createLogger, EventBus } from "@tradebot/core";
import { getDb, closeDb } from "@tradebot/store";
import { ChainWatcher, Recorder } from "@tradebot/ingest";
import postgres from "postgres";
import { join } from "path";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

const logger = createLogger("runner");
const bus = new EventBus();

async function main() {
  logger.info("Starting tradebot runner...");

  const pg = postgres(config.DATABASE_URL, { max: 1 });
  await pg`select 1`;
  await pg.end();
  const db = getDb(config.DATABASE_URL);
  logger.info("Database connection ok.");

  const recordingsDir = join(__dirname, "../../../recordings");
  const recorder = new Recorder(recordingsDir);

  const ethWsUrl = `wss://eth-mainnet.g.alchemy.com/v2/${config.ALCHEMY_API_KEY}`;
  const baseWsUrl = `wss://base-mainnet.g.alchemy.com/v2/${config.BASE_ALCHEMY_API_KEY ?? config.ALCHEMY_API_KEY}`;

  const watchers = [
    new ChainWatcher({
      chain: "eth",
      primaryWsUrl: ethWsUrl,
      ...(config.QUICKNODE_ETH_WS ? { fallbackWsUrl: config.QUICKNODE_ETH_WS } : {}),
      db,
      bus,
      recorder,
    }),
    new ChainWatcher({
      chain: "base",
      primaryWsUrl: baseWsUrl,
      ...(config.QUICKNODE_BASE_WS ? { fallbackWsUrl: config.QUICKNODE_BASE_WS } : {}),
      db,
      bus,
      recorder,
    }),
  ];

  bus.on("raw-tx", (event) => {
    logger.debug({ chain: event.chain, source: event.source, txHash: event.txHash }, "raw-tx");
  });

  for (const watcher of watchers) {
    await watcher.start();
  }

  logger.info("Runner ready — watching ETH and Base.");

  async function shutdown() {
    logger.info("Shutting down...");
    for (const watcher of watchers) watcher.stop();
    await closeDb();
    process.exit(0);
  }

  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
