"use client";

import { useEffect, useRef, useState } from "react";
import { apiFetch, streamUrl, formatUsd, shortAddr, timeAgo } from "@/lib/api";

type SignalItem = {
  type: "trade-signal";
  data: {
    id: string; chain: string; walletId: string; txHash: string;
    source: string; side: string; tokenIn: { address: string; symbol: string };
    tokenOut: { address: string; symbol: string }; venue: string; observedAt: number;
    amountIn: string; amountOut: string;
  };
};

type FillItem = {
  type: "paper-fill";
  data: {
    id: string; signalId: string; decidedAt: number; decision: string; skipReason?: string;
    side: string; token: { address: string; symbol: string }; qty: number;
    priceUsd: number; notionalUsd: number; feeUsd: number; slippageBps: number;
    latencyMs: number; provisional: boolean; voided: boolean;
  };
};

type FeedEvent = SignalItem | FillItem | { type: "ping" };

type HistoricalSignal = {
  id: string; chain: string; walletId: string; txHash: string;
  source: string; side: string; tokenIn: { address: string; symbol: string };
  tokenOut: { address: string; symbol: string }; venue: string; observedAt: number;
  amountIn: string; amountOut: string;
};

type HistoricalFill = {
  id: string; signalId: string; decidedAt: number; decision: string; skipReason?: string;
  side: string; token: { address: string; symbol: string }; qty: number;
  priceUsd: number; notionalUsd: number; feeUsd: number; slippageBps: number;
  latencyMs: number; provisional: boolean; voided: boolean;
};

type FeedEntry =
  | { kind: "signal"; ts: number; data: HistoricalSignal }
  | { kind: "fill";   ts: number; data: HistoricalFill };

export default function FeedPage() {
  const [entries, setEntries] = useState<FeedEntry[]>([]);
  const [wsStatus, setWsStatus] = useState<"connecting" | "connected" | "disconnected">("disconnected");
  const [error, setError] = useState("");
  const streamRef = useRef<EventSource | null>(null);

  function addEntry(entry: FeedEntry) {
    setEntries((prev) => [entry, ...prev].slice(0, 200));
  }

  useEffect(() => {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    Promise.all([
      apiFetch<{ signals: HistoricalSignal[] }>(`/signals?since=${since}&limit=50`),
      apiFetch<{ fills: HistoricalFill[] }>(`/fills?since=${since}&limit=50`),
    ]).then(([sRes, fRes]) => {
      const all: FeedEntry[] = [
        ...sRes.signals.map((s): FeedEntry => ({ kind: "signal", ts: s.observedAt, data: s })),
        ...fRes.fills.map((f): FeedEntry => ({ kind: "fill", ts: f.decidedAt, data: f })),
      ];
      all.sort((a, b) => b.ts - a.ts);
      setEntries(all.slice(0, 200));
    }).catch((err) => setError(err instanceof Error ? err.message : "Failed to load history"));

    // Server-sent events for live updates through the same-origin proxy.
    function connect() {
      setWsStatus("connecting");
      const stream = new EventSource(streamUrl());
      streamRef.current = stream;

      stream.onopen = () => setWsStatus("connected");
      stream.onerror = () => {
        stream.close();
        setWsStatus("disconnected");
        setTimeout(connect, 3_000);
      };
      stream.onmessage = (evt) => {
        try {
          const msg = JSON.parse(evt.data as string) as FeedEvent;
          if (msg.type === "trade-signal") {
            addEntry({ kind: "signal", ts: msg.data.observedAt, data: msg.data });
          } else if (msg.type === "paper-fill") {
            addEntry({ kind: "fill", ts: msg.data.decidedAt, data: msg.data });
          }
        } catch { /* ignore parse errors */ }
      };
    }
    connect();

    return () => {
      streamRef.current?.close();
    };
  }, []);

  const wsColor = wsStatus === "connected" ? "good" : wsStatus === "connecting" ? "warn" : "bad";

  return (
    <div className="stack">
      <div className="page-header">
        <h1>Live Feed</h1>
        <span className={`pill ${wsColor}`}>{wsStatus}</span>
      </div>

      {error && <div className="alert">{error}</div>}

      {entries.length === 0 ? (
        <div className="panel">
          <p className="subtle">No events yet. Signals and fills will appear here in real time.</p>
        </div>
      ) : (
        <div className="list">
          {entries.map((entry) => (
            <div key={entry.kind + "-" + entry.data.id} className="card feed-item">
              <div className="feed-meta">
                <span className="pill">{entry.kind === "signal" ? "SIGNAL" : "FILL"}</span>
                {entry.kind === "signal" ? (
                  <>
                    <span className={`pill ${entry.data.side === "buy" ? "good" : "warn"}`}>{entry.data.side.toUpperCase()}</span>
                    <span className="pill">{entry.data.chain}</span>
                    <span className="pill">{entry.data.venue}</span>
                    <span className="pill">{entry.data.source}</span>
                    <span style={{ marginLeft: "auto" }}>{timeAgo(entry.ts)}</span>
                  </>
                ) : (
                  <>
                    <span className={`pill ${entry.data.decision === "copied" ? "good" : "bad"}`}>{entry.data.decision.toUpperCase()}</span>
                    <span className={`pill ${entry.data.side === "buy" ? "good" : "warn"}`}>{entry.data.side.toUpperCase()}</span>
                    {entry.data.skipReason && <span className="pill warn">{entry.data.skipReason}</span>}
                    {entry.data.provisional && <span className="pill warn">provisional</span>}
                    {entry.data.voided && <span className="pill bad">voided</span>}
                    <span style={{ marginLeft: "auto" }}>{timeAgo(entry.ts)}</span>
                  </>
                )}
              </div>
              {entry.kind === "signal" ? (
                <div>
                  <span style={{ fontWeight: 700 }}>
                    {shortAddr(entry.data.tokenIn.address)} → {shortAddr(entry.data.tokenOut.address)}
                  </span>
                  <div className="subtle mono" style={{ fontSize: "0.72rem", marginTop: 2 }}>
                    tx: {shortAddr(entry.data.txHash)}
                  </div>
                </div>
              ) : (
                <div>
                  <span style={{ fontWeight: 700 }}>
                    {shortAddr(entry.data.token.address)} · {entry.data.qty.toFixed(4)} @ {formatUsd(entry.data.priceUsd)}
                  </span>
                  <div className="subtle" style={{ fontSize: "0.78rem", marginTop: 2 }}>
                    {formatUsd(entry.data.notionalUsd)} notional · {entry.data.slippageBps} bps · {entry.data.latencyMs}ms
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
