"use client";

import { useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { WalletLink } from "@/components/WalletLink";
import { apiFetch, formatUsd, timeAgo } from "@/lib/api";

type ProspectVerdict = "promoted" | "rejected";

type Prospect = {
  address: string;
  source: string;
  userName: string | null;
  xUsername: string | null;
  pnlUsd: number | null;
  volUsd: number | null;
  pnlPerVol: number | null;
  tradeCount: number | null;
  lastTradeTs: number | null;
  score: number | null;
  verdict: ProspectVerdict;
  rejectReason: string | null;
  firstSeenAt: string;
  lastEvaluatedAt: string;
  promotedWalletId: string | null;
};

type ProspectsData = { prospects: Prospect[] };

function verdictClass(verdict: ProspectVerdict): string {
  return verdict === "promoted" ? "good" : "bad";
}

function ratio(n: number | null): string {
  if (n === null) return "-";
  return n.toFixed(3);
}

function numberCell(n: number | null): string {
  if (n === null) return "-";
  return n.toLocaleString("en-US");
}

function lastTrade(ts: number | null): string {
  if (ts === null) return "-";
  return timeAgo(ts * 1000);
}

export default function ProspectsPage() {
  const [data, setData] = useState<ProspectsData | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"all" | ProspectVerdict>("all");

  async function load() {
    setLoading(true);
    try {
      const response = await apiFetch<ProspectsData>("/prospects?limit=250");
      setData(response);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load prospects");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  const prospects = data?.prospects ?? [];
  const visible = useMemo(
    () => prospects.filter((p) => filter === "all" || p.verdict === filter),
    [prospects, filter],
  );
  const promoted = prospects.filter((p) => p.verdict === "promoted").length;
  const rejected = prospects.filter((p) => p.verdict === "rejected").length;

  return (
    <div className="stack">
      <div className="page-header">
        <h1>Prospects</h1>
        <button className="button secondary" onClick={() => void load()} disabled={loading}>
          <RefreshCw size={15} /> Refresh
        </button>
      </div>

      {error && <div className="alert">{error}</div>}

      <div className="grid cols-3">
        <div className="panel">
          <div className="metric-label">Evaluated</div>
          <div className="metric-value">{prospects.length}</div>
        </div>
        <div className="panel">
          <div className="metric-label">Promoted</div>
          <div className="metric-value gain">{promoted}</div>
        </div>
        <div className="panel">
          <div className="metric-label">Rejected</div>
          <div className="metric-value loss">{rejected}</div>
        </div>
      </div>

      <div className="panel">
        <div className="row" style={{ marginBottom: 12 }}>
          <div style={{ display: "flex", gap: 8 }}>
            {(["all", "promoted", "rejected"] as const).map((v) => (
              <button
                key={v}
                className={`button ${filter === v ? "" : "secondary"}`}
                onClick={() => setFilter(v)}
                style={{ minHeight: 32, padding: "4px 12px", fontSize: 12 }}
              >
                {v}
              </button>
            ))}
          </div>
          <span className="pill">{visible.length} shown</span>
        </div>

        {visible.length === 0 && !loading ? (
          <p className="subtle">No prospect evaluations yet.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Wallet</th>
                  <th>Verdict</th>
                  <th>Score</th>
                  <th>P&L</th>
                  <th>Volume</th>
                  <th>P&L/Vol</th>
                  <th>Trades</th>
                  <th>Last trade</th>
                  <th>Reason</th>
                  <th>Evaluated</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((p) => (
                  <tr key={p.address}>
                    <td>
                      <div style={{ fontWeight: 700, fontSize: "0.82rem" }}>{p.userName ?? p.address}</div>
                      {p.xUsername && <div className="subtle">@{p.xUsername}</div>}
                      <WalletLink chain="polygon" address={p.address} />
                    </td>
                    <td><span className={`pill ${verdictClass(p.verdict)}`}>{p.verdict}</span></td>
                    <td>{p.score !== null ? p.score.toFixed(3) : "-"}</td>
                    <td>{p.pnlUsd !== null ? formatUsd(p.pnlUsd) : "-"}</td>
                    <td>{p.volUsd !== null ? formatUsd(p.volUsd) : "-"}</td>
                    <td>{ratio(p.pnlPerVol)}</td>
                    <td>{numberCell(p.tradeCount)}</td>
                    <td className="subtle">{lastTrade(p.lastTradeTs)}</td>
                    <td className={p.rejectReason ? "bad" : "subtle"}>{p.rejectReason ?? (p.promotedWalletId ? "leader added" : "-")}</td>
                    <td className="subtle">{timeAgo(p.lastEvaluatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
