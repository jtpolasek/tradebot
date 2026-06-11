"use client";

import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { apiFetch, formatUsd, formatPct, shortAddr, timeAgo } from "@/lib/api";

type Wallet = { id: string; chain: string; address: string; label: string; active: boolean; addedAt: string };
type StatRow = {
  walletId: string; window: string; trades: number;
  winRate: number | null; avgReturnPct: number | null; medianHoldMinutes: number | null;
  realizedPnlUsd: number | null; maxDrawdownPct: number | null;
  score: number | null; weight: number; updatedAt: string;
};
type Leader = { wallet: Wallet; stats: Record<string, StatRow> };
type LeadersData = { leaders: Leader[] };

const WINDOWS = ["7d", "30d", "all"] as const;

export default function LeadersPage() {
  const [data, setData] = useState<LeadersData | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [activeWindow, setActiveWindow] = useState<(typeof WINDOWS)[number]>("7d");

  async function load() {
    try {
      const d = await apiFetch<LeadersData>("/leaders");
      setData(d);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load leaders");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  const leaders = data?.leaders ?? [];
  const sorted = [...leaders].sort((a, b) => {
    const sa = a.stats[activeWindow]?.score ?? -99;
    const sb = b.stats[activeWindow]?.score ?? -99;
    return sb - sa;
  });

  function scoreClass(score: number | null) {
    if (score === null) return "";
    if (score > 0.5) return "good";
    if (score < -0.5) return "bad";
    return "";
  }

  function weightClass(w: number) {
    if (w >= 1.2) return "good";
    if (w <= 0.1) return "bad";
    return "";
  }

  return (
    <div className="stack">
      <div className="page-header">
        <h1>Leaders</h1>
        <button className="button secondary" onClick={() => void load()} disabled={loading}>
          <RefreshCw size={15} /> Refresh
        </button>
      </div>

      {error && <div className="alert">{error}</div>}

      <div className="panel">
        <div className="row" style={{ marginBottom: 12 }}>
          <div style={{ display: "flex", gap: 8 }}>
            {WINDOWS.map((w) => (
              <button
                key={w}
                className={`button ${activeWindow === w ? "" : "secondary"}`}
                onClick={() => setActiveWindow(w)}
                style={{ minHeight: 32, padding: "4px 12px", fontSize: 12 }}
              >
                {w}
              </button>
            ))}
          </div>
          <span className="pill">{leaders.length} leaders</span>
        </div>

        {sorted.length === 0 && !loading ? (
          <p className="subtle">No leader stats yet. Scoring runs hourly after signals are collected.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Wallet</th>
                  <th>Chain</th>
                  <th>Score</th>
                  <th>Weight</th>
                  <th>Trades</th>
                  <th>Win rate</th>
                  <th>Avg return</th>
                  <th>Realized P&L</th>
                  <th>Max DD</th>
                  <th>Hold</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((l) => {
                  const s = l.stats[activeWindow];
                  return (
                    <tr key={l.wallet?.id ?? l.wallet?.address}>
                      <td>
                        <div style={{ fontWeight: 700, fontSize: "0.82rem" }}>{l.wallet?.label ?? "—"}</div>
                        <div className="mono subtle">{l.wallet ? shortAddr(l.wallet.address) : "—"}</div>
                      </td>
                      <td><span className="pill">{l.wallet?.chain ?? "—"}</span></td>
                      <td className={scoreClass(s?.score ?? null)}>
                        {s?.score !== null && s?.score !== undefined ? s.score.toFixed(2) : "—"}
                      </td>
                      <td>
                        <span className={`pill ${weightClass(s?.weight ?? 1)}`}>
                          {s?.weight !== undefined ? s.weight.toFixed(2) : "—"}
                        </span>
                      </td>
                      <td>{s?.trades ?? "—"}</td>
                      <td>{s ? formatPct(s.winRate) : "—"}</td>
                      <td>{s ? formatPct(s.avgReturnPct) : "—"}</td>
                      <td className={s?.realizedPnlUsd !== null && s?.realizedPnlUsd !== undefined ? (s.realizedPnlUsd >= 0 ? "good" : "bad") : ""}>
                        {s?.realizedPnlUsd !== null && s?.realizedPnlUsd !== undefined ? formatUsd(s.realizedPnlUsd) : "—"}
                      </td>
                      <td>{s?.maxDrawdownPct !== null && s?.maxDrawdownPct !== undefined ? formatPct(s.maxDrawdownPct) : "—"}</td>
                      <td>{s?.medianHoldMinutes !== null && s?.medianHoldMinutes !== undefined ? `${s.medianHoldMinutes.toFixed(0)}m` : "—"}</td>
                      <td>{s ? timeAgo(s.updatedAt) : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
