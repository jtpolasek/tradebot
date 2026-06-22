import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { fileURLToPath } from "url";
import { closeDb, getDb } from "../packages/store/src/db.ts";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
loadLocalEnv(resolve(__dirname, "../.env"));
const dbUrl = process.env["DATABASE_URL"];
if (!dbUrl) throw new Error("DATABASE_URL not set");

async function main() {
  const db = getDb(dbUrl);
  const poll = await db.query.polymarketPollState.findMany({});
  console.log("poll state:");
  for (const p of poll as any[]) {
    const ago = p.lastPolledAt ? Math.round((Date.now() - new Date(p.lastPolledAt).getTime()) / 1000) : null;
    console.log(`  ${p.walletId.slice(0,8)} lastPoll=${ago}s ago dur=${p.durationMs}ms fetched=${p.fetchedCount} recorded=${p.recordedCount} fails=${p.consecutiveFailures} err=${p.lastError ?? "-"}`);
  }
  const fills = await db.query.paperFills.findMany({
    orderBy: (t, { desc }) => [desc(t.decidedAt)],
    limit: 40,
  });
  const sigs = await db.query.tradeSignals.findMany();
  const byId = new Map(sigs.map((s) => [s.id, s]));
  console.log("\nrecent polygon fills:");
  let shown = 0;
  for (const f of fills) {
    const s = byId.get(f.signalId);
    if (s?.chain !== "polygon" || shown >= 12) continue;
    shown++;
    const age = Math.round((new Date(f.decidedAt as any).getTime() - new Date(s.observedAt as any).getTime()) / 1000);
    console.log(`  ${f.decision}/${f.skipReason ?? "-"} decided=${new Date(f.decidedAt as any).toISOString()} tradeAge=${age}s`);
  }
  await closeDb();
}

function loadLocalEnv(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i <= 0) continue;
    const k = t.slice(0, i).trim();
    if (process.env[k] !== undefined) continue;
    process.env[k] = t.slice(i + 1).trim().replace(/^['"]|['"]$/g, "");
  }
}

main().catch(async (e: unknown) => { console.error(e); await closeDb(); process.exit(1); });
