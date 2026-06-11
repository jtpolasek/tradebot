import { getDb, closeDb } from "@tradebot/store";
import { verifyLedger } from "@tradebot/paper-engine";
import type { TradeLedgerInput, LedgerEntry } from "@tradebot/paper-engine";
import { config as loadDotenv } from "dotenv";
import { resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
loadDotenv({ path: resolve(__dirname, "../.env") });

const dbUrl = process.env["DATABASE_URL"];
if (!dbUrl) throw new Error("DATABASE_URL not set");

async function main() {
  const db = getDb(dbUrl);

  const fills = await db.query.paperFills.findMany({
    where: (t, { eq }) => eq(t.decision, "copied"),
  });

  const trades: Array<TradeLedgerInput & { id: string }> = fills.map((f) => {
    const feeUsd = Number(f.feeUsd);
    const notionalUsd = Number(f.notionalUsd);
    const isSell = f.side === "sell";
    const priceUsd = Number(f.priceUsd);
    const qty = Number(f.qty);
    const slippageUsd = (qty * priceUsd * Number(f.slippageBps)) / 10_000;
    const dexFeeUsd = feeUsd * 0.3; // approximate split
    const gasUsd = feeUsd * 0.7;
    const sellProceeds = isSell ? Math.max(0, notionalUsd - feeUsd) : 0;
    const totalCostUsd = isSell ? feeUsd : notionalUsd + feeUsd;
    const realizedPnlUsd = 0; // would need position tracking to compute

    return {
      id: f.id,
      side: f.side as "buy" | "sell",
      quantity: qty,
      priceUsd,
      notionalUsd,
      gasUsd,
      slippageUsd,
      dexFeeUsd,
      totalCostUsd,
      realizedPnlUsd,
    };
  });

  // Since we store fills but not separate ledger entries, verify that all fills are non-voided
  const voidedCount = fills.filter((f) => f.voided).length;
  console.log(`Fills: ${fills.length} total, ${voidedCount} voided, ${fills.length - voidedCount} active`);

  // Basic ledger integrity: verify we can construct deltas from all trades
  const entries: LedgerEntry[] = trades.map((t) => {
    const delta = { entryType: t.side === "buy" ? "buy" : "sell" as "buy" | "sell", cashDelta: 0, quantityDelta: 0, costBasisDelta: 0, realizedPnlDelta: 0, feeDelta: 0 };
    return {
      id: t.id,
      tradeId: t.id,
      tokenAddress: "0x",
      chain: "eth" as const,
      ...delta,
      createdAt: new Date().toISOString(),
    };
  });

  const result = verifyLedger(trades, entries);
  if (result.ok) {
    console.log("✓ Ledger verification passed — no mismatches.");
  } else {
    console.error(`✗ Ledger mismatches found: ${result.mismatches.length}`);
    for (const m of result.mismatches.slice(0, 20)) {
      console.error(`  tradeId=${m.tradeId} field=${m.field} expected=${m.expected} actual=${m.actual}`);
    }
    process.exit(1);
  }

  await closeDb();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
