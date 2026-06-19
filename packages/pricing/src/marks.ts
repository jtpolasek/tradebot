import type { EvmChainId } from "@tradebot/core";
import { createLogger, isEvmChain } from "@tradebot/core";
import type { Db } from "@tradebot/store";
import { getOpenPositionTokens, getV4MarketHintForToken, insertPriceMark } from "@tradebot/store";
import { getUsdPriceResult } from "./price.js";

const logger = createLogger("pricing:marks");

// Loose structural interface — avoids viem type-identity issues across pnpm packages
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RpcClient = { readContract: (args: any) => Promise<any> };

const MARKS_INTERVAL_MS = 60_000;

export function startMarksJob(
  db: Db,
  clients: Record<EvmChainId, RpcClient>
): { stop: () => void } {
  let stopped = false;

  async function tick() {
    if (stopped) return;
    try {
      const tokens = await getOpenPositionTokens(db);
      if (tokens.length === 0) return;

      const ts = new Date();
      // Sequential on purpose: pricing a token can fan out to dozens of eth_calls, and
      // firing every token at once blows Alchemy's compute-units-per-second cap.
      for (const { chain, tokenAddress } of tokens) {
        if (stopped) return;
        // Marks are an EVM-AMM concern; non-EVM chains (Polymarket) have no open positions to price.
        if (!isEvmChain(chain)) continue;
        try {
          // V4-only tokens can't be discovered by pair; recover the poolId from a prior signal so
          // the position re-prices instead of being skipped as unpriceable.
          const hint = (await getV4MarketHintForToken(db, chain, tokenAddress)) ?? undefined;
          const price = await getUsdPriceResult(chain, tokenAddress, clients[chain], hint);
          if (price === null) {
            logger.warn({ chain, tokenAddress }, "No price for marks job — skipping");
            continue;
          }
          await insertPriceMark(db, { chain, tokenAddress, ts, priceUsd: price.priceUsd, source: price.source });
          logger.debug({ chain, tokenAddress, priceUsd: price.priceUsd, source: price.source }, "mark persisted");
        } catch (err) {
          logger.warn({ err, chain, tokenAddress }, "marks job failed for token");
        }
      }
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
