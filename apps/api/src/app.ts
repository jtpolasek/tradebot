import Fastify from "fastify";
import wsPlugin from "@fastify/websocket";
import { z } from "zod";
import { BrainWeightProvider, runScorerJob } from "@tradebot/brain";
import {
  config,
  normalizeAddressInput,
  deriveHealth,
  estimateCuBudget,
  isEvmChain,
  type HealthInput,
  type HealthThresholds,
} from "@tradebot/core";
import {
  getAllWallets,
  getActiveWallets,
  insertWallet,
  setWalletActive,
  setWalletAutoCopy,
  markWalletHumanTouched,
  getWalletById,
  getRecentSignals,
  getCandidateSignals,
  getCandidateTriageSummary,
  getSignalById,
  setCandidateReviewStatus,
  transitionCandidateReviewStatus,
  dismissPendingCandidates,
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
  getRunnerHealth,
  getChainStatesUpdatedAt,
  getPolymarketPollHealth,
  getPolymarketLeaders,
  getProspects,
  getDiscoveryState,
  type CandidateReviewStatus,
  type CandidateSignalFilters,
  type Db,
} from "@tradebot/store";
import type { ApiConfig } from "./config.js";

type RpcClientsLike = Parameters<typeof runScorerJob>[2];

export type CreateApiAppOptions = {
  db: Db;
  apiConfig: ApiConfig;
  healthThresholds: HealthThresholds;
  rpcClients?: RpcClientsLike;
  manualWeightProvider?: BrainWeightProvider;
  enableStreamPolling?: boolean;
};

const PostWalletBody = z.object({
  chain: z.enum(["eth", "base", "polygon"]),
  address: z.string().min(1),
  label: z.string().min(1),
});

const PatchWalletBody = z.object({
  active: z.boolean().optional(),
  autoCopy: z.boolean().optional(),
}).refine((b) => b.active !== undefined || b.autoCopy !== undefined, {
  message: "Provide at least one of active or autoCopy",
});

const SinceQuery = z.object({
  since: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

const CandidateQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  chain: z.enum(["eth", "base", "polygon"]).optional(),
  venue: z.string().trim().min(1).max(64).optional(),
  status: z.enum(["open", "pending", "copy-requested", "copying", "copy-failed", "copied", "dismissed"]).default("open"),
});

const DismissPendingQuery = z.object({
  chain: z.enum(["eth", "base", "polygon"]).optional(),
  venue: z.string().trim().min(1).max(64).optional(),
});

const ProspectsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export async function createApiApp(options: CreateApiAppOptions) {
  const {
    db,
    apiConfig,
    healthThresholds,
    rpcClients,
    manualWeightProvider = new BrainWeightProvider(),
    enableStreamPolling = true,
  } = options;

  let leaderRefresh: Promise<void> | null = null;
  let streamLastChecked = new Date();
  let streamTimer: ReturnType<typeof setInterval> | null = null;

  const app = Fastify({ logger: { level: apiConfig.LOG_LEVEL } });
  await app.register(wsPlugin);

  app.addHook("preHandler", async (req, reply) => {
    if (req.method === "OPTIONS") return;
    if (req.url.split("?")[0] === "/health") return;
    if (req.headers["x-api-key"] !== apiConfig.API_KEY) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
  });

  app.addHook("onSend", async (req, reply) => {
    const origin = req.headers["origin"];
    if (origin === apiConfig.CORS_ORIGIN) {
      reply.header("Access-Control-Allow-Origin", apiConfig.CORS_ORIGIN);
      reply.header("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
      reply.header("Access-Control-Allow-Headers", "Content-Type,X-Api-Key");
    }
  });

  app.options("*", async (_req, reply) => reply.send());

  app.get("/wallets", async (_req, reply) => {
    const walletRows = await getAllWallets(db);
    reply.send({ wallets: walletRows });
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

  app.patch("/wallets/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = PatchWalletBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.message });
    const wallet = await getWalletById(db, id);
    if (!wallet) return reply.code(404).send({ error: "Wallet not found" });
    if (body.data.active !== undefined) await setWalletActive(db, id, body.data.active);
    if (body.data.autoCopy !== undefined) await setWalletAutoCopy(db, id, body.data.autoCopy);
    // A human acted on this leader → sacrosanct: the discovery retraction sweep must never touch it.
    await markWalletHumanTouched(db, id);
    const updated = await getWalletById(db, id);
    reply.send({ wallet: updated });
  });

  app.delete("/wallets/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const wallet = await getWalletById(db, id);
    if (!wallet) return reply.code(404).send({ error: "Wallet not found" });
    // A human deleting (un-watching) a leader is an explicit human action → sacrosanct.
    await markWalletHumanTouched(db, id);
    await setWalletActive(db, id, false);
    reply.send({ ok: true });
  });

  app.get("/signals", async (req, reply) => {
    const q = SinceQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: q.error.message });
    const since = q.data.since ? new Date(q.data.since) : new Date(Date.now() - 24 * 60 * 60 * 1000);
    const signals = await getRecentSignals(db, since, q.data.limit);
    reply.send({ signals: signals.map(serializeSignal) });
  });

  app.get("/candidates", async (req, reply) => {
    const q = CandidateQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: q.error.message });
    const filters: CandidateSignalFilters = { status: q.data.status };
    if (q.data.chain) filters.chain = q.data.chain;
    if (q.data.venue) filters.venue = q.data.venue;
    const signals = await getCandidateSignals(db, q.data.limit, filters);
    reply.send({ candidates: signals.map(serializeSignal) });
  });

  app.get("/candidates/summary", async (_req, reply) => {
    const summary = await getCandidateTriageSummary(db);
    reply.send({ summary });
  });

  app.post("/candidates/dismiss-pending", async (req, reply) => {
    const q = DismissPendingQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: q.error.message });
    const filters: { chain?: "eth" | "base" | "polygon"; venue?: string } = {};
    if (q.data.chain) filters.chain = q.data.chain;
    if (q.data.venue) filters.venue = q.data.venue;
    const dismissed = await dismissPendingCandidates(db, filters);
    reply.send({ dismissed });
  });

  app.post("/candidates/:id/copy", async (req, reply) => {
    const { id } = req.params as { id: string };
    const signal = await getSignalById(db, id);
    if (!signal || signal.decodeStatus !== "candidate") {
      return reply.code(404).send({ error: "Candidate not found" });
    }
    if (!isEvmChain(signal.chain)) {
      return reply.code(400).send({ error: `Copy is not supported for ${signal.venue} (${signal.chain}) candidates in the manual review flow` });
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

  app.post("/candidates/:id/reset", async (req, reply) => {
    const { id } = req.params as { id: string };
    const signal = await getSignalById(db, id);
    if (!signal || signal.decodeStatus !== "candidate") {
      return reply.code(404).send({ error: "Candidate not found" });
    }
    if (!isRecoverableCandidateStatus(signal.reviewStatus)) {
      return reply.code(409).send({ error: `Candidate is ${signal.reviewStatus ?? "pending"}; only queued candidates can be reset` });
    }
    const updated = await transitionCandidateReviewStatus(db, id, [signal.reviewStatus], "pending");
    if (!updated) return reply.code(409).send({ error: "Candidate status changed; refresh and retry" });
    reply.send({ candidate: serializeSignal(updated) });
  });

  app.post("/candidates/:id/fail", async (req, reply) => {
    const { id } = req.params as { id: string };
    const signal = await getSignalById(db, id);
    if (!signal || signal.decodeStatus !== "candidate") {
      return reply.code(404).send({ error: "Candidate not found" });
    }
    if (!isRecoverableCandidateStatus(signal.reviewStatus)) {
      return reply.code(409).send({ error: `Candidate is ${signal.reviewStatus ?? "pending"}; only queued candidates can be marked failed` });
    }
    const updated = await transitionCandidateReviewStatus(db, id, [signal.reviewStatus], "copy-failed");
    if (!updated) return reply.code(409).send({ error: "Candidate status changed; refresh and retry" });
    reply.send({ candidate: serializeSignal(updated) });
  });

  app.get("/fills", async (req, reply) => {
    const q = SinceQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: q.error.message });
    const since = q.data.since ? new Date(q.data.since) : new Date(Date.now() - 24 * 60 * 60 * 1000);
    const fills = await getRecentFills(db, since, q.data.limit);
    reply.send({ fills });
  });

  app.get("/portfolio", async (_req, reply) => {
    const [snapshot, positions, snapshots] = await Promise.all([
      latestSnapshot(db),
      getOpenPositions(db),
      getRecentSnapshots(db, 288),
    ]);

    const positionsWithMark = await Promise.all(
      positions.map(async (p) => {
        const [mark, sourceWallet] = await Promise.all([
          latestMark(db, p.chain, p.tokenAddress),
          p.sourceWalletId ? getWalletById(db, p.sourceWalletId) : Promise.resolve(null),
        ]);
        return { ...p, currentPriceUsd: mark?.priceUsd ?? null, sourceWallet };
      })
    );

    reply.send({ snapshot, positions: positionsWithMark, snapshots });
  });

  app.get("/analytics", async (_req, reply) => {
    const analytics = await getPortfolioAnalytics(db);
    reply.send({ analytics });
  });

  app.get("/leaders", async (_req, reply) => {
    const [activeWallets, allWallets, stats7d, stats30d, statsAll] = await Promise.all([
      getActiveWallets(db),
      getAllWallets(db),
      getAllLeaderStats(db, "7d"),
      getAllLeaderStats(db, "30d"),
      getAllLeaderStats(db, "all"),
    ]);

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

    const activeIds = new Set(activeWallets.map((w) => w.id));
    for (const [walletId, stats] of statsByWallet) {
      if (!activeIds.has(walletId)) {
        leaders.push({ wallet: byWallet.get(walletId) ?? (null as unknown as (typeof allWallets)[number]), stats });
      }
    }

    reply.send({ leaders });
  });

  app.get("/polymarket-leaders", async (_req, reply) => {
    const leaders = await getPolymarketLeaders(db);
    reply.send({ leaders });
  });

  app.get("/prospects", async (req, reply) => {
    const q = ProspectsQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: q.error.message });
    const prospects = await getProspects(db, q.data.limit);
    reply.send({ prospects });
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

  app.get("/adaptations", async (req, reply) => {
    const q = z.object({ limit: z.coerce.number().int().min(1).max(500).default(50) }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: q.error.message });
    const entries = await getAdaptationLogs(db, q.data.limit);
    reply.send({ entries });
  });

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

  async function gatherHealthInput(): Promise<HealthInput> {
    try {
      const [heartbeat, chainStateUpdatedAt] = await Promise.all([
        getRunnerHealth(db),
        getChainStatesUpdatedAt(db),
      ]);
      const polymarketPolls = await getPolymarketPollHealth(db).catch((err: unknown) => {
        app.log.warn({ err }, "polymarket poll health read failed");
        return [];
      });
      // Optional read: isolate it like polymarketPolls so a transient failure (lock, pre-migration
      // table) can't flip the whole runner to dbReachable:false → 'down'/503 (CODE_REVIEW PD.6).
      const discoveryState = await getDiscoveryState(db).catch((err: unknown) => {
        app.log.warn({ err }, "discovery state read failed");
        return null;
      });
      const prospectDiscovery = discoveryState ? {
        lastRunAt: discoveryState.lastRunAt?.getTime() ?? null,
        lastError: discoveryState.lastError,
        promotedLastRun: discoveryState.promotedLastRun,
      } : null;
      return {
        dbReachable: true,
        heartbeat,
        chainStateUpdatedAt,
        polymarketPolls,
        prospectDiscovery,
        prospectDiscoveryEnabled: config.PROSPECT_DISCOVERY_ENABLED,
      };
    } catch {
      return { dbReachable: false, heartbeat: null, chainStateUpdatedAt: {}, polymarketPolls: [], prospectDiscovery: null };
    }
  }

  app.get("/health", async (_req, reply) => {
    const report = deriveHealth(await gatherHealthInput(), Date.now(), healthThresholds);
    reply.code(report.status === "down" ? 503 : 200).send({ status: report.status });
  });

  app.get("/metrics", async (_req, reply) => {
    const input = await gatherHealthInput();
    const report = deriveHealth(input, Date.now(), healthThresholds);
    const cuBudget = (input.heartbeat?.payload.chains ?? [])
      .filter((c) => isEvmChain(c.chain))
      .map((c) => estimateCuBudget({ chain: isEvmChain(c.chain) ? c.chain : "eth", walletCount: c.walletCount }));
    reply.send({ status: report.status, checks: report.checks, cuBudget, input });
  });

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

  if (enableStreamPolling) {
    streamTimer = setInterval(async () => {
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
          if (client.readyState === 1) {
            for (const msg of messages) client.send(msg);
          }
        }
      } catch {
        // DB may not be up yet; ignore.
      }
    }, 2_000);

    app.addHook("onClose", async () => {
      if (streamTimer) {
        clearInterval(streamTimer);
        streamTimer = null;
      }
    });
  }

  return app;
}

function serializeSignal(s: Awaited<ReturnType<typeof getRecentSignals>>[number]) {
  return {
    ...s,
    amountIn: s.amountIn.toString(),
    amountOut: s.amountOut.toString(),
  };
}

function isRecoverableCandidateStatus(
  status: CandidateReviewStatus | null | undefined
): status is Extract<CandidateReviewStatus, "copy-requested" | "copying"> {
  return status === "copy-requested" || status === "copying";
}
