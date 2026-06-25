#!/usr/bin/env bash
# Soak monitor probe (PLAN §10). Polls the runner's /health + /metrics and appends one
# JSON line per tick to recordings/soak-monitor.log. Never prints the API key.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG="$ROOT/recordings/soak-monitor.log"
PORT="${API_PORT:-3001}"
BASE="http://localhost:$PORT"

# Read API_KEY from .env without echoing it.
API_KEY="$(grep -aE '^API_KEY=' "$ROOT/.env" | head -1 | cut -d= -f2- | tr -d '\r')"

ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

health_code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$BASE/health" || echo 000)"
metrics="$(curl -s --max-time 15 -H "X-Api-Key: $API_KEY" "$BASE/metrics" || echo '{}')"

# Compact the metrics payload to a single line and prepend our own fields.
line="$(node -e '
  const ts = process.argv[1];
  const healthCode = process.argv[2];
  let m = {};
  try { m = JSON.parse(process.argv[3] || "{}"); } catch {}
  const hb = m?.input?.heartbeat ?? null;
  const payload = hb?.payload ?? null;
  const rssMb = payload?.rssBytes != null ? Math.round(payload.rssBytes / 1048576) : null;
  const heapMb = payload?.heapUsedBytes != null ? Math.round(payload.heapUsedBytes / 1048576) : null;
  const heartbeatAgeSec = hb?.ts != null ? Math.round((Date.now() - hb.ts) / 1000) : null;
  const chains = Array.isArray(payload?.chains)
    ? payload.chains.map((c) => ({
        chain: c.chain,
        state: c.connectionState,
        fails: c.connectFailures,
        wallets: c.walletCount,
      }))
    : null;
  const out = {
    ts,
    healthCode: Number(healthCode),
    status: m?.status ?? null,
    rssMb,
    heapMb,
    uptimeSec: payload?.uptimeSec ?? null,
    heartbeatAgeSec,
    chains,
  };
  process.stdout.write(JSON.stringify(out));
' "$ts" "$health_code" "$metrics")"

printf '%s\n' "$line" | tee -a "$LOG"
