import { config, createLogger, EventBus, isEvmChain } from "@tradebot/core";
import {
  getDb,
  closeDb,
  getActiveWallets,
  getAllSettings,
  getOpenPositions,
  latestMark,
  getCopyRequestedCandidates,
  transitionCandidateReviewStatus,
  getLatestFillForSignal,
  upsertRunnerHealth,
} from "@tradebot/store";
import { ChainWatcher, PolymarketWatcher, Recorder, deserializeEvent } from "@tradebot/ingest";
import { Decoder } from "@tradebot/decoder";
import { startMarksJob } from "@tradebot/pricing";
import { PaperEngine, runExitCheck } from "@tradebot/paper-engine";
import { BrainWeightProvider, startScorerJob } from "@tradebot/brain";
import { createPublicClient, webSocket } from "viem";
import { mainnet, base } from "viem/chains";
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

  const decoder = new Decoder({
    bus,
    db,
    wallets: wallets
      .filter((w) => isEvmChain(w.chain))
      .map((w) => ({ address: w.address, id: w.id, chain: w.chain })),
  });
  decoder.start();

  // RPC clients for pricing (loose structural interfaces for viem compat)
  // batch.multicall folds concurrent readContract calls into one eth_call — keeps
  // pool-discovery fan-out under Alchemy's compute-units-per-second cap
  const ethRpcClient = createPublicClient({ chain: mainnet, batch: { multicall: true }, transport: webSocket(`wss://eth-mainnet.g.alchemy.com/v2/${config.ALCHEMY_API_KEY}`) });
  const baseRpcClient = createPublicClient({ chain: base, batch: { multicall: true }, transport: webSocket(`wss://base-mainnet.g.alchemy.com/v2/${config.BASE_ALCHEMY_API_KEY ?? config.ALCHEMY_API_KEY}`) });
  const rpcClients = { eth: ethRpcClient, base: baseRpcClient };

  const marksJob = startMarksJob(db, rpcClients);

  const weightProvider = new BrainWeightProvider();
  const scorerJob = startScorerJob(db, weightProvider, rpcClients);

  const engine = new PaperEngine(db, bus, config, rpcClients, weightProvider);
  await engine.start();
  const exitJob = startExitJob(db, engine);
  const candidateCopyJob = startCandidateCopyJob(db, engine);

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

  // Polymarket (Polygon) — watch+record only, fully decoupled from the EVM bus/decoder/engine.
  const polymarketWatcher = new PolymarketWatcher({
    db,
    pollMs: config.POLYMARKET_POLL_MS,
    baseUrl: config.POLYMARKET_DATA_API_URL,
  });
  await polymarketWatcher.start();

  const heartbeatJob = startHeartbeatJob(db, [...watchers, polymarketWatcher]);

  logger.info("Runner ready — watching ETH, Base, and Polymarket (Polygon).");

  async function shutdown() {
    logger.info("Shutting down...");
    engine.stop();
    exitJob.stop();
    candidateCopyJob.stop();
    marksJob.stop();
    scorerJob.stop();
    heartbeatJob.stop();
    decoder.stop();
    for (const watcher of watchers) watcher.stop();
    polymarketWatcher.stop();
    await closeDb();
    process.exit(0);
  }

  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

function startCandidateCopyJob(db: ReturnType<typeof getDb>, engine: PaperEngine): { stop: () => void } {
  let running = false;
  const run = () => {
    if (running) return;
    running = true;
    void (async () => {
      const candidates = await getCopyRequestedCandidates(db, 10);
      for (const candidate of candidates) {
        const claimed = await transitionCandidateReviewStatus(db, candidate.id, ["copy-requested"], "copying");
        if (!claimed) continue;
        try {
          await engine.executeManualCandidateCopy({ ...candidate, reviewStatus: "copying" });
          const fill = await getLatestFillForSignal(db, candidate.id);
          await transitionCandidateReviewStatus(db, candidate.id, ["copying"], fill?.decision === "copied" ? "copied" : "copy-failed");
        } catch (err) {
          logger.error({ err, signalId: candidate.id }, "manual candidate copy failed");
          await transitionCandidateReviewStatus(db, candidate.id, ["copying"], "copy-failed");
        }
      }
    })()
      .catch((err: unknown) => logger.error({ err }, "candidate copy check failed"))
      .finally(() => {
        running = false;
      });
  };

  run();
  const timer = setInterval(run, 5_000);
  return { stop: () => clearInterval(timer) };
}

function startHeartbeatJob(
  db: ReturnType<typeof getDb>,
  watchers: { getHealth: ChainWatcher["getHealth"] }[]
): { stop: () => void } {
  const version = process.env["GIT_SHA"];
  const run = () => {
    const mem = process.memoryUsage();
    const payload = {
      pid: process.pid,
      uptimeSec: Math.round(process.uptime()),
      rssBytes: mem.rss,
      heapUsedBytes: mem.heapUsed,
      ...(version ? { version } : {}),
      chains: watchers.map((w) => w.getHealth()),
    };
    logger.info({ rssMb: Math.round(mem.rss / (1024 * 1024)), chains: payload.chains }, "heartbeat");
    void upsertRunnerHealth(db, payload).catch((err: unknown) => logger.warn({ err }, "heartbeat write failed"));
  };

  run();
  const timer = setInterval(run, config.HEARTBEAT_INTERVAL_MS);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

function startExitJob(db: ReturnType<typeof getDb>, engine: PaperEngine): { stop: () => void } {
  const run = () => {
    void (async () => {
      const settings = await getAllSettings(db);
      await runExitCheck({
        enabled: booleanSetting(settings, ["EXIT_ENABLED", "exit_enabled"], false),
        takeProfitPct: nullableNumberSetting(settings, ["TAKE_PROFIT_PCT", "take_profit_pct"]),
        stopLossPct: nullableNumberSetting(settings, ["STOP_LOSS_PCT", "stop_loss_pct"]),
        exitSizePct: numberSetting(settings, ["EXIT_SIZE_PCT", "exit_size_pct"], 100),
      }, {
        getOpenPositions: () => getOpenPositions(db),
        getLatestPrice: async (chain, tokenAddress) => {
          if (chain !== "eth" && chain !== "base") return null;
          const mark = await latestMark(db, chain, tokenAddress);
          return mark?.priceUsd ?? null;
        },
        executeSell: (pos, trigger, currentPriceUsd) => engine.executeExitSell(pos, trigger, currentPriceUsd),
      });
    })().catch((err: unknown) => logger.error({ err }, "exit check failed"));
  };

  run();
  const timer = setInterval(run, 60_000);
  return { stop: () => clearInterval(timer) };
}

function numberSetting(settings: Record<string, unknown>, keys: string[], fallback: number): number {
  const value = nullableNumberSetting(settings, keys);
  return value !== null && value > 0 ? value : fallback;
}

function nullableNumberSetting(settings: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = settings[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function booleanSetting(settings: Record<string, unknown>, keys: string[], fallback: boolean): boolean {
  for (const key of keys) {
    const value = settings[key];
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (["true", "1", "yes", "on"].includes(normalized)) return true;
      if (["false", "0", "no", "off"].includes(normalized)) return false;
    }
  }
  return fallback;
}
