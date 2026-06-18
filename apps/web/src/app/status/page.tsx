"use client";

import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { apiFetch, timeAgo } from "@/lib/api";

type HealthStatus = "ok" | "degraded" | "down";

type HealthCheck = { name: string; status: HealthStatus; detail?: string };

type ChainHealth = {
  chain: string;
  connectionState: "connected" | "reconnecting" | "fallback";
  usingFallback: boolean;
  lastEventAt: number;
  connectFailures: number;
  backfillCount: number;
  walletCount: number;
};

type CuBudget = {
  chain: string;
  walletCount: number;
  subscriptionCount: number;
  cuPerTrade: number;
  estTradesPerDay: number;
  estCuPerDay: number;
  estCuPerMonth: number;
  backfillCuPerReconnect: number;
  freeTierMonthlyPct: number;
};

type Metrics = {
  status: HealthStatus;
  checks: HealthCheck[];
  cuBudget: CuBudget[];
  input: {
    dbReachable: boolean;
    heartbeat: {
      ts: number;
      payload: {
        pid: number;
        uptimeSec: number;
        rssBytes: number;
        heapUsedBytes: number;
        version?: string;
        chains: ChainHealth[];
      };
    } | null;
    chainStateUpdatedAt: Record<string, number>;
  };
};

const STATUS_PILL: Record<HealthStatus, string> = { ok: "good", degraded: "warn", down: "bad" };
const mb = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`;
const compact = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : `${Math.round(n)}`;

function uptime(sec: number): string {
  if (sec < 60) return `${Math.floor(sec)}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
  return `${Math.floor(sec / 86400)}d ${Math.floor((sec % 86400) / 3600)}h`;
}

function freeTierTone(pct: number): string {
  if (pct >= 80) return "bad";
  if (pct >= 50) return "warn";
  return "good";
}

export default function StatusPage() {
  const [data, setData] = useState<Metrics | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  async function load() {
    try {
      const m = await apiFetch<Metrics>("/metrics");
      setData(m);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load metrics");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, []);

  const hb = data?.input.heartbeat;
  const payload = hb?.payload;

  return (
    <div className="stack">
      <div className="page-header">
        <h1>
          System Status{" "}
          {data && <span className={`pill ${STATUS_PILL[data.status]}`}>{data.status}</span>}
        </h1>
        <button className="button secondary" onClick={() => void load()} disabled={loading}>
          <RefreshCw size={15} /> Refresh
        </button>
      </div>

      {error && <div className="alert">{error}</div>}

      {payload && (
        <div className="grid cols-4">
          {[
            { label: "Heartbeat", value: hb ? timeAgo(hb.ts) : "—" },
            { label: "Uptime", value: uptime(payload.uptimeSec) },
            { label: "RSS", value: mb(payload.rssBytes) },
            { label: "Version", value: payload.version ?? "—" },
          ].map(({ label, value }) => (
            <div key={label} className="panel">
              <div className="metric-label">{label}</div>
              <div className="metric-value">{value}</div>
            </div>
          ))}
        </div>
      )}

      {data && (
        <div className="panel">
          <h2 style={{ marginBottom: 10 }}>Checks</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Check</th><th>Status</th><th>Detail</th></tr>
              </thead>
              <tbody>
                {data.checks.map((c) => (
                  <tr key={c.name}>
                    <td>{c.name}</td>
                    <td><span className={`pill ${STATUS_PILL[c.status]}`}>{c.status}</span></td>
                    <td className="subtle">{c.detail ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {payload && payload.chains.length > 0 && (
        <div className="panel">
          <h2 style={{ marginBottom: 10 }}>Chain watchers</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Chain</th><th>Connection</th><th>Wallets</th>
                  <th>Last event</th><th>Connect failures</th><th>Backfills</th>
                </tr>
              </thead>
              <tbody>
                {payload.chains.map((c) => (
                  <tr key={c.chain}>
                    <td><span className="pill">{c.chain}</span></td>
                    <td>
                      <span className={`pill ${c.connectionState === "connected" ? "good" : c.connectionState === "fallback" ? "warn" : "bad"}`}>
                        {c.connectionState}{c.usingFallback ? " (fallback)" : ""}
                      </span>
                    </td>
                    <td>{c.walletCount}</td>
                    <td className="subtle">{c.lastEventAt ? timeAgo(c.lastEventAt) : "—"}</td>
                    <td className={c.connectFailures > 0 ? "warn" : ""}>{c.connectFailures}</td>
                    <td>{c.backfillCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {data && data.cuBudget.length > 0 && (
        <div className="panel">
          <h2 style={{ marginBottom: 4 }}>Alchemy CU budget</h2>
          <p className="subtle" style={{ marginBottom: 10 }}>
            Approximate, derived from live wallet counts. Tune assumptions in core/cuBudget.ts.
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Chain</th><th>Wallets</th><th>Subscriptions</th>
                  <th>Est. trades/day</th><th>Est. CU/day</th><th>Est. CU/month</th>
                  <th>Backfill CU/reconnect</th><th>Free-tier/mo</th>
                </tr>
              </thead>
              <tbody>
                {data.cuBudget.map((b) => (
                  <tr key={b.chain}>
                    <td><span className="pill">{b.chain}</span></td>
                    <td>{b.walletCount}</td>
                    <td>{b.subscriptionCount}</td>
                    <td>{compact(b.estTradesPerDay)}</td>
                    <td>{compact(b.estCuPerDay)}</td>
                    <td>{compact(b.estCuPerMonth)}</td>
                    <td>{compact(b.backfillCuPerReconnect)}</td>
                    <td>
                      <span className={`pill ${freeTierTone(b.freeTierMonthlyPct)}`}>
                        {b.freeTierMonthlyPct.toFixed(1)}%
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {!loading && !payload && !error && (
        <div className="panel">
          <p className="subtle">No heartbeat yet. Start the runner to populate status.</p>
        </div>
      )}
    </div>
  );
}
