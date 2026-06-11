import { config as loadDotenv } from "dotenv";
import { resolve } from "path";
import { fileURLToPath } from "url";
const __dirname = fileURLToPath(new URL(".", import.meta.url));
loadDotenv({ path: resolve(__dirname, "../../../.env") });

import Fastify from "fastify";
import wsPlugin from "@fastify/websocket";
import { z } from "zod";
import {
  getDb,
  getAllWallets,
  getActiveWallets,
  insertWallet,
  setWalletActive,
  getWalletById,
  getRecentSignals,
  getRecentFills,
  getOpenPositions,
  latestSnapshot,
  getRecentSnapshots,
  getAllLeaderStats,
  getAdaptationLogs,
  getAllSettings,
  setSetting,
  deleteSetting,
  latestMark,
} from "@tradebot/store";

const API_KEY = process.env["API_KEY"] ?? "";
const PORT = Number(process.env["API_PORT"] ?? 3001);
const CORS_ORIGIN = process.env["CORS_ORIGIN"] ?? "http://localhost:3000";

if (!API_KEY) {
  console.warn("[api] WARNING: API_KEY is not set — all requests will be accepted. Set API_KEY in .env.");
}

const db = getDb();

const app = Fastify({ logger: { level: process.env["LOG_LEVEL"] ?? "info" } });
await app.register(wsPlugin);

// Auth: always enforce when API_KEY is set; warn-only when unset (dev convenience)
app.addHook("preHandler", async (req, reply) => {
  if (req.method === "OPTIONS") return;
  if (API_KEY && req.headers["x-api-key"] !== API_KEY) {
    return reply.code(401).send({ error: "Unauthorized" });
  }
});

// CORS: restrict to configured dashboard origin
app.addHook("onSend", async (req, reply) => {
  const origin = req.headers["origin"];
  if (origin === CORS_ORIGIN) {
    reply.header("Access-Control-Allow-Origin", CORS_ORIGIN);
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
  const wallet = await insertWallet(db, {
    chain: body.data.chain,
    address: body.data.address.toLowerCase(),
    label: body.data.label,
    active: true,
  });
  reply.code(201).send({ wallet });
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

// ── Leaders ───────────────────────────────────────────────────────────────────

app.get("/leaders", async (_req, reply) => {
  const [wallets, stats7d, stats30d, statsAll] = await Promise.all([
    getActiveWallets(db),
    getAllLeaderStats(db, "7d"),
    getAllLeaderStats(db, "30d"),
    getAllLeaderStats(db, "all"),
  ]);

  const byWallet = new Map(wallets.map((w) => [w.id, w]));
  const statsByWallet = new Map<string, Record<string, (typeof stats7d)[number]>>();

  for (const row of [...stats7d, ...stats30d, ...statsAll]) {
    if (!statsByWallet.has(row.walletId)) statsByWallet.set(row.walletId, {});
    statsByWallet.get(row.walletId)![row.window] = row;
  }

  const leaders = wallets.map((w) => ({
    wallet: w,
    stats: statsByWallet.get(w.id) ?? {},
  }));

  // Include wallets that have stats but may not be "active" any more
  for (const [walletId, stats] of statsByWallet) {
    if (!byWallet.has(walletId)) {
      leaders.push({ wallet: null as unknown as (typeof wallets)[number], stats });
    }
  }

  reply.send({ leaders });
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
  await app.listen({ port: PORT, host: "0.0.0.0" });
  console.log(`API listening on port ${PORT}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
