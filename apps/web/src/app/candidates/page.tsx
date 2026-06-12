"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch, shortAddr, timeAgo } from "@/lib/api";

type Candidate = {
  id: string;
  chain: string;
  walletId: string;
  txHash: string;
  source: string;
  side: "buy" | "sell";
  tokenIn: { address: string; symbol: string };
  tokenOut: { address: string; symbol: string };
  amountIn: string;
  amountOut: string;
  venue: string;
  observedAt: number;
  decodeStatus: "candidate";
  confidence: number | null;
  reason: string | null;
  reviewStatus: "pending" | "copy-requested" | "copying" | "copy-failed" | null;
};

type CandidateResponse = { candidates: Candidate[] };

export default function CandidatesPage() {
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const data = await apiFetch<CandidateResponse>("/candidates?limit=100");
      setCandidates(data.candidates);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load candidates");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5_000);
    return () => clearInterval(timer);
  }, [load]);

  async function act(id: string, action: "copy" | "dismiss") {
    setBusyId(id);
    setError("");
    try {
      await apiFetch(`/candidates/${id}/${action}`, { method: "POST" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to ${action} candidate`);
    } finally {
      setBusyId(null);
    }
  }

  const pendingCount = candidates.filter((c) => !c.reviewStatus || c.reviewStatus === "pending").length;
  const requestedCount = candidates.filter((c) => c.reviewStatus === "copy-requested" || c.reviewStatus === "copying").length;
  const failedCount = candidates.filter((c) => c.reviewStatus === "copy-failed").length;

  return (
    <div className="stack">
      <div className="page-header">
        <h1>Candidate Review</h1>
        <span className="pill">{candidates.length} open</span>
        <span className="pill warn">{requestedCount} queued</span>
        {failedCount > 0 && <span className="pill bad">{failedCount} failed</span>}
      </div>

      <div className="metric-strip">
        <div className="metric-item">
          <span className="metric-label">Pending</span>
          <span className="metric-value">{pendingCount}</span>
        </div>
        <div className="metric-item">
          <span className="metric-label">Requested</span>
          <span className="metric-value">{requestedCount}</span>
        </div>
        <div className="metric-item">
          <span className="metric-label">Failed</span>
          <span className={`metric-value ${failedCount > 0 ? "loss" : ""}`}>{failedCount}</span>
        </div>
      </div>

      {error && <div className="alert">{error}</div>}

      {loading ? (
        <div className="panel">
          <p className="subtle">Loading candidates...</p>
        </div>
      ) : candidates.length === 0 ? (
        <div className="panel">
          <p className="subtle">No candidates need review.</p>
        </div>
      ) : (
        <div className="list">
          {candidates.map((candidate) => {
            const status = candidate.reviewStatus ?? "pending";
            const canAct = status === "pending" || status === "copy-failed";
            const confidence = candidate.confidence === null ? "n/a" : `${Math.round(candidate.confidence * 100)}%`;
            return (
              <div key={candidate.id} className="card feed-item">
                <div className="feed-meta">
                  <span className="pill warn">CANDIDATE</span>
                  <span className={`pill ${candidate.side === "buy" ? "good" : "warn"}`}>{candidate.side.toUpperCase()}</span>
                  <span className="pill">{candidate.chain}</span>
                  <span className="pill">{candidate.venue}</span>
                  <span className="pill">{status}</span>
                  <span className="pill">confidence {confidence}</span>
                  <span style={{ marginLeft: "auto" }}>{timeAgo(candidate.observedAt)}</span>
                </div>

                <div className="row" style={{ alignItems: "flex-start" }}>
                  <div className="stack" style={{ gap: 4 }}>
                    <span style={{ fontWeight: 800 }}>
                      {shortAddr(candidate.tokenIn.address)} {"->"} {shortAddr(candidate.tokenOut.address)}
                    </span>
                    <span className="subtle mono" style={{ fontSize: "0.72rem" }}>
                      tx: {shortAddr(candidate.txHash)} · leader: {shortAddr(candidate.walletId)}
                    </span>
                    {candidate.reason && (
                      <span className="subtle" style={{ fontSize: "0.78rem" }}>
                        {candidate.reason}
                      </span>
                    )}
                  </div>

                  <div className="row compact">
                    <button
                      className="button secondary"
                      type="button"
                      disabled={!canAct || busyId === candidate.id}
                      onClick={() => void act(candidate.id, "dismiss")}
                    >
                      Dismiss
                    </button>
                    <button
                      className="button"
                      type="button"
                      disabled={!canAct || busyId === candidate.id}
                      onClick={() => void act(candidate.id, "copy")}
                    >
                      Copy
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
