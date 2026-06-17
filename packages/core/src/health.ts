import type { ChainId } from "./types.js";

export type HealthStatus = "ok" | "degraded" | "down";

/** A chain watcher's connection lifecycle, as seen by the runner. */
export type ConnectionState = "connected" | "reconnecting" | "fallback";

/** Per-chain WS health, captured by ChainWatcher.getHealth() and written into the heartbeat. */
export interface ChainWatcherHealth {
  chain: ChainId;
  connectionState: ConnectionState;
  usingFallback: boolean;
  /** Epoch ms of the last raw event or new head; 0 if nothing seen yet. */
  lastEventAt: number;
  /** Connection attempts that threw since boot. */
  connectFailures: number;
  /** Times a reconnect ran a gap backfill since boot. */
  backfillCount: number;
  walletCount: number;
}

/** The runner's heartbeat payload, persisted as jsonb in runner_health. */
export interface RunnerHealthPayload {
  pid: number;
  /** Process uptime in seconds. */
  uptimeSec: number;
  rssBytes: number;
  heapUsedBytes: number;
  /** Optional build identifier (git sha) for correlating soak runs. */
  version?: string;
  chains: ChainWatcherHealth[];
}

export interface HealthThresholds {
  heartbeatStaleSec: number;
  chainStaleSecByChain: Record<ChainId, number>;
  rssSoftLimitBytes: number;
}

/** Everything the api gathers from Postgres before rolling up a report. */
export interface HealthInput {
  /** True if `select 1` succeeded. */
  dbReachable: boolean;
  /** The most recent heartbeat, or null if none has been written. */
  heartbeat: { ts: number; payload: RunnerHealthPayload } | null;
  /** Per-chain `chain_state.updated_at` epoch ms; missing chains absent from the map. */
  chainStateUpdatedAt: Partial<Record<ChainId, number>>;
}

export interface HealthCheck {
  name: string;
  status: HealthStatus;
  detail?: string;
}

export interface HealthReport {
  status: HealthStatus;
  checks: HealthCheck[];
}

const STATUS_RANK: Record<HealthStatus, number> = { ok: 0, degraded: 1, down: 2 };

function worst(a: HealthStatus, b: HealthStatus): HealthStatus {
  return STATUS_RANK[a] >= STATUS_RANK[b] ? a : b;
}

/**
 * Roll a set of Postgres-sourced observations into a single health report.
 * Pure: all time-relative judgments use the passed `now` (epoch ms). The endpoint
 * status is the worst of the individual checks.
 */
export function deriveHealth(
  input: HealthInput,
  now: number,
  thresholds: HealthThresholds,
): HealthReport {
  const checks: HealthCheck[] = [];

  checks.push(
    input.dbReachable
      ? { name: "database", status: "ok" }
      : { name: "database", status: "down", detail: "select 1 failed" },
  );

  if (input.heartbeat === null) {
    checks.push({ name: "runner", status: "down", detail: "no heartbeat written" });
  } else {
    const ageSec = (now - input.heartbeat.ts) / 1000;
    if (ageSec > thresholds.heartbeatStaleSec) {
      checks.push({
        name: "runner",
        status: "down",
        detail: `heartbeat ${ageSec.toFixed(0)}s old (limit ${thresholds.heartbeatStaleSec}s)`,
      });
    } else {
      checks.push({ name: "runner", status: "ok", detail: `heartbeat ${ageSec.toFixed(0)}s old` });
    }

    const { payload } = input.heartbeat;

    if (payload.rssBytes > thresholds.rssSoftLimitBytes) {
      checks.push({
        name: "memory",
        status: "degraded",
        detail: `rss ${mb(payload.rssBytes)}MB over ${mb(thresholds.rssSoftLimitBytes)}MB`,
      });
    } else {
      checks.push({ name: "memory", status: "ok", detail: `rss ${mb(payload.rssBytes)}MB` });
    }

    for (const chain of payload.chains) {
      if (chain.connectionState !== "connected" || chain.usingFallback) {
        checks.push({
          name: `ws:${chain.chain}`,
          status: "degraded",
          detail: chain.usingFallback ? "on fallback endpoint" : chain.connectionState,
        });
      } else {
        checks.push({ name: `ws:${chain.chain}`, status: "ok" });
      }
    }
  }

  for (const [chain, limitSec] of Object.entries(thresholds.chainStaleSecByChain) as [
    ChainId,
    number,
  ][]) {
    const updatedAt = input.chainStateUpdatedAt[chain];
    if (updatedAt === undefined) {
      // No chain_state row yet (fresh DB / pre-first-block) — not a fault on its own.
      continue;
    }
    const ageSec = (now - updatedAt) / 1000;
    if (ageSec > limitSec) {
      checks.push({
        name: `chain:${chain}`,
        status: "degraded",
        detail: `last block ${ageSec.toFixed(0)}s ago (limit ${limitSec}s)`,
      });
    } else {
      checks.push({ name: `chain:${chain}`, status: "ok" });
    }
  }

  const status = checks.reduce<HealthStatus>((acc, c) => worst(acc, c.status), "ok");
  return { status, checks };
}

function mb(bytes: number): number {
  return Math.round(bytes / (1024 * 1024));
}
