#!/usr/bin/env node
// Summarize the RSS trend across a soak-monitor.log (PLAN §10). Reads the JSONL
// produced by soak-probe.sh and prints min/max/first/last/mean RSS, a least-squares
// slope in MB/hour, run duration, and counts of unreachable/degraded/down samples.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const logPath = process.argv[2] ?? join(root, "recordings", "soak-monitor.log");
const SOFT_LIMIT_MB = 1536;

let raw;
try {
  raw = await readFile(logPath, "utf8");
} catch {
  console.log(`No soak log at ${logPath} yet — nothing to summarize.`);
  process.exit(0);
}

const rows = raw
  .split("\n")
  .map((l) => l.trim())
  .filter(Boolean)
  .map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  })
  .filter(Boolean);

const total = rows.length;
const unreachable = rows.filter((r) => r.healthCode === 0 || r.status == null).length;
const degraded = rows.filter((r) => r.status === "degraded").length;
const down = rows.filter((r) => r.status === "down").length;

// RSS series: valid samples with a numeric rssMb and a parseable ts.
const pts = rows
  .filter((r) => typeof r.rssMb === "number" && Number.isFinite(r.rssMb) && r.ts)
  .map((r) => ({ t: Date.parse(r.ts), rss: r.rssMb }))
  .filter((p) => Number.isFinite(p.t))
  .sort((a, b) => a.t - b.t);

if (pts.length === 0) {
  console.log(`Soak trend: ${total} samples, ${unreachable} unreachable — no RSS data points yet.`);
  process.exit(0);
}

const rssVals = pts.map((p) => p.rss);
const min = Math.min(...rssVals);
const max = Math.max(...rssVals);
const first = pts[0].rss;
const last = pts[pts.length - 1].rss;
const mean = rssVals.reduce((a, b) => a + b, 0) / rssVals.length;
const durationH = (pts[pts.length - 1].t - pts[0].t) / 3_600_000;

// Least-squares slope of rss vs hours-since-start.
let slopeMbPerH = 0;
if (pts.length >= 2 && durationH > 0) {
  const t0 = pts[0].t;
  const xs = pts.map((p) => (p.t - t0) / 3_600_000);
  const xMean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const yMean = mean;
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - xMean) * (rssVals[i] - yMean);
    den += (xs[i] - xMean) ** 2;
  }
  slopeMbPerH = den === 0 ? 0 : num / den;
}

// Verdict: flag a sustained climb that would reach the soft limit within the run horizon.
const headroomMb = SOFT_LIMIT_MB - last;
const hoursToLimit = slopeMbPerH > 0.5 ? headroomMb / slopeMbPerH : Infinity;
let verdict;
if (slopeMbPerH > 2 && hoursToLimit < 72) {
  verdict = `⚠️ RISING ${slopeMbPerH.toFixed(1)} MB/h → would hit ${SOFT_LIMIT_MB}MB in ~${hoursToLimit.toFixed(0)}h (possible leak)`;
} else if (slopeMbPerH > 0.5) {
  verdict = `mild drift +${slopeMbPerH.toFixed(2)} MB/h (headroom ${headroomMb}MB, not a near-term concern)`;
} else {
  verdict = `flat (${slopeMbPerH >= 0 ? "+" : ""}${slopeMbPerH.toFixed(2)} MB/h)`;
}

const fmtH = durationH >= 1 ? `${durationH.toFixed(1)}h` : `${(durationH * 60).toFixed(0)}m`;
console.log(
  `Soak RSS trend over ${fmtH} (${pts.length} RSS samples, ${total} total):\n` +
    `  RSS  first=${first} last=${last} min=${min} max=${max} mean=${mean.toFixed(0)} MB (limit ${SOFT_LIMIT_MB})\n` +
    `  slope ${verdict}\n` +
    `  health: ${unreachable} unreachable, ${degraded} degraded, ${down} down`,
);
