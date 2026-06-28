import { config, createLogger, type Config } from "@tradebot/core";
import {
  countActivePolygonLeaders,
  getAllWallets,
  getDiscoveryState,
  getProspect,
  getRecentlyRejected,
  getRetractableAutoLeaders,
  insertWallet,
  setDiscoveryState,
  setWalletActive,
  upsertProspectEvaluation,
} from "@tradebot/store";
import {
  createLeaderboardNominator,
  evaluateProspect,
  type Nominator,
  type ProspectEvaluationSnapshot,
} from "@tradebot/ingest";

const logger = createLogger("runner:prospect-discovery");

type RunnerDb = Parameters<typeof getDiscoveryState>[0];

type DiscoveryConfig = Pick<
  Config,
  | "PROSPECT_DISCOVERY_ENABLED"
  | "PROSPECT_DISCOVERY_INTERVAL_MS"
  | "PROSPECT_LEADERBOARD_WINDOW"
  | "PROSPECT_CORROBORATE_ALL"
  | "PROSPECT_MIN_PNL_USD"
  | "PROSPECT_MIN_PNL_PER_VOL"
  | "PROSPECT_MIN_TRADES"
  | "PROSPECT_RECENCY_DAYS"
  | "PROSPECT_MAX_LEADERS"
  | "PROSPECT_MAX_PROMOTIONS_PER_CYCLE"
  | "PROSPECT_REJECT_COOLDOWN_DAYS"
  | "POLYMARKET_DATA_API_URL"
>;

export interface ProspectDiscoveryJobOptions {
  intervalMs?: number | undefined;
  nominator?: Nominator | undefined;
  fetchImpl?: typeof fetch | undefined;
  now?: () => number;
  config?: DiscoveryConfig | undefined;
  httpTimeoutMs?: number | undefined;
}

const DAY_MS = 86_400_000;
const DEFAULT_HTTP_TIMEOUT_MS = 15_000;

export function startProspectDiscoveryJob(
  db: RunnerDb,
  opts: ProspectDiscoveryJobOptions = {},
): { stop: () => void } {
  const jobConfig = opts.config ?? config;
  const intervalMs = opts.intervalMs ?? jobConfig.PROSPECT_DISCOVERY_INTERVAL_MS;
  const now = opts.now ?? Date.now;
  const fetchImpl = withTimeout(opts.fetchImpl ?? fetch, opts.httpTimeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS);
  const nominator = opts.nominator ?? createLeaderboardNominator({
    baseUrl: jobConfig.POLYMARKET_DATA_API_URL,
    window: jobConfig.PROSPECT_LEADERBOARD_WINDOW,
    corroborateAll: jobConfig.PROSPECT_CORROBORATE_ALL,
    fetchImpl,
  });
  let running = false;

  const run = () => {
    if (running) return;
    if (!jobConfig.PROSPECT_DISCOVERY_ENABLED) return;
    running = true;
    void runDiscoveryCycle(db, { config: jobConfig, nominator, fetchImpl, now })
      .catch((err: unknown) => {
        logger.error({ err }, "prospect discovery failed");
      })
      .finally(() => {
        running = false;
      });
  };

  run();
  const timer = setInterval(run, intervalMs);
  return { stop: () => clearInterval(timer) };
}

interface RunDiscoveryCycleOptions {
  config: DiscoveryConfig;
  nominator: Nominator;
  fetchImpl: typeof fetch;
  now: () => number;
}

async function runDiscoveryCycle(db: RunnerDb, opts: RunDiscoveryCycleOptions): Promise<void> {
  const startedAtMs = opts.now();
  const state = await getDiscoveryState(db);
  if (state?.lastRunAt && startedAtMs - state.lastRunAt.getTime() < opts.config.PROSPECT_DISCOVERY_INTERVAL_MS) {
    return;
  }

  try {
    const nominations = await opts.nominator.nominate();
    const wallets = await getAllWallets(db);
    const existingPolygonAddresses = new Set(
      wallets.filter((wallet) => wallet.chain === "polygon").map((wallet) => wallet.address.toLowerCase()),
    );
    const cooldownSince = new Date(startedAtMs - opts.config.PROSPECT_REJECT_COOLDOWN_DAYS * DAY_MS);
    const recentlyRejected = new Set((await getRecentlyRejected(db, cooldownSince)).map((addr) => addr.toLowerCase()));
    const candidates = nominations.filter(
      (nomination) =>
        !existingPolygonAddresses.has(nomination.address.toLowerCase()) &&
        !recentlyRejected.has(nomination.address.toLowerCase()),
    );

    const evaluations: ProspectEvaluationSnapshot[] = [];
    for (const nomination of candidates) {
      const evaluation = await evaluateProspect(nomination, {
        baseUrl: opts.config.POLYMARKET_DATA_API_URL,
        fetchImpl: opts.fetchImpl,
        minPnlUsd: opts.config.PROSPECT_MIN_PNL_USD,
        minPnlPerVol: opts.config.PROSPECT_MIN_PNL_PER_VOL,
        minTrades: opts.config.PROSPECT_MIN_TRADES,
        recencyDays: opts.config.PROSPECT_RECENCY_DAYS,
        nowMs: startedAtMs,
      });
      evaluations.push(evaluation);
      await upsertProspectEvaluation(db, evaluation);
    }

    const qualifiers = evaluations
      .filter((evaluation) => evaluation.verdict === "promoted")
      .sort((a, b) => b.score - a.score);
    let activePolygonLeaders = await countActivePolygonLeaders(db);
    let capacity = Math.max(0, opts.config.PROSPECT_MAX_LEADERS - activePolygonLeaders);
    const promotionTarget = Math.min(qualifiers.length, opts.config.PROSPECT_MAX_PROMOTIONS_PER_CYCLE);
    let retracted = 0;

    if (capacity < promotionTarget) {
      retracted = await retractWeakAutoLeaders(db, qualifiers, capacity, promotionTarget, opts.config);
      activePolygonLeaders -= retracted;
      capacity = Math.max(0, opts.config.PROSPECT_MAX_LEADERS - activePolygonLeaders);
    }

    let promoted = 0;
    for (const evaluation of qualifiers.slice(0, Math.min(capacity, opts.config.PROSPECT_MAX_PROMOTIONS_PER_CYCLE))) {
      const wallet = await insertWallet(db, {
        chain: "polygon",
        address: evaluation.address,
        label: evaluation.userName ?? evaluation.address,
        active: true,
        autoCopy: false,
        autoAdded: true,
      });
      promoted++;
      await upsertProspectEvaluation(db, { ...evaluation, promotedWalletId: wallet.id });
    }

    await setDiscoveryState(db, {
      lastRunAt: new Date(startedAtMs),
      lastError: null,
      promotedLastRun: promoted,
    });
    logger.info({
      nominated: nominations.length,
      evaluated: evaluations.length,
      promoted,
      retracted,
      rejected: evaluations.length - qualifiers.length,
    }, "prospect discovery cycle complete");
  } catch (err) {
    await setDiscoveryState(db, { lastError: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}

async function retractWeakAutoLeaders(
  db: RunnerDb,
  qualifiers: ProspectEvaluationSnapshot[],
  initialCapacity: number,
  promotionTarget: number,
  jobConfig: DiscoveryConfig,
): Promise<number> {
  const retractable = await getRetractableAutoLeaders(db);
  const withScores = await Promise.all(
    retractable.map(async (wallet) => {
      const prospect = await getProspect(db, wallet.address.toLowerCase());
      return { wallet, score: prospect?.score ?? null };
    }),
  );
  withScores.sort((a, b) => (a.score ?? Number.NEGATIVE_INFINITY) - (b.score ?? Number.NEGATIVE_INFINITY));

  let capacity = initialCapacity;
  let retracted = 0;
  for (const candidate of withScores) {
    if (capacity >= promotionTarget) break;
    const waitingQualifier = qualifiers[capacity];
    if (!waitingQualifier) break;
    const score = candidate.score ?? Number.NEGATIVE_INFINITY;
    if (score >= jobConfig.PROSPECT_MIN_PNL_PER_VOL && score >= waitingQualifier.score) continue;
    await setWalletActive(db, candidate.wallet.id, false);
    retracted++;
    capacity++;
  }
  return retracted;
}

function withTimeout(fetchImpl: typeof fetch, timeoutMs: number): typeof fetch {
  return async (input, init) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchImpl(input, { ...init, signal: init?.signal ?? controller.signal });
    } finally {
      clearTimeout(timer);
    }
  };
}
