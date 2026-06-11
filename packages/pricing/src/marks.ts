import type { ChainId } from "@tradebot/core";
import { createLogger } from "@tradebot/core";
import type { Db } from "@tradebot/store";
import { getOpenPositionTokens, insertPriceMark } from "@tradebot/store";
import { getUsdPrice } from "./price.js";

const logger = createLogger("pricing:marks");

// Loose structural interface — avoids viem type-identity issues across pnpm packages
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RpcClient = { readContract: (args: any) => Promise<any> };

const MARKS_INTERVAL_MS = 60_000;

export function startMarksJob(
  db: Db,
  clients: Record<ChainId, RpcClient>
): { stop: () => void } {
  let stopped = false;

  async function tick() {
    if (stopped) return;
    try {
      const tokens = await getOpenPositionTokens(db);
      if (tokens.length === 0) return;

      const ts = new Date();
      await Promise.allSettled(
        tokens.map(async ({ chain, tokenAddress }) => {
          try {
            const price = await getUsdPrice(chain, tokenAddress, clients[chain]);
            if (price === null) {
              logger.warn({ chain, tokenAddress }, "No price for marks job — skipping");
              return;
            }
            await insertPriceMark(db, { chain, tokenAddress, ts, priceUsd: price, source: "pricing" });
            logger.debug({ chain, tokenAddress, price }, "mark persisted");
          } catch (err) {
            logger.warn({ err, chain, tokenAddress }, "marks job failed for token");
          }
        })
      );
    } catch (err) {
      logger.error({ err }, "marks job tick failed");
    }
  }

  const handle = setInterval(() => { void tick(); }, MARKS_INTERVAL_MS);

  // Run immediately on start
  void tick();

  return {
    stop() {
      stopped = true;
      clearInterval(handle);
    },
  };
}
