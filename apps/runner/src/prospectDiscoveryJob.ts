import { config, createLogger, type Config } from "@tradebot/core";
import {
  countActivePolygonLeaders,
  getDiscoveryExcludedAddresses,
  getDiscoveryState,
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
  type EvaluateProspectOptions,
  type Nomination,
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
  let clearedOnDisable = false;

  const run = () => {
    if (running) return;
    if (!jobConfig.PROSPECT_DISCOVERY_ENABLED) {
      // A prior run may have left lastError set; clear it once so health doesn't report the disabled
      // feature 'degraded' forever (CODE_REVIEW PD.5). One write, guarded against the interval loop.
      if (!clearedOnDisable) {
        clearedOnDisable = true;
        void setDiscoveryState(db, { lastError: null }).catch((err: unknown) => {
          logger.error({ err }, "failed to clear discovery error on disable");
        });
      }
      return;
    }
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
    const nominationsByAddress = new Map<string, Nomination>(
      nominations.map((nomination) => [nomination.address.toLowerCase(), nomination]),
    );
    // Excludes active leaders and human-touched wallets only — auto-retracted (inactive) wallets
    // remain eligible for re-discovery (CODE_REVIEW PD.2).
    const existingPolygonAddresses = new Set(await getDiscoveryExcludedAddresses(db));
    const cooldownSince = new Date(startedAtMs - opts.config.PROSPECT_REJECT_COOLDOWN_DAYS * DAY_MS);
    const recentlyRejected = new Set((await getRecentlyRejected(db, cooldownSince)).map((addr) => addr.toLowerCase()));
    const candidates = nominations.filter(
      (nomination) =>
        !existingPolygonAddresses.has(nomination.address.toLowerCase()) &&
        !recentlyRejected.has(nomination.address.toLowerCase()),
    );

    const evalOpts: EvaluateProspectOptions = {
      baseUrl: opts.config.POLYMARKET_DATA_API_URL,
      fetchImpl: opts.fetchImpl,
      minPnlUsd: opts.config.PROSPECT_MIN_PNL_USD,
      minPnlPerVol: opts.config.PROSPECT_MIN_PNL_PER_VOL,
      minTrades: opts.config.PROSPECT_MIN_TRADES,
      recencyDays: opts.config.PROSPECT_RECENCY_DAYS,
      nowMs: startedAtMs,
    };

    const evaluations: ProspectEvaluationSnapshot[] = [];
    for (const nomination of candidates) {
      const evaluation = await evaluateProspect(nomination, evalOpts);
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
      retracted = await retractWeakAutoLeaders(db, qualifiers, capacity, promotionTarget, opts.config, {
        nominationsByAddress,
        evalOpts,
      });
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

interface RetractContext {
  nominationsByAddress: Map<string, Nomination>;
  evalOpts: EvaluateProspectOptions;
}

async function retractWeakAutoLeaders(
  db: RunnerDb,
  qualifiers: ProspectEvaluationSnapshot[],
  initialCapacity: number,
  promotionTarget: number,
  jobConfig: DiscoveryConfig,
  ctx: RetractContext,
): Promise<number> {
  const retractable = await getRetractableAutoLeaders(db);
  // Re-evaluate each active auto leader against the *current* leaderboard rather than ranking on the
  // score frozen at promotion time (CODE_REVIEW PD.1). A leader still on the board is re-scored on
  // live data; one that has fallen off entirely has no current nomination → null score → ranked
  // weakest, so a decayed leader is the first to be un-watched. The refreshed snapshot keeps its
  // promotion link (promotedWalletId) so the audit row isn't orphaned.
  const withScores = await Promise.all(
    retractable.map(async (wallet) => {
      const nomination = ctx.nominationsByAddress.get(wallet.address.toLowerCase());
      if (!nomination) return { wallet, score: null as number | null };
      const evaluation = await evaluateProspect(nomination, ctx.evalOpts);
      await upsertProspectEvaluation(db, { ...evaluation, promotedWalletId: wallet.id });
      return { wallet, score: evaluation.score };
    }),
  );
  // Total-order ascending (weakest first); null ranks below any real score. Avoids the NaN that
  // subtracting two -Infinity sentinels produced (CODE_REVIEW PD.7).
  withScores.sort((a, b) => compareScores(a.score, b.score));

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

/** Total-order ascending comparator treating null as lower than any real score. */
function compareScores(a: number | null, b: number | null): number {
  const av = a ?? Number.NEGATIVE_INFINITY;
  const bv = b ?? Number.NEGATIVE_INFINITY;
  if (av < bv) return -1;
  if (av > bv) return 1;
  return 0;
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
