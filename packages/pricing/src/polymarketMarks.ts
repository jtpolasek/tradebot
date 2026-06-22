import { createLogger } from "@tradebot/core";
import type { ChainId } from "@tradebot/core";
import type { Db } from "@tradebot/store";
import { getOpenPositionTokens, insertPriceMark } from "@tradebot/store";
import { getPolymarketPrice } from "./polymarket.js";

const logger = createLogger("pricing:polymarket-marks");

const POLYMARKET_MARKS_INTERVAL_MS = 60_000;

type MarkListener = (mark: { chain: ChainId; tokenAddress: string; priceUsd: number; source: string }) => void;

export function startPolymarketMarksJob(
  db: Db,
  opts: { intervalMs?: number; onMark?: MarkListener } = {},
): { stop: () => void } {
  const intervalMs = opts.intervalMs ?? POLYMARKET_MARKS_INTERVAL_MS;
  let stopped = false;

  async function tick() {
    if (stopped) return;
    try {
      const tokens = await getOpenPositionTokens(db);
      const polygonTokens = tokens.filter((token) => token.chain === "polygon");
      if (polygonTokens.length === 0) return;

      const ts = new Date();
      for (const { chain, tokenAddress } of polygonTokens) {
        if (stopped) return;
        try {
          const quote = await getPolymarketPrice(tokenAddress, "sell");
          if (!quote) {
            logger.warn({ tokenAddress }, "No Polymarket quote for marks job — skipping");
            continue;
          }
          const priceUsd = (quote.bestBid + quote.bestAsk) / 2;
          if (!Number.isFinite(priceUsd) || priceUsd <= 0) {
            logger.warn({ tokenAddress, bestBid: quote.bestBid, bestAsk: quote.bestAsk }, "Invalid Polymarket midpoint for marks job — skipping");
            continue;
          }
          const source = "polymarket-clob-mid";
          await insertPriceMark(db, { chain, tokenAddress, ts, priceUsd, source });
          opts.onMark?.({ chain, tokenAddress, priceUsd, source });
          logger.debug({ chain, tokenAddress, priceUsd }, "polymarket mark persisted");
        } catch (err) {
          logger.warn({ err, chain, tokenAddress }, "polymarket marks job failed for token");
        }
      }
    } catch (err) {
      logger.error({ err }, "polymarket marks job tick failed");
    }
  }

  const handle = setInterval(() => { void tick(); }, intervalMs);
  void tick();

  return {
    stop() {
      stopped = true;
      clearInterval(handle);
    },
  };
}
