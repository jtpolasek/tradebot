export function apiUrl(path: string) {
  return `/api${path}`;
}

export function streamUrl() {
  return "/api/stream";
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const res = await fetch(apiUrl(path), {
    ...init,
    headers,
    cache: "no-store",
  });
  const json = await res.json() as unknown;
  if (!res.ok) {
    const msg = typeof json === "object" && json !== null && "error" in json
      ? String((json as { error: unknown }).error)
      : `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return json as T;
}

export function formatUsd(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1000) return (n < 0 ? "-$" : "$") + abs.toLocaleString("en-US", { maximumFractionDigits: 0 });
  return (n < 0 ? "-$" : "$") + abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function formatPct(n: number | null): string {
  if (n === null) return "—";
  return (n >= 0 ? "+" : "") + (n * 100).toFixed(1) + "%";
}

export function formatPctPoints(n: number | null): string {
  if (n === null) return "—";
  return (n >= 0 ? "+" : "") + n.toFixed(1) + "%";
}

export function shortAddr(addr: string): string {
  return addr.slice(0, 6) + "…" + addr.slice(-4);
}

export type DisplayToken = {
  chain?: string;
  address: string;
  symbol?: string;
  name?: string;
};

export const NATIVE_TOKEN_PLACEHOLDER = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

export function isNativePlaceholder(address: string): boolean {
  return address.toLowerCase() === NATIVE_TOKEN_PLACEHOLDER;
}

export function tokenTitle(token: DisplayToken): string {
  if (isNativePlaceholder(token.address)) return token.symbol?.trim() || "ETH";
  const symbol = token.symbol?.trim();
  const name = token.name?.trim();
  if (name && symbol && name.toLowerCase() !== symbol.toLowerCase()) return `${name} (${symbol})`;
  return name || symbol || shortAddr(token.address);
}

function explorerBase(chain: string | undefined): string | null {
  if (chain === "base") return "https://basescan.org";
  if (chain === "eth") return "https://etherscan.io";
  return null;
}

export function explorerContractUrl(chain: string | undefined, address: string): string | null {
  if (isNativePlaceholder(address)) return null;
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) return null;
  const base = explorerBase(chain);
  return base ? `${base}/token/${address}` : null;
}

export function explorerAddressUrl(chain: string | undefined, address: string): string | null {
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) return null;
  const base = explorerBase(chain);
  return base ? `${base}/address/${address}` : null;
}

export function explorerTxUrl(chain: string | undefined, txHash: string): string | null {
  if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) return null;
  const base = explorerBase(chain);
  return base ? `${base}/tx/${txHash}` : null;
}

export function gmgnWalletUrl(chain: string | undefined, address: string): string | null {
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) return null;
  if (chain !== "eth" && chain !== "base") return null;
  return `https://gmgn.ai/${chain}/address/${address}`;
}

export function shortHash(hash: string): string {
  return hash.slice(0, 10) + "…" + hash.slice(-6);
}

export function timeAgo(ts: string | number): string {
  const ms = typeof ts === "number" ? ts : new Date(ts).getTime();
  const diff = Date.now() - ms;
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(ms).toLocaleDateString();
}
