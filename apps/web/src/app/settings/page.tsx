"use client";

import { useEffect, useState, FormEvent } from "react";
import { Plus, EyeOff, Eye } from "lucide-react";
import { WalletLink } from "@/components/WalletLink";
import { apiFetch, timeAgo } from "@/lib/api";

type Wallet = { id: string; chain: string; address: string; label: string; active: boolean; autoCopy: boolean; addedAt: string };
type AdaptationEntry = { id: string; ts: string; rule: string; oldValue: string; newValue: string; evidenceJson?: unknown };
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

const SETTING_DESCRIPTIONS: Record<string, { description: string; example: string }> = {
  BASE_TRADE_PCT:              { description: "Fraction of portfolio per copy trade.", example: "0.01 = 1% ($1,000 on a $100k portfolio)" },
  MAX_TRADE_PCT:               { description: "Maximum fraction per trade, even for high-scoring wallets.", example: "0.03 = 3% cap" },
  MIN_NOTIONAL_USD:            { description: "Ignore swaps smaller than this — filters dust and test txns.", example: "50" },
  MIN_LIQUIDITY_USD:           { description: "Only copy trades in pools with at least this much liquidity.", example: "150000" },
  SIZING_MODE:                 { description: "fixed = always use BASE_TRADE_PCT. proportional = scale with the leader's trade size.", example: "fixed" },
  COPY_DELAY_PENALTY_BPS_ETH:  { description: "Slippage penalty (basis points) applied to ETH fills to simulate entry delay.", example: "10 = 0.1%" },
  COPY_DELAY_PENALTY_BPS_BASE: { description: "Same penalty for Base chain fills.", example: "5 = 0.05%" },
  GAS_USD_ETH:                 { description: "Estimated gas cost deducted per ETH trade.", example: "4" },
  GAS_USD_BASE:                { description: "Estimated gas cost deducted per Base trade.", example: "0.03" },
  LOG_LEVEL:                   { description: "Runner log verbosity.", example: "info | debug | warn | error" },
};

export default function SettingsPage() {
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [settings, setSettings] = useState<Record<string, unknown>>({});
  const [adaptations, setAdaptations] = useState<AdaptationEntry[]>([]);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState("");

  const [walletForm, setWalletForm] = useState({ chain: "eth", address: "", label: "" });
  const [settingForm, setSettingForm] = useState({ key: "", value: "" });

  async function loadAll() {
    try {
      const [wRes, sRes, aRes] = await Promise.all([
        apiFetch<{ wallets: Wallet[] }>("/wallets"),
        apiFetch<{ settings: Record<string, unknown> }>("/settings"),
        apiFetch<{ entries: AdaptationEntry[] }>("/adaptations?limit=50"),
      ]);
      setWallets(wRes.wallets);
      setSettings(sRes.settings);
      setAdaptations(aRes.entries);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load settings");
    }
  }

  useEffect(() => { void loadAll(); }, []);

  async function addWallet(e: FormEvent) {
    e.preventDefault();
    setBusy("wallet");
    setError(""); setMessage("");
    const address = walletForm.address.trim();
    if (!ADDRESS_RE.test(address)) {
      setBusy("");
      setError("Enter a valid 0x wallet address.");
      return;
    }
    try {
      await apiFetch("/wallets", {
        method: "POST",
        body: JSON.stringify({ ...walletForm, address, label: walletForm.label.trim() }),
      });
      setWalletForm({ chain: "eth", address: "", label: "" });
      setMessage("Wallet added.");
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add wallet");
    } finally {
      setBusy("");
    }
  }

  async function patchWallet(id: string, patch: { active?: boolean; autoCopy?: boolean }, busyKey: string, okMsg: string) {
    setBusy(busyKey);
    setError(""); setMessage("");
    try {
      await apiFetch(`/wallets/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
      setMessage(okMsg);
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update wallet");
    } finally {
      setBusy("");
    }
  }

  async function setWatching(id: string, active: boolean) {
    if (!active && !confirm("Stop watching this wallet? It will no longer be tracked or scored.")) return;
    await patchWallet(id, { active }, `watch-${id}`, active ? "Wallet is being watched." : "Stopped watching wallet.");
  }

  function setAutoCopy(id: string, autoCopy: boolean) {
    return patchWallet(id, { autoCopy }, `auto-${id}`, autoCopy ? "Auto-copy enabled." : "Auto-copy disabled.");
  }

  async function deleteSetting(key: string) {
    if (!confirm(`Reset ${key} to .env default?`)) return;
    setBusy(`del-setting-${key}`);
    setError(""); setMessage("");
    try {
      await apiFetch(`/settings/${key}`, { method: "DELETE" });
      setMessage(`${key} reset to default.`);
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reset setting");
    } finally {
      setBusy("");
    }
  }

  async function saveSetting(e: FormEvent) {
    e.preventDefault();
    if (!settingForm.key) return;
    setBusy("setting");
    setError(""); setMessage("");
    try {
      let value: unknown;
      try { value = JSON.parse(settingForm.value); } catch { value = settingForm.value; }
      await apiFetch("/settings", { method: "PATCH", body: JSON.stringify({ key: settingForm.key, value }) });
      setSettingForm({ key: "", value: "" });
      setMessage("Setting saved.");
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save setting");
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="stack">
      <div className="page-header"><h1>Settings</h1></div>

      {error && <div className="alert">{error}</div>}
      {message && <div className="alert success">{message}</div>}

      {/* Wallets */}
      <div className="panel">
        <h2>Watched wallets</h2>
        <form onSubmit={(e) => void addWallet(e)} className="form-grid" style={{ marginBottom: 16 }}>
          <div className="field">
            <label>Chain</label>
            <select value={walletForm.chain} onChange={(e) => setWalletForm({ ...walletForm, chain: e.target.value })}>
              <option value="eth">Ethereum</option>
              <option value="base">Base</option>
              <option value="polygon">Polygon (Polymarket)</option>
            </select>
          </div>
          <div className="field">
            <label>Label</label>
            <input value={walletForm.label} onChange={(e) => setWalletForm({ ...walletForm, label: e.target.value })} placeholder="Whale 1" required />
          </div>
          <div className="field full">
            <label>Address</label>
            <input
              value={walletForm.address}
              onChange={(e) => setWalletForm({ ...walletForm, address: e.target.value.trim() })}
              placeholder="0x..."
              autoComplete="off"
              spellCheck={false}
              pattern="^0x[a-fA-F0-9]{40}$"
              title="Use a 42-character 0x address."
              required
            />
          </div>
          <div style={{ gridColumn: "1 / -1" }}>
            <button className="button" type="submit" disabled={busy === "wallet"}>
              <Plus size={15} /> Add wallet
            </button>
          </div>
        </form>

        <div className="list">
          {wallets.filter((w) => w.active).map((w) => {
            const isRecordOnly = w.chain === "polygon";
            return (
              <div key={w.id} className="card wallet-card" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                <div>
                  <div style={{ fontWeight: 700 }}>{w.label}</div>
                  <WalletLink chain={w.chain} address={w.address} />
                  <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
                    <span className="pill">{w.chain}</span>
                    <span className="pill">added {timeAgo(w.addedAt)}</span>
                    {isRecordOnly ? (
                      <span className="pill warn">record-only</span>
                    ) : (
                      <span className={`pill ${w.autoCopy ? "good" : "warn"}`}>
                        {w.autoCopy ? "auto-copy on" : "auto-copy off"}
                      </span>
                    )}
                  </div>
                </div>

                <div style={{ display: "flex", gap: 6 }}>
                  {!isRecordOnly && (
                    <button
                      className="button"
                      style={{ minHeight: 32, padding: "4px 10px", fontSize: 12 }}
                      onClick={() => void setAutoCopy(w.id, !w.autoCopy)}
                      disabled={busy === `auto-${w.id}`}
                      title={w.autoCopy ? "Stop copying this wallet's buys (still watched & scored)" : "Resume copying this wallet's buys"}
                    >
                      {w.autoCopy ? "Disable auto-copy" : "Enable auto-copy"}
                    </button>
                  )}
                  <button
                    className="button danger"
                    style={{ minHeight: 32, padding: "4px 10px", fontSize: 12 }}
                    onClick={() => void setWatching(w.id, false)}
                    disabled={busy === `watch-${w.id}`}
                  >
                    <EyeOff size={14} /> Stop watching
                  </button>
                </div>
              </div>
            );
          })}
          {wallets.filter((w) => w.active).length === 0 && (
            <p className="subtle">No watched wallets. Add one above to start tracking.</p>
          )}
        </div>

        {wallets.some((w) => !w.active) && (
          <div style={{ marginTop: 20 }}>
            <h3 style={{ fontSize: 14, color: "var(--subtle)", marginBottom: 8 }}>Not watching</h3>
            <div className="list">
              {wallets.filter((w) => !w.active).map((w) => (
                <div key={w.id} className="card wallet-card" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, opacity: 0.55 }}>
                  <div>
                    <div style={{ fontWeight: 700 }}>{w.label}</div>
                    <WalletLink chain={w.chain} address={w.address} />
                    <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
                      <span className="pill">{w.chain}</span>
                      <span className="pill">added {timeAgo(w.addedAt)}</span>
                    </div>
                  </div>
                  <button
                    className="button"
                    style={{ minHeight: 32, padding: "4px 10px", fontSize: 12 }}
                    onClick={() => void setWatching(w.id, true)}
                    disabled={busy === `watch-${w.id}`}
                  >
                    <Eye size={14} /> Resume watching
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Runtime settings */}
      <div className="panel">
        <h2>Runtime settings</h2>
        <form onSubmit={(e) => void saveSetting(e)} className="form-grid" style={{ marginBottom: 16 }}>
          <div className="field">
            <label>Key</label>
            <select value={settingForm.key} onChange={(e) => setSettingForm({ ...settingForm, key: e.target.value })} required>
              <option value="">Select a setting…</option>
              <option value="MIN_LIQUIDITY_USD">MIN_LIQUIDITY_USD</option>
              <option value="MIN_NOTIONAL_USD">MIN_NOTIONAL_USD</option>
              <option value="BASE_TRADE_PCT">BASE_TRADE_PCT</option>
              <option value="MAX_TRADE_PCT">MAX_TRADE_PCT</option>
              <option value="SIZING_MODE">SIZING_MODE</option>
              <option value="COPY_DELAY_PENALTY_BPS_ETH">COPY_DELAY_PENALTY_BPS_ETH</option>
              <option value="COPY_DELAY_PENALTY_BPS_BASE">COPY_DELAY_PENALTY_BPS_BASE</option>
              <option value="GAS_USD_ETH">GAS_USD_ETH</option>
              <option value="GAS_USD_BASE">GAS_USD_BASE</option>
              <option value="LOG_LEVEL">LOG_LEVEL</option>
            </select>
          </div>
          <div className="field">
            <label>Value</label>
            <input value={settingForm.value} onChange={(e) => setSettingForm({ ...settingForm, value: e.target.value })} placeholder={SETTING_DESCRIPTIONS[settingForm.key]?.example ?? "value"} required />
          </div>
          {settingForm.key && SETTING_DESCRIPTIONS[settingForm.key] && (
            <div style={{ gridColumn: "1 / -1", padding: "8px 12px", background: "var(--panel)", borderRadius: 6, fontSize: 13, color: "var(--subtle)" }}>
              <strong style={{ color: "var(--text)" }}>{settingForm.key}</strong> — {SETTING_DESCRIPTIONS[settingForm.key].description}
              <span style={{ marginLeft: 8, opacity: 0.6 }}>e.g. {SETTING_DESCRIPTIONS[settingForm.key].example}</span>
            </div>
          )}
          <div style={{ gridColumn: "1 / -1" }}>
            <button className="button" type="submit" disabled={busy === "setting"}>Save setting</button>
          </div>
        </form>

        {Object.keys(settings).length > 0 ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Key</th><th>Value</th><th></th></tr>
              </thead>
              <tbody>
                {Object.entries(settings).map(([k, v]) => (
                  <tr key={k}>
                    <td className="mono">{k}</td>
                    <td>{JSON.stringify(v)}</td>
                    <td>
                      <button
                        className="button danger"
                        style={{ minHeight: 28, padding: "2px 8px", fontSize: 12 }}
                        onClick={() => void deleteSetting(k)}
                        disabled={busy === `del-setting-${k}`}
                      >
                        Reset
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="subtle">No overrides. Defaults come from .env.</p>
        )}
      </div>

      {/* Adaptation log */}
      <div className="panel">
        <h2>Adaptation log</h2>
        {adaptations.length === 0 ? (
          <p className="subtle">No adaptation events yet.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Time</th><th>Rule</th><th>Old</th><th>New</th></tr>
              </thead>
              <tbody>
                {adaptations.map((a) => (
                  <tr key={a.id}>
                    <td>{timeAgo(a.ts)}</td>
                    <td>{a.rule}</td>
                    <td>{a.oldValue}</td>
                    <td>{a.newValue}</td>
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
