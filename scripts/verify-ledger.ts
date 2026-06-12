import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { fileURLToPath } from "url";
import { applyTradeToState } from "../packages/paper-engine/src/accounting.ts";
import type { AccountingPortfolio, AccountingPosition } from "../packages/paper-engine/src/accounting.ts";
import { closeDb, getDb } from "../packages/store/src/db.ts";
import { latestSnapshot } from "../packages/store/src/repositories/portfolioSnapshots.ts";
import type { ChainId } from "../packages/core/src/types.ts";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
loadLocalEnv(resolve(__dirname, "../.env"));

const dbUrl = process.env["DATABASE_URL"];
if (!dbUrl) throw new Error("DATABASE_URL not set");

const startingCashUsd = Number(process.env["PAPER_STARTING_CASH_USD"] ?? 100_000);
if (!Number.isFinite(startingCashUsd) || startingCashUsd <= 0) {
  throw new Error("PAPER_STARTING_CASH_USD must be a positive number when set.");
}

const EPSILON = 1e-6;
const POSITION_EPSILON = 1e-10;

type ReplayPosition = AccountingPosition & {
  chain: ChainId;
  tokenAddress: string;
  sourceWalletId: string | null;
};

type Mismatch = {
  key: string;
  field: string;
  expected: number | string | null;
  actual: number | string | null;
};

async function main() {
  const db = getDb(dbUrl);

  const [fills, signals] = await Promise.all([
    db.query.paperFills.findMany({
      where: (t, { eq }) => eq(t.decision, "copied"),
      orderBy: (t, { asc }) => [asc(t.decidedAt), asc(t.id)],
    }),
    db.query.tradeSignals.findMany(),
  ]);
  const signalsById = new Map(signals.map((signal) => [signal.id, signal]));

  const portfolio: AccountingPortfolio = {
    cashUsd: startingCashUsd,
    realizedPnlUsd: 0,
    feesPaidUsd: 0,
  };
  const replayPositions = new Map<string, ReplayPosition>();
  let skippedVoided = 0;

  for (const fill of fills) {
    if (fill.voided) {
      skippedVoided += 1;
      continue;
    }

    const signal = signalsById.get(fill.signalId);
    if (!signal) {
      throw new Error(`Fill ${fill.id} references missing signal ${fill.signalId}`);
    }

    const chain = signal.chain as ChainId;
    const tokenAddress = fill.tokenAddress.toLowerCase();
    const sourceWalletId = signal.walletId ?? null;
    const key = positionKey(chain, tokenAddress, sourceWalletId);
    const current = replayPositions.get(key) ?? null;
    const quantity = Number(fill.qty);
    const notionalUsd = Number(fill.notionalUsd);
    const feeUsd = Number(fill.feeUsd);

    const next = applyTradeToState({
      portfolio,
      position: current,
      trade: {
        side: fill.side as "buy" | "sell",
        quantity,
        notionalUsd,
        gasUsd: feeUsd,
        slippageUsd: 0,
        dexFeeUsd: 0,
        totalCostUsd: fill.side === "buy" ? notionalUsd + feeUsd : feeUsd,
        sellProceedsUsd: fill.side === "sell" ? Math.max(0, notionalUsd - feeUsd) : 0,
      },
    });

    portfolio.cashUsd = next.portfolio.cashUsd;
    portfolio.realizedPnlUsd = next.portfolio.realizedPnlUsd;
    portfolio.feesPaidUsd = next.portfolio.feesPaidUsd;

    if (next.position.quantity <= POSITION_EPSILON) {
      replayPositions.delete(key);
    } else {
      replayPositions.set(key, {
        ...next.position,
        chain,
        tokenAddress,
        sourceWalletId,
      });
    }
  }

  const dbPositions = await db.query.positions.findMany();
  const openDbPositions = dbPositions.filter((pos) => pos.closedAt === null);
  const mismatches: Mismatch[] = [];

  for (const expected of replayPositions.values()) {
    const key = positionKey(expected.chain, expected.tokenAddress, expected.sourceWalletId);
    const actual = openDbPositions.find((pos) =>
      positionKey(pos.chain as ChainId, pos.tokenAddress, pos.sourceWalletId ?? null) === key
    );

    if (!actual) {
      mismatches.push({ key, field: "position", expected: "open", actual: null });
      continue;
    }

    compareNumber(mismatches, key, "qty", expected.quantity, Number(actual.qty));
    compareNumber(mismatches, key, "avgCostUsd", expected.averageEntryUsd, Number(actual.avgCostUsd));
    compareNumber(mismatches, key, "realizedPnlUsd", expected.realizedPnlUsd, Number(actual.realizedPnlUsd));
  }

  for (const actual of openDbPositions) {
    const key = positionKey(actual.chain as ChainId, actual.tokenAddress, actual.sourceWalletId ?? null);
    if (!replayPositions.has(key) && Number(actual.qty) > POSITION_EPSILON) {
      mismatches.push({ key, field: "orphan-open-position", expected: null, actual: Number(actual.qty) });
    }
  }

  const snapshot = await latestSnapshot(db);
  if (snapshot) {
    const positionsValueUsd = Array.from(replayPositions.values())
      .reduce((sum, pos) => sum + pos.quantity * pos.averageEntryUsd, 0);
    compareNumber(mismatches, "latest-snapshot", "cashUsd", portfolio.cashUsd, snapshot.cashUsd);
    compareNumber(mismatches, "latest-snapshot", "positionsValueUsd", positionsValueUsd, snapshot.positionsValueUsd);
    compareNumber(mismatches, "latest-snapshot", "equityUsd", portfolio.cashUsd + positionsValueUsd, snapshot.equityUsd);
    compareNumber(mismatches, "latest-snapshot", "dailyPnlUsd", portfolio.realizedPnlUsd, snapshot.dailyPnlUsd);
  }

  console.log(`Copied fills replayed: ${fills.length - skippedVoided}`);
  console.log(`Voided copied fills skipped: ${skippedVoided}`);
  console.log(`Open positions: replay=${replayPositions.size}, db=${openDbPositions.length}`);

  if (mismatches.length > 0) {
    console.error(`Ledger verification failed: ${mismatches.length} mismatch(es).`);
    for (const mismatch of mismatches.slice(0, 50)) {
      console.error(
        `  key=${mismatch.key} field=${mismatch.field} expected=${mismatch.expected} actual=${mismatch.actual}`
      );
    }
    process.exitCode = 1;
  } else {
    console.log("Ledger verification passed.");
  }

  await closeDb();
}

function compareNumber(
  mismatches: Mismatch[],
  key: string,
  field: string,
  expected: number,
  actual: number
): void {
  if (Math.abs(expected - actual) > EPSILON) {
    mismatches.push({ key, field, expected, actual });
  }
}

function positionKey(chain: ChainId, tokenAddress: string, sourceWalletId: string | null): string {
  return `${chain}:${tokenAddress.toLowerCase()}:${sourceWalletId ?? ""}`;
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
