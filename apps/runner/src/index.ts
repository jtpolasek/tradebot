import { config, createLogger, EventBus } from "@tradebot/core";
import { getDb, closeDb, getActiveWallets } from "@tradebot/store";
import { ChainWatcher, Recorder, deserializeEvent } from "@tradebot/ingest";
import { Decoder } from "@tradebot/decoder";
import postgres from "postgres";
import { readFileSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

const logger = createLogger("runner");
const bus = new EventBus();

function parseArgs(): { replayFile: string | null; speed: number } {
  const args = process.argv.slice(2);
  let replayFile: string | null = null;
  let speed = 1;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--replay" && args[i + 1]) {
      replayFile = args[++i]!;
    } else if (args[i] === "--speed" && args[i + 1]) {
      speed = Math.max(1, parseFloat(args[++i]!));
    }
  }
  return { replayFile, speed };
}

async function runReplay(file: string, speed: number): Promise<void> {
  logger.info({ file, speed }, "Replay mode — reading JSONL file");

  const lines = readFileSync(file, "utf-8")
    .split("\n")
    .filter((l) => l.trim().length > 0);

  const events = lines.map((l) => deserializeEvent(l));
  events.sort((a, b) => a.observedAt - b.observedAt);

  const originTs = events[0]?.observedAt ?? Date.now();
  const wallStart = Date.now();

  for (const event of events) {
    const targetDelay = (event.observedAt - originTs) / speed;
    const elapsed = Date.now() - wallStart;
    const wait = targetDelay - elapsed;
    if (wait > 0) {
      await new Promise<void>((r) => setTimeout(r, wait));
    }
    bus.emit("raw-tx", event);
  }

  logger.info({ count: events.length }, "Replay complete");
}

async function main() {
  const { replayFile, speed } = parseArgs();
  logger.info({ replayFile, speed }, "Starting tradebot runner...");

  const pg = postgres(config.DATABASE_URL, { max: 1 });
  await pg`select 1`;
  await pg.end();
  const db = getDb(config.DATABASE_URL);
  logger.info("Database connection ok.");

  const wallets = await getActiveWallets(db);
  const walletAddresses = wallets.map((w) => w.address);

  const decoder = new Decoder({ bus, db, wallets: walletAddresses });
  decoder.start();

  bus.on("raw-tx", (event) => {
    logger.debug({ chain: event.chain, source: event.source, txHash: event.txHash }, "raw-tx");
  });

  if (replayFile) {
    await runReplay(replayFile, speed);
    await closeDb();
    process.exit(0);
  }

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

  for (const watcher of watchers) {
    await watcher.start();
  }

  logger.info("Runner ready — watching ETH and Base.");

  async function shutdown() {
    logger.info("Shutting down...");
    decoder.stop();
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
