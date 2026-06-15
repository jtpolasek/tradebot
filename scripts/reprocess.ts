/**
 * Read-only reprocess tool. Re-runs the current decoder over recorded RawTxEvents and diffs the
 * signals it *would* produce against what is already persisted in trade_signals — surfacing how a
 * decoder change would reclassify past activity (status upgrades, side flips, newly/no-longer
 * derived). Ported from the GMGN `candidateReprocess` tool.
 *
 * It never writes signals, fills, or positions. (The shared decoder may cache token metadata for a
 * never-before-seen token, which is additive and does not touch trading state.)
 *
 *   pnpm reprocess [path ...]      # defaults to ./recordings
 */
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { resolve, join } from "path";
import { fileURLToPath } from "url";
import { EventBus } from "../packages/core/src/bus.ts";
import type { ChainId, TradeSignal } from "../packages/core/src/types.ts";
import { Decoder } from "../packages/decoder/src/decoder.ts";
import { summarizeReprocess, reprocessKey, type ReprocessSignal } from "../packages/decoder/src/reprocess.ts";
import { deserializeEvent } from "../packages/ingest/src/recorder.ts";
import { closeDb, getDb } from "../packages/store/src/db.ts";
import { getAllWallets } from "../packages/store/src/repositories/wallets.ts";
import { getRecentSignals } from "../packages/store/src/repositories/signals.ts";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
loadLocalEnv(resolve(__dirname, "../.env"));

const dbUrl = process.env["DATABASE_URL"];
if (!dbUrl) throw new Error("DATABASE_URL not set");

const QUIET_MS = 2_000; // re-derivation is settled once no new signal has arrived for this long
const MAX_WAIT_MS = 120_000;
const MAX_PRINTED_CHANGES = 50;

function resolveInputFiles(paths: string[]): string[] {
  const roots = paths.length ? paths : [resolve(__dirname, "../recordings")];
  const files: string[] = [];
  for (const p of roots) {
    if (!existsSync(p)) {
      console.warn(`skipping missing path: ${p}`);
      continue;
    }
    if (statSync(p).isDirectory()) {
      for (const name of readdirSync(p)) {
        if (name.endsWith(".jsonl")) files.push(join(p, name));
      }
    } else {
      files.push(p);
    }
  }
  return files;
}

function toReprocessSignal(s: Pick<TradeSignal, "chain" | "txHash" | "walletId" | "decodeStatus" | "side" | "tokenIn" | "tokenOut" | "reason">): ReprocessSignal {
  return {
    chain: s.chain,
    txHash: s.txHash,
    walletId: s.walletId,
    decodeStatus: s.decodeStatus ?? "decoded",
    side: s.side,
    tokenInAddress: s.tokenIn.address,
    tokenOutAddress: s.tokenOut.address,
    reason: s.reason ?? null,
  };
}

async function main() {
  const files = resolveInputFiles(process.argv.slice(2));
  if (files.length === 0) {
    console.error("No recording files found. Pass a path or populate ./recordings.");
    process.exitCode = 1;
    return;
  }

  const events = files
    .flatMap((file) => readFileSync(file, "utf8").split("\n").filter((l) => l.trim().length > 0))
    .map((line) => deserializeEvent(line))
    .sort((a, b) => a.observedAt - b.observedAt);
  console.log(`Loaded ${events.length} recorded event(s) from ${files.length} file(s).`);

  const db = getDb(dbUrl);
  const wallets = await getAllWallets(db);

  // Collect what the current decoder derives. Keyed by chain|txHash so a later confirmation
  // overwrites the earlier mempool guess (last-wins), matching the live persisted signal.
  const derivedByKey = new Map<string, ReprocessSignal>();
  let lastActivity = Date.now();
  const bus = new EventBus();
  const collect = (s: ReprocessSignal) => {
    derivedByKey.set(reprocessKey(s), s);
    lastActivity = Date.now();
  };
  bus.on("trade-signal", (signal) => collect(toReprocessSignal(signal)));
  bus.on("signal-confirmed", ({ confirmed }) => collect(toReprocessSignal(confirmed)));

  const decoder = new Decoder({ bus, db, wallets: wallets.map((w) => ({ address: w.address, id: w.id, chain: w.chain })) });
  decoder.start();

  for (const event of events) {
    bus.emit("raw-tx", event);
  }

  // Wait for async decode (incl. RPC) to settle.
  const start = Date.now();
  while (Date.now() - lastActivity < QUIET_MS && Date.now() - start < MAX_WAIT_MS) {
    await new Promise<void>((r) => setTimeout(r, 250));
  }
  decoder.stop();

  // Only compare stored signals for txs that appear in the recordings, so unrelated history
  // doesn't masquerade as "missing-derived".
  const recordedKeys = new Set(events.map((e) => reprocessKey({ chain: e.chain as ChainId, txHash: e.txHash })));
  const storedAll = await getRecentSignals(db, new Date(0), 1_000_000);
  const stored = storedAll
    .map(toReprocessSignal)
    .filter((s) => recordedKeys.has(reprocessKey(s)));

  const report = summarizeReprocess(stored, [...derivedByKey.values()]);
  const { summary } = report;

  console.log("\nReprocess summary");
  console.log(`  stored (in recordings): ${summary.stored}`);
  console.log(`  derived now:            ${summary.derived}`);
  console.log(`  changed:                ${summary.changed}`);
  console.log(`    status changes:       ${summary.statusChanges}`);
  console.log(`    side changes:         ${summary.sideChanges}`);
  console.log(`    copy-token gained:    ${summary.copyTokenAddressImprovements}`);
  console.log(`    newly derived:        ${summary.newlyDerived}`);
  console.log(`    no longer derived:    ${summary.missingDerived}`);

  if (report.changes.length > 0) {
    console.log("\nChanges:");
    for (const c of report.changes.slice(0, MAX_PRINTED_CHANGES)) {
      const detail = c.kinds
        .map((kind) => {
          if (kind === "status") return `status ${c.storedStatus} -> ${c.derivedStatus}`;
          if (kind === "side") return `side ${c.storedSide} -> ${c.derivedSide}`;
          if (kind === "copy-token-address") return `copy-token ${c.storedCopyTokenAddress || "(none)"} -> ${c.derivedCopyTokenAddress}`;
          return kind;
        })
        .join(", ");
      console.log(`  ${c.chain} ${c.txHash}  [${detail}]`);
    }
    if (report.changes.length > MAX_PRINTED_CHANGES) {
      console.log(`  …and ${report.changes.length - MAX_PRINTED_CHANGES} more.`);
    }
  } else {
    console.log("\nNo differences — the current decoder reproduces every stored signal.");
  }

  await closeDb();
}

function loadLocalEnv(path: string): void {
  if (!existsSync(path)) return;
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    if (process.env[key] !== undefined) continue;
    const rawValue = trimmed.slice(separator + 1).trim();
    process.env[key] = rawValue.replace(/^['"]|['"]$/g, "");
  }
}

main().catch(async (err: unknown) => {
  console.error(err);
  await closeDb();
  process.exit(1);
});
