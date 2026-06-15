import Fastify from "fastify";
import wsPlugin from "@fastify/websocket";
import { z } from "zod";
import { BrainWeightProvider, runScorerJob } from "@tradebot/brain";
import { config, normalizeAddressInput } from "@tradebot/core";
import { createPublicClient, webSocket } from "viem";
import { mainnet, base as baseChain } from "viem/chains";
import {
  getDb,
  getAllWallets,
  getActiveWallets,
  insertWallet,
  setWalletActive,
  setWalletAutoCopy,
  getWalletById,
  getRecentSignals,
  getCandidateSignals,
  getSignalById,
  setCandidateReviewStatus,
  getRecentFills,
  getOpenPositions,
  getPortfolioAnalytics,
  latestSnapshot,
  getRecentSnapshots,
  getAllLeaderStats,
  getAdaptationLogs,
  getAllSettings,
  setSetting,
  deleteSetting,
  latestMark,
} from "@tradebot/store";
import { apiConfig } from "./config.js";

const db = getDb();
const manualWeightProvider = new BrainWeightProvider();
let leaderRefresh: Promise<void> | null = null;
const rpcClients = {
  eth: createPublicClient({
    chain: mainnet,
    batch: { multicall: true },
    transport: webSocket(`wss://eth-mainnet.g.alchemy.com/v2/${config.ALCHEMY_API_KEY}`),
  }),
  base: createPublicClient({
    chain: baseChain,
    batch: { multicall: true },
    transport: webSocket(`wss://base-mainnet.g.alchemy.com/v2/${config.BASE_ALCHEMY_API_KEY ?? config.ALCHEMY_API_KEY}`),
  }),
};

const app = Fastify({ logger: { level: apiConfig.LOG_LEVEL } });
await app.register(wsPlugin);

app.addHook("preHandler", async (req, reply) => {
  if (req.method === "OPTIONS") return;
  if (req.headers["x-api-key"] !== apiConfig.API_KEY) {
    return reply.code(401).send({ error: "Unauthorized" });
  }
});

// CORS: restrict to configured dashboard origin
app.addHook("onSend", async (req, reply) => {
  const origin = req.headers["origin"];
  if (origin === apiConfig.CORS_ORIGIN) {
    reply.header("Access-Control-Allow-Origin", apiConfig.CORS_ORIGIN);
    reply.header("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
    reply.header("Access-Control-Allow-Headers", "Content-Type,X-Api-Key");
  }
});

app.options("*", async (_req, reply) => reply.send());

// ── Wallets ──────────────────────────────────────────────────────────────────

app.get("/wallets", async (_req, reply) => {
  const walletRows = await getAllWallets(db);
  reply.send({ wallets: walletRows });
});

const PostWalletBody = z.object({
  chain: z.enum(["eth", "base"]),
  address: z.string().min(1),
  label: z.string().min(1),
});

app.post("/wallets", async (req, reply) => {
  const body = PostWalletBody.safeParse(req.body);
  if (!body.success) return reply.code(400).send({ error: body.error.message });
  let address: string;
  try {
    address = normalizeAddressInput(body.data.address);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Enter a valid Ethereum address.";
    return reply.code(400).send({ error: message });
  }
  const wallet = await insertWallet(db, {
    chain: body.data.chain,
    address,
    label: body.data.label,
    active: true,
    autoCopy: true,
  });
  reply.code(201).send({ wallet });
});

const PatchWalletBody = z.object({
  active: z.boolean().optional(),
  autoCopy: z.boolean().optional(),
}).refine((b) => b.active !== undefined || b.autoCopy !== undefined, {
  message: "Provide at least one of active or autoCopy",
});

app.patch("/wallets/:id", async (req, reply) => {
  const { id } = req.params as { id: string };
  const body = PatchWalletBody.safeParse(req.body);
  if (!body.success) return reply.code(400).send({ error: body.error.message });
  const wallet = await getWalletById(db, id);
  if (!wallet) return reply.code(404).send({ error: "Wallet not found" });
  if (body.data.active !== undefined) await setWalletActive(db, id, body.data.active);
  if (body.data.autoCopy !== undefined) await setWalletAutoCopy(db, id, body.data.autoCopy);
  const updated = await getWalletById(db, id);
  reply.send({ wallet: updated });
});

app.delete("/wallets/:id", async (req, reply) => {
  const { id } = req.params as { id: string };
  const wallet = await getWalletById(db, id);
  if (!wallet) return reply.code(404).send({ error: "Wallet not found" });
  await setWalletActive(db, id, false);
  reply.send({ ok: true });
});

// ── Signals ───────────────────────────────────────────────────────────────────

const SinceQuery = z.object({
  since: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

app.get("/signals", async (req, reply) => {
  const q = SinceQuery.safeParse(req.query);
  if (!q.success) return reply.code(400).send({ error: q.error.message });
  const since = q.data.since ? new Date(q.data.since) : new Date(Date.now() - 24 * 60 * 60 * 1000);
  const signals = await getRecentSignals(db, since, q.data.limit);
  reply.send({ signals: signals.map(serializeSignal) });
});

// ── Candidate Review ─────────────────────────────────────────────────────────

app.get("/candidates", async (req, reply) => {
  const q = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }).safeParse(req.query);
  if (!q.success) return reply.code(400).send({ error: q.error.message });
  const signals = await getCandidateSignals(db, q.data.limit);
  reply.send({ candidates: signals.map(serializeSignal) });
});

app.post("/candidates/:id/copy", async (req, reply) => {
  const { id } = req.params as { id: string };
  const signal = await getSignalById(db, id);
  if (!signal || signal.decodeStatus !== "candidate") {
    return reply.code(404).send({ error: "Candidate not found" });
  }
  if (signal.reviewStatus === "dismissed" || signal.reviewStatus === "copied" || signal.reviewStatus === "copying") {
    return reply.code(409).send({ error: `Candidate is already ${signal.reviewStatus}` });
  }
  const updated = await setCandidateReviewStatus(db, id, "copy-requested");
  reply.send({ candidate: updated ? serializeSignal(updated) : null });
});

app.post("/candidates/:id/dismiss", async (req, reply) => {
  const { id } = req.params as { id: string };
  const signal = await getSignalById(db, id);
  if (!signal || signal.decodeStatus !== "candidate") {
    return reply.code(404).send({ error: "Candidate not found" });
  }
  if (signal.reviewStatus === "copied" || signal.reviewStatus === "copying" || signal.reviewStatus === "copy-requested") {
    return reply.code(409).send({ error: `Candidate is already ${signal.reviewStatus}` });
  }
  const updated = await setCandidateReviewStatus(db, id, "dismissed");
  reply.send({ candidate: updated ? serializeSignal(updated) : null });
});

// ── Fills ─────────────────────────────────────────────────────────────────────

app.get("/fills", async (req, reply) => {
  const q = SinceQuery.safeParse(req.query);
  if (!q.success) return reply.code(400).send({ error: q.error.message });
  const since = q.data.since ? new Date(q.data.since) : new Date(Date.now() - 24 * 60 * 60 * 1000);
  const fills = await getRecentFills(db, since, q.data.limit);
  reply.send({ fills });
});

// ── Portfolio ─────────────────────────────────────────────────────────────────

app.get("/portfolio", async (_req, reply) => {
  const [snapshot, positions, snapshots] = await Promise.all([
    latestSnapshot(db),
    getOpenPositions(db),
    getRecentSnapshots(db, 288), // up to 24h at 5-min intervals
  ]);

  const positionsWithMark = await Promise.all(
    positions.map(async (p) => {
      const mark = await latestMark(db, p.chain, p.tokenAddress);
      return { ...p, currentPriceUsd: mark?.priceUsd ?? null };
    })
  );

  reply.send({ snapshot, positions: positionsWithMark, snapshots });
});

app.get("/analytics", async (_req, reply) => {
  const analytics = await getPortfolioAnalytics(db);
  reply.send({ analytics });
});

// ── Leaders ───────────────────────────────────────────────────────────────────

app.get("/leaders", async (_req, reply) => {
  const [activeWallets, allWallets, stats7d, stats30d, statsAll] = await Promise.all([
    getActiveWallets(db),
    getAllWallets(db),
    getAllLeaderStats(db, "7d"),
    getAllLeaderStats(db, "30d"),
    getAllLeaderStats(db, "all"),
  ]);

  // Resolve stats to any known wallet (active or deactivated); only truly
  // orphaned stats with no matching wallet row fall back to null.
  const byWallet = new Map(allWallets.map((w) => [w.id, w]));
  const statsByWallet = new Map<string, Record<string, (typeof stats7d)[number]>>();

  for (const row of [...stats7d, ...stats30d, ...statsAll]) {
    if (!statsByWallet.has(row.walletId)) statsByWallet.set(row.walletId, {});
    statsByWallet.get(row.walletId)![row.window] = row;
  }

  const leaders = activeWallets.map((w) => ({
    wallet: w,
    stats: statsByWallet.get(w.id) ?? {},
  }));

  // Include wallets that have stats but are no longer active.
  const activeIds = new Set(activeWallets.map((w) => w.id));
  for (const [walletId, stats] of statsByWallet) {
    if (!activeIds.has(walletId)) {
      leaders.push({ wallet: byWallet.get(walletId) ?? (null as unknown as (typeof allWallets)[number]), stats });
    }
  }

  reply.send({ leaders });
});

app.post("/leaders/refresh", async (_req, reply) => {
  if (!leaderRefresh) {
    leaderRefresh = runScorerJob(db, manualWeightProvider, rpcClients).finally(() => {
      leaderRefresh = null;
    });
  }

  await leaderRefresh;
  reply.send({ ok: true });
});

// ── Adaptations ───────────────────────────────────────────────────────────────

app.get("/adaptations", async (req, reply) => {
  const q = z.object({ limit: z.coerce.number().int().min(1).max(500).default(50) }).safeParse(req.query);
  if (!q.success) return reply.code(400).send({ error: q.error.message });
  const entries = await getAdaptationLogs(db, q.data.limit);
  reply.send({ entries });
});

// ── Settings ──────────────────────────────────────────────────────────────────

app.get("/settings", async (_req, reply) => {
  const settings = await getAllSettings(db);
  reply.send({ settings });
});

const PatchSettingBody = z.object({
  key: z.string().min(1),
  value: z.unknown(),
});

app.patch("/settings", async (req, reply) => {
  const body = PatchSettingBody.safeParse(req.body);
  if (!body.success) return reply.code(400).send({ error: body.error.message });
  await setSetting(db, body.data.key, body.data.value);
  reply.send({ ok: true });
});

app.delete("/settings/:key", async (req, reply) => {
  const { key } = req.params as { key: string };
  await deleteSetting(db, key);
  reply.send({ ok: true });
});

// ── WebSocket stream ──────────────────────────────────────────────────────────

let streamLastChecked = new Date();

app.get("/stream", { websocket: true }, (socket) => {
  const heartbeat = setInterval(() => {
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify({ type: "ping" }));
    } else {
      clearInterval(heartbeat);
    }
  }, 15_000);

  socket.on("close", () => clearInterval(heartbeat));
});

// Poll Postgres every 2s and broadcast new rows to all WS clients
setInterval(async () => {
  const since = streamLastChecked;
  const now = new Date();
  streamLastChecked = now;

  try {
    const [signals, fills] = await Promise.all([
      getRecentSignals(db, since, 50),
      getRecentFills(db, since, 50),
    ]);

    const messages: string[] = [
      ...signals.map((s) => JSON.stringify({ type: "trade-signal", data: serializeSignal(s) })),
      ...fills.map((f) => JSON.stringify({ type: "paper-fill", data: f })),
    ];

    if (messages.length === 0) return;

    for (const client of app.websocketServer.clients) {
      if (client.readyState === 1 /* OPEN */) {
        for (const msg of messages) client.send(msg);
      }
    }
  } catch {
    // DB may not be up yet; ignore
  }
}, 2_000);

// ── Helpers ───────────────────────────────────────────────────────────────────

function serializeSignal(s: Awaited<ReturnType<typeof getRecentSignals>>[number]) {
  return {
    ...s,
    amountIn: s.amountIn.toString(),
    amountOut: s.amountOut.toString(),
  };
}

// ── Boot ──────────────────────────────────────────────────────────────────────

try {
  await app.listen({ port: apiConfig.API_PORT, host: "0.0.0.0" });
  console.log(`API listening on port ${apiConfig.API_PORT}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
