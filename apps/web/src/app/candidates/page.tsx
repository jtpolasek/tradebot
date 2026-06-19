"use client";

import { useCallback, useEffect, useState } from "react";
import { ExternalLink } from "lucide-react";
import { TokenLink } from "@/components/TokenLink";
import { TxLink } from "@/components/TxLink";
import { apiFetch, shortAddr, timeAgo } from "@/lib/api";

type Candidate = {
  id: string;
  chain: string;
  walletId: string;
  txHash: string;
  source: string;
  side: "buy" | "sell";
  tokenIn: { address: string; symbol: string; name?: string };
  tokenOut: { address: string; symbol: string; name?: string };
  amountIn: string;
  amountOut: string;
  venue: string;
  observedAt: number;
  decodeStatus: "candidate";
  confidence: number | null;
  reason: string | null;
  externalUrl: string | null;
  reviewStatus: "pending" | "copy-requested" | "copying" | "copy-failed" | "copied" | "dismissed" | null;
};

type CandidateResponse = { candidates: Candidate[] };
type ChainFilter = "all" | "eth" | "base" | "polygon";
type VenueFilter = "all" | "polymarket" | "balance-delta" | "uniswap-v2" | "uniswap-v3" | "uniswap-v4" | "aerodrome";
type StatusFilter = "open" | "pending" | "copy-requested" | "copying" | "copy-failed" | "copied" | "dismissed";

const chainOptions: { value: ChainFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "eth", label: "Ethereum" },
  { value: "base", label: "Base" },
  { value: "polygon", label: "Polygon" },
];

const venueOptions: { value: VenueFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "polymarket", label: "Polymarket" },
  { value: "balance-delta", label: "Balance delta" },
  { value: "uniswap-v2", label: "Uniswap V2" },
  { value: "uniswap-v3", label: "Uniswap V3" },
  { value: "uniswap-v4", label: "Uniswap V4" },
  { value: "aerodrome", label: "Aerodrome" },
];

const statusOptions: { value: StatusFilter; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "pending", label: "Pending" },
  { value: "copy-requested", label: "Requested" },
  { value: "copying", label: "Copying" },
  { value: "copy-failed", label: "Failed" },
  { value: "copied", label: "Copied" },
  { value: "dismissed", label: "Dismissed" },
];

const statusLabels = new Map(statusOptions.map((option) => [option.value, option.label.toLowerCase()]));

export default function CandidatesPage() {
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [chainFilter, setChainFilter] = useState<ChainFilter>("all");
  const [venueFilter, setVenueFilter] = useState<VenueFilter>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("open");

  const load = useCallback(async () => {
    setError("");
    try {
      const params = new URLSearchParams({ limit: "100", status: statusFilter });
      if (chainFilter !== "all") params.set("chain", chainFilter);
      if (venueFilter !== "all") params.set("venue", venueFilter);
      const data = await apiFetch<CandidateResponse>(`/candidates?${params.toString()}`);
      setCandidates(data.candidates);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load candidates");
    } finally {
      setLoading(false);
    }
  }, [chainFilter, statusFilter, venueFilter]);

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
  const visibleStatus = statusLabels.get(statusFilter) ?? "shown";

  return (
    <div className="stack">
      <div className="page-header">
        <h1>Candidate Review</h1>
        <span className="pill">{candidates.length} {visibleStatus}</span>
        <span className="pill warn">{requestedCount} queued</span>
        {failedCount > 0 && <span className="pill bad">{failedCount} failed</span>}
      </div>

      <div className="panel">
        <div className="form-grid">
          <div className="field">
            <label htmlFor="candidate-chain">Chain</label>
            <select id="candidate-chain" value={chainFilter} onChange={(e) => setChainFilter(e.target.value as ChainFilter)}>
              {chainOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="candidate-venue">Venue</label>
            <select id="candidate-venue" value={venueFilter} onChange={(e) => setVenueFilter(e.target.value as VenueFilter)}>
              {venueOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </div>
          <div className="field full">
            <label htmlFor="candidate-status">Status</label>
            <select id="candidate-status" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}>
              {statusOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </div>
        </div>
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
                      <TokenLink chain={candidate.chain} token={candidate.tokenIn} /> {"->"} <TokenLink chain={candidate.chain} token={candidate.tokenOut} />
                    </span>
                    <span className="subtle" style={{ fontSize: "0.72rem" }}>
                      tx: <TxLink chain={candidate.chain} txHash={candidate.txHash} /> · <span className="mono">leader: {shortAddr(candidate.walletId)}</span>
                    </span>
                    {candidate.reason && (
                      <span className="subtle" style={{ fontSize: "0.78rem" }}>
                        {candidate.reason}
                      </span>
                    )}
                    {candidate.externalUrl && (
                      <a className="tx-link" href={candidate.externalUrl} target="_blank" rel="noreferrer">
                        Market <ExternalLink size={11} aria-hidden="true" />
                      </a>
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
                    {/* Polymarket candidates are record-only — no AMM pricing/engine path to copy into. */}
                    {candidate.venue !== "polymarket" && (
                      <button
                        className="button"
                        type="button"
                        disabled={!canAct || busyId === candidate.id}
                        onClick={() => void act(candidate.id, "copy")}
                      >
                        Copy
                      </button>
                    )}
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
