"use client";

import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { TokenLink } from "@/components/TokenLink";
import { WalletLink } from "@/components/WalletLink";
import { MetricStrip, type MetricItem } from "@/components/MetricStrip";
import { apiFetch, formatUsd, timeAgo } from "@/lib/api";

type TokenResult = {
  chain: string;
  tokenAddress: string;
  symbol: string;
  name?: string;
  realizedPnlUsd: number;
  closedTrades: number;
};

type Analytics = {
  closedTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number | null;
  realizedPnlUsd: number;
  totalFeesUsd: number;
  totalNotionalUsd: number;
  feeDrag: number | null;
  averageHoldHours: number | null;
  openExposureUsd: number;
  copiedFills: number;
  skippedFills: number;
  skipRate: number | null;
  byToken: TokenResult[];
};

const pct = (n: number | null) => (n === null ? "—" : (n * 100).toFixed(1) + "%");
const hours = (n: number | null) => (n === null ? "—" : n < 1 ? `${Math.round(n * 60)}m` : `${n.toFixed(1)}h`);
const daysOpen = (openedAt: string) => Math.max(0, Math.floor((Date.now() - new Date(openedAt).getTime()) / 86_400_000));

function analyticsMetrics(a: Analytics): MetricItem[] {
  return [
    { label: "Realized P&L", value: formatUsd(a.realizedPnlUsd), tone: a.realizedPnlUsd >= 0 ? "gain" : "loss" },
    { label: "Win rate", value: a.winRate === null ? "—" : pct(a.winRate), tone: "muted" },
    { label: "Closed", value: `${a.winningTrades}W / ${a.losingTrades}L`, tone: "muted" },
    { label: "Avg hold", value: hours(a.averageHoldHours), tone: "muted" },
    { label: "Open exposure", value: formatUsd(a.openExposureUsd), tone: "muted" },
    { label: "Fee drag", value: pct(a.feeDrag), tone: a.feeDrag ? "loss" : "muted" },
    { label: "Fees paid", value: formatUsd(a.totalFeesUsd), tone: "muted" },
    { label: "Skip rate", value: pct(a.skipRate), tone: "muted" },
    { label: "Copied", value: `${a.copiedFills}`, tone: "muted" },
  ];
}

type PositionRow = {
  id: string;
  chain: string;
  tokenAddress: string;
  qty: number;
  avgCostUsd: number;
  openedAt: string;
  closedAt: string | null;
  realizedPnlUsd: number;
  sourceWalletId: string | null;
  sourceWallet: { id: string; chain: string; address: string; label: string; active: boolean } | null;
  currentPriceUsd: number | null;
  token?: { chain?: string; address: string; symbol?: string; name?: string };
};

type SnapshotRow = {
  id: string;
  ts: string;
  equityUsd: number;
  cashUsd: number;
  positionsValueUsd: number;
  dailyPnlUsd: number;
};

type PortfolioData = {
  snapshot: SnapshotRow | null;
  positions: PositionRow[];
  snapshots: SnapshotRow[];
};

export default function PortfolioPage() {
  const [data, setData] = useState<PortfolioData | null>(null);
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const chartRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chartInstance = useRef<any>(null);

  async function load() {
    try {
      const [d, a] = await Promise.all([
        apiFetch<PortfolioData>("/portfolio"),
        apiFetch<{ analytics: Analytics }>("/analytics"),
      ]);
      setData(d);
      setAnalytics(a.analytics);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load portfolio");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  useEffect(() => {
    if (!data?.snapshots.length || !chartRef.current) return;

    let disposed = false;
    import("lightweight-charts").then(({ createChart, ColorType }) => {
      if (disposed || !chartRef.current) return;

      if (chartInstance.current) {
        chartInstance.current.remove();
        chartInstance.current = null;
      }

      const chart = createChart(chartRef.current, {
        width: chartRef.current.clientWidth,
        height: 200,
        layout: { background: { type: ColorType.Solid, color: "#0b1222" }, textColor: "#94a3b8" },
        grid: { vertLines: { color: "#1e293b" }, horzLines: { color: "#1e293b" } },
        timeScale: { timeVisible: true, secondsVisible: false },
      });

      const series = chart.addAreaSeries({
        lineColor: "#2dd4bf",
        topColor: "rgba(45,212,191,0.2)",
        bottomColor: "rgba(45,212,191,0)",
        lineWidth: 2,
      });

      series.setData(
        data.snapshots.map((s) => ({
          time: Math.floor(new Date(s.ts).getTime() / 1000) as Parameters<typeof series.setData>[0][number]["time"],
          value: s.equityUsd,
        }))
      );

      chart.timeScale().fitContent();
      chartInstance.current = chart;

      const ro = new ResizeObserver(() => {
        if (chartRef.current) chart.applyOptions({ width: chartRef.current.clientWidth });
      });
      ro.observe(chartRef.current);

      return () => { ro.disconnect(); };
    }).catch(() => {/* chart load failed, not critical */});

    return () => { disposed = true; };
  }, [data?.snapshots]);

  const snap = data?.snapshot;
  const positions = data?.positions ?? [];
  const totalCurrentValue = positions.reduce((sum, p) => {
    if (p.currentPriceUsd !== null) return sum + p.currentPriceUsd * p.qty;
    return sum + p.avgCostUsd * p.qty;
  }, 0);
  const totalUnrealizedPnl = positions.reduce((sum, p) => {
    if (p.currentPriceUsd !== null) return sum + (p.currentPriceUsd - p.avgCostUsd) * p.qty;
    return sum;
  }, 0);

  return (
    <div className="stack">
      <div className="page-header">
        <h1>Portfolio</h1>
        <button className="button secondary" onClick={() => void load()} disabled={loading}>
          <RefreshCw size={15} /> Refresh
        </button>
      </div>

      {error && <div className="alert">{error}</div>}

      {snap && (
        <div className="grid cols-4">
          {[
            { label: "Equity", value: formatUsd(snap.equityUsd), tone: "" },
            { label: "Cash", value: formatUsd(snap.cashUsd), tone: "" },
            { label: "Positions", value: formatUsd(snap.positionsValueUsd), tone: "" },
            { label: "Daily P&L", value: formatUsd(snap.dailyPnlUsd), tone: snap.dailyPnlUsd >= 0 ? "gain" : "loss" },
          ].map(({ label, value, tone }) => (
            <div key={label} className="panel">
              <div className="metric-label">{label}</div>
              <div className={`metric-value${tone ? ` ${tone}` : ""}`}>{value}</div>
            </div>
          ))}
        </div>
      )}

      {(data?.snapshots.length ?? 0) > 1 && (
        <div className="panel">
          <h2>Equity curve</h2>
          <div ref={chartRef} style={{ width: "100%", height: 200 }} />
        </div>
      )}

      {analytics && (
        <div className="panel">
          <h2 style={{ marginBottom: 12 }}>Performance</h2>
          <MetricStrip items={analyticsMetrics(analytics)} />
        </div>
      )}

      {analytics && analytics.byToken.length > 0 && (
        <div className="panel">
          <h2 style={{ marginBottom: 10 }}>Realized P&L by token</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Token</th><th>Chain</th><th>Closed trades</th><th>Realized P&L</th></tr>
              </thead>
              <tbody>
                {analytics.byToken.map((t) => (
                  <tr key={`${t.chain}:${t.tokenAddress}`}>
                    <td>
                      <TokenLink
                        chain={t.chain}
                        token={{ chain: t.chain, address: t.tokenAddress, symbol: t.symbol, ...(t.name ? { name: t.name } : {}) }}
                      />
                    </td>
                    <td><span className="pill">{t.chain}</span></td>
                    <td>{t.closedTrades}</td>
                    <td className={t.realizedPnlUsd >= 0 ? "good" : "bad"}>{formatUsd(t.realizedPnlUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="panel">
        <div className="row" style={{ marginBottom: 10 }}>
          <h2 style={{ margin: 0 }}>Open positions <span className="pill">{positions.length}</span></h2>
          {positions.length > 0 && (
            <span className={`pill ${totalUnrealizedPnl >= 0 ? "good" : "bad"}`}>
              Unrealized {formatUsd(totalUnrealizedPnl)}
            </span>
          )}
        </div>
        {positions.length === 0 ? (
          <p className="subtle">No open positions.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Token</th>
                  <th>Wallet</th>
                  <th>Chain</th>
                  <th>Qty</th>
                  <th>Avg cost</th>
                  <th>Current</th>
                  <th>Value</th>
                  <th>Unrealized</th>
                  <th>Realized P&L</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {positions.map((p) => {
                  const currentValue = p.currentPriceUsd !== null ? p.currentPriceUsd * p.qty : null;
                  const unrealized = p.currentPriceUsd !== null ? (p.currentPriceUsd - p.avgCostUsd) * p.qty : null;
                  const openDays = daysOpen(p.openedAt);
                  const statusClass = !p.sourceWallet ? "bad" : !p.sourceWallet.active || openDays >= 3 ? "warn" : "good";
                  const statusText = !p.sourceWallet
                    ? "missing wallet"
                    : !p.sourceWallet.active
                    ? "wallet inactive"
                    : openDays >= 3
                    ? `${openDays}d open`
                    : "open";
                  return (
                    <tr key={p.id}>
                      <td>
                        <TokenLink
                          chain={p.chain}
                          token={p.token ?? { chain: p.chain, address: p.tokenAddress }}
                        />
                      </td>
                      <td>
                        {p.sourceWallet ? (
                          <div className="stack" style={{ gap: 2 }}>
                            <span style={{ fontWeight: 700, fontSize: "0.78rem" }}>{p.sourceWallet.label}</span>
                            <WalletLink chain={p.sourceWallet.chain} address={p.sourceWallet.address} />
                          </div>
                        ) : (
                          <span className="subtle">—</span>
                        )}
                      </td>
                      <td><span className="pill">{p.chain}</span></td>
                      <td>{p.qty.toFixed(4)}</td>
                      <td>{formatUsd(p.avgCostUsd)}</td>
                      <td>{p.currentPriceUsd !== null ? formatUsd(p.currentPriceUsd) : "—"}</td>
                      <td>{currentValue !== null ? formatUsd(currentValue) : formatUsd(p.avgCostUsd * p.qty)}</td>
                      <td className={unrealized !== null ? (unrealized >= 0 ? "good" : "bad") : ""}>
                        {unrealized !== null ? formatUsd(unrealized) : "—"}
                      </td>
                      <td className={p.realizedPnlUsd >= 0 ? "good" : "bad"}>{formatUsd(p.realizedPnlUsd)}</td>
                      <td>
                        <div className="stack" style={{ gap: 3 }}>
                          <span className={`pill ${statusClass}`}>{statusText}</span>
                          <span className="subtle">{timeAgo(p.openedAt)}</span>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {!loading && !snap && (
        <div className="panel">
          <p className="subtle">No portfolio data yet. Start the runner to begin tracking.</p>
        </div>
      )}
    </div>
  );
}
