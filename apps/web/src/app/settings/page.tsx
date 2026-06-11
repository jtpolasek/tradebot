"use client";

import { useEffect, useState, FormEvent } from "react";
import { Plus, Trash2 } from "lucide-react";
import { apiFetch, shortAddr, timeAgo } from "@/lib/api";

type Wallet = { id: string; chain: string; address: string; label: string; active: boolean; addedAt: string };
type AdaptationEntry = { id: string; ts: string; rule: string; oldValue: string; newValue: string; evidenceJson?: unknown };

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
    try {
      await apiFetch("/wallets", {
        method: "POST",
        body: JSON.stringify(walletForm),
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

  async function deleteWallet(id: string) {
    if (!confirm("Deactivate this wallet? It will no longer be tracked.")) return;
    setBusy(`del-${id}`);
    setError(""); setMessage("");
    try {
      await apiFetch(`/wallets/${id}`, { method: "DELETE" });
      setMessage("Wallet deactivated.");
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete wallet");
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
            </select>
          </div>
          <div className="field">
            <label>Label</label>
            <input value={walletForm.label} onChange={(e) => setWalletForm({ ...walletForm, label: e.target.value })} placeholder="Whale 1" required />
          </div>
          <div className="field full">
            <label>Address</label>
            <input value={walletForm.address} onChange={(e) => setWalletForm({ ...walletForm, address: e.target.value })} placeholder="0x..." required />
          </div>
          <div style={{ gridColumn: "1 / -1" }}>
            <button className="button" type="submit" disabled={busy === "wallet"}>
              <Plus size={15} /> Add wallet
            </button>
          </div>
        </form>

        <div className="list">
          {wallets.filter((w) => w.active).map((w) => (
            <div key={w.id} className="card wallet-card" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
              <div>
                <div style={{ fontWeight: 700 }}>{w.label}</div>
                <div className="mono subtle">{shortAddr(w.address)}</div>
                <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
                  <span className="pill">{w.chain}</span>
                  <span className="pill">added {timeAgo(w.addedAt)}</span>
                </div>
              </div>
              <button
                className="button danger"
                style={{ minHeight: 32, padding: "4px 10px", fontSize: 12 }}
                onClick={() => void deleteWallet(w.id)}
                disabled={busy === `del-${w.id}`}
              >
                <Trash2 size={14} /> Remove
              </button>
            </div>
          ))}
          {wallets.filter((w) => w.active).length === 0 && (
            <p className="subtle">No active wallets. Add one above to start tracking.</p>
          )}
        </div>
      </div>

      {/* Runtime settings */}
      <div className="panel">
        <h2>Runtime settings</h2>
        <form onSubmit={(e) => void saveSetting(e)} className="form-grid" style={{ marginBottom: 16 }}>
          <div className="field">
            <label>Key</label>
            <input value={settingForm.key} onChange={(e) => setSettingForm({ ...settingForm, key: e.target.value })} placeholder="MIN_LIQUIDITY_USD" required />
          </div>
          <div className="field">
            <label>Value (JSON or string)</label>
            <input value={settingForm.value} onChange={(e) => setSettingForm({ ...settingForm, value: e.target.value })} placeholder="300000" required />
          </div>
          <div style={{ gridColumn: "1 / -1" }}>
            <button className="button" type="submit" disabled={busy === "setting"}>Save setting</button>
          </div>
        </form>

        {Object.keys(settings).length > 0 ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Key</th><th>Value</th></tr>
              </thead>
              <tbody>
                {Object.entries(settings).map(([k, v]) => (
                  <tr key={k}>
                    <td className="mono">{k}</td>
                    <td>{JSON.stringify(v)}</td>
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
