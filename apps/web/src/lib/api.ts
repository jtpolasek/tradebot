const API_URL = process.env["NEXT_PUBLIC_API_URL"] ?? "http://localhost:3001";
const API_KEY = process.env["NEXT_PUBLIC_API_KEY"] ?? "";

export function apiUrl(path: string) {
  return `${API_URL}${path}`;
}

export function wsUrl() {
  return API_URL.replace(/^http/, "ws") + "/stream";
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(apiUrl(path), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(API_KEY ? { "X-Api-Key": API_KEY } : {}),
      ...(init?.headers ?? {}),
    },
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

export function shortAddr(addr: string): string {
  return addr.slice(0, 6) + "…" + addr.slice(-4);
}

export function timeAgo(ts: string | number): string {
  const ms = typeof ts === "number" ? ts : new Date(ts).getTime();
  const diff = Date.now() - ms;
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(ms).toLocaleDateString();
}
